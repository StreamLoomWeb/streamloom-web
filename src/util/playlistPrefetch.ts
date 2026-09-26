/**
 * Starts a channel's playlist request at the tap instead of after the watch page renders.
 *
 * Between a tap and the player's first request sit the route change, the player's
 * render and hls.js's setup: about 100 ms on a desktop (measured), more on a TV. The
 * playlist is fetched in that gap and handed to the player's playlist loader
 * (`HandoffLoader`), which uses it in place of its own first request. Only direct
 * streams are fetched: a proxied one would cost a Function invocation that a missed
 * hand-off would pay twice. Nothing here imports hls.js, so the grid stays light.
 */

import type { EnrichedChannel } from '../hooks/useChannels'
import { anonymousPool, directStreamUrl } from './preconnect'

/** A live playlist older than this may have rolled past the segments it lists. */
const MAX_AGE_MS = 5000
/** The player's manifest timeout; the prefetch gives up at the same point. */
export const MANIFEST_TIMEOUT_MS = 10_000

export interface PrefetchedPlaylist {
  /** After redirects: relative segment URIs resolve against it. */
  url: string
  text: string
  status: number
  /** `performance.now()` when the body arrived. */
  receivedAt: number
  /** The response's `Age` header, in seconds (0 when absent). */
  age: number
}

interface Slot {
  url: string
  result: Promise<PrefetchedPlaylist | null>
  startedAt: number
}

let pending: Slot | null = null

/** Fetches the playlist the player will ask for first. Call it as the channel is opened. */
export function prefetchPlaylist(channel: EnrichedChannel) {
  // Media Source present means the player loads through hls.js; without it the URL goes
  // to the video element, which would not use this.
  if (!anonymousPool) return
  const url = directStreamUrl(channel)
  if (!url) return
  // A repeated key press or a double tap must not send the origin a burst.
  if (pending?.url === url && performance.now() - pending.startedAt < MAX_AGE_MS) return
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS)
  // Same request as hls.js's: credential-less, no custom headers (no preflight).
  const result = fetch(url, { credentials: 'omit', signal: controller.signal })
    .then(async (res) => {
      if (!res.ok || (res.headers.get('content-type') ?? '').includes('text/html')) return null
      const text = await res.text()
      const age = Number(res.headers.get('age'))
      return { url: res.url || url, text, status: res.status, receivedAt: performance.now(), age: age > 0 ? age : 0 }
    })
    .catch(() => null)
    .finally(() => clearTimeout(timer))
  pending = { url, result, startedAt: performance.now() }
}

/**
 * The playlist fetched for `url` at the tap, once; undefined when none was. Resolves to
 * null when that fetch failed or its result is too old, and the caller loads it itself.
 */
export function takePrefetchedPlaylist(url: string): Promise<PrefetchedPlaylist | null> | undefined {
  const slot = pending
  if (!slot || slot.url !== url) return undefined
  pending = null
  return slot.result.then((hit) => (hit && performance.now() - hit.receivedAt < MAX_AGE_MS ? hit : null))
}
