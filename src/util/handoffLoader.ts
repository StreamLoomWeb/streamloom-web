import { XhrLoader } from 'hls.js'
import { MANIFEST_TIMEOUT_MS, takePrefetchedPlaylist, type PrefetchedPlaylist } from './playlistPrefetch'

/**
 * hls.js's own playlist loader, except that the first manifest request of a player
 * takes the playlist `prefetchPlaylist` fetched at the tap. A failed, stale or overdue
 * prefetch falls through to an ordinary request; retries never use it.
 */
export class HandoffLoader extends XhrLoader {
  private handoff: Promise<PrefetchedPlaylist | null> | null = null
  private handedOff: PrefetchedPlaylist | null = null

  protected loadInternal(): void {
    const context = this.context
    // LoaderContextType is an ambient const enum, which isolatedModules cannot read.
    const handoff = context && (context.type as string) === 'manifest' && !this.stats.retry
      ? takePrefetchedPlaylist(context.url)
      : undefined
    if (!handoff) return super.loadInternal()
    this.handoff = handoff
    const fallBack = () => {
      if (this.handoff !== handoff) return // aborted, destroyed or already settled
      this.handoff = null
      super.loadInternal()
    }
    // Every load must end: an overdue prefetch gives way to an ordinary request. The
    // timer is `requestTimeout`, which abort and destroy already clear.
    this.requestTimeout = self.setTimeout(fallBack, this.config?.loadPolicy.maxLoadTimeMs ?? MANIFEST_TIMEOUT_MS)
    handoff
      .then((hit) => {
        if (this.handoff !== handoff) return
        if (!hit) return fallBack()
        this.handoff = null
        self.clearTimeout(this.requestTimeout)
        const { callbacks, context, stats } = this
        if (!callbacks || !context) return
        this.handedOff = hit
        stats.loading.first = stats.loading.end = performance.now()
        stats.loaded = stats.total = hit.text.length
        callbacks.onSuccess({ url: hit.url, data: hit.text, code: hit.status }, stats, context, null)
      })
      .catch((error) => self.setTimeout(() => { throw error })) // surface it as XHR handlers would
  }

  protected abortInternal(): void {
    this.handoff = null
    super.abortInternal()
  }

  /** hls.js times live reloads from this; a handed-off playlist has aged since it arrived. */
  getCacheAge(): number | null {
    const hit = this.handedOff
    if (!hit) return super.getCacheAge()
    return hit.age + (performance.now() - hit.receivedAt) / 1000
  }
}
