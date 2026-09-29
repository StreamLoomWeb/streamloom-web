/**
 * mpegts.js engine for raw MPEG-TS live streams (Xtream-style `/live/u/p/id.ts`, extensionless
 * TS). Loaded with a dynamic import so its chunk is requested only when such a stream is opened.
 */
export interface MpegtsCallbacks {
  /** Bytes are arriving (feeds the failover watchdog). */
  onMediaBytes: () => void
  /** The engine failed (init, network or demux). */
  onError: () => void
}

/** Starts playback; the returned function tears everything down and is safe to call at any time. */
export function startMpegtsEngine(video: HTMLVideoElement, url: string, cb: MpegtsCallbacks): () => void {
  let disposed = false
  let player: { destroy(): void; unload(): void; detachMediaElement(): void; pause(): void } | null = null

  void import('mpegts.js')
    .then((mod) => {
      if (disposed) return
      const mpegts = mod.default
      if (!mpegts.isSupported() || !mpegts.getFeatureList().mseLivePlayback) {
        cb.onError()
        return
      }
      const p = mpegts.createPlayer(
        { type: 'mpegts', isLive: true, url },
        {
          enableWorker: false,
          enableStashBuffer: false,
          liveBufferLatencyChasing: true,
          liveBufferLatencyMaxLatency: 6,
          liveBufferLatencyMinRemain: 1,
        },
      )
      player = p
      p.on(mpegts.Events.ERROR, () => {
        if (!disposed) cb.onError()
      })
      p.on(mpegts.Events.STATISTICS_INFO, () => {
        if (!disposed) cb.onMediaBytes()
      })
      p.on(mpegts.Events.LOADING_COMPLETE, () => {
        if (!disposed) cb.onMediaBytes()
      })
      p.attachMediaElement(video)
      p.load()
      const started = p.play()
      if (started && typeof (started as Promise<void>).catch === 'function') (started as Promise<void>).catch(() => {})
    })
    .catch(() => {
      if (!disposed) cb.onError()
    })

  return () => {
    disposed = true
    const p = player
    player = null
    if (!p) return
    try {
      p.pause()
      p.unload()
      p.detachMediaElement()
      p.destroy()
    } catch {
      /* already torn down */
    }
  }
}
