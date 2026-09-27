/**
 * Playback events for one channel at a time (ADR-0047's CTA-2066 mapping):
 *
 *   play              when a channel starts loading, naming the first stream tried
 *   perf video_start_time  once, the time from that start to the first frame
 *   play_fail         when a stream fails for a *stream* reason (never the user's network), at
 *                     most once per stream per session — the counter it feeds is a probe trigger,
 *                     not a tally of retries
 *   play_end          when the channel is left, with the watch-time bucket (bucket 0 = EBVS)
 *   perf rebuffer_ratio    with play_end, stalled time over watched time, once the first frame was seen
 *
 * The player calls these from the places it already knows the facts; this module holds the
 * clock and the dedupe set and never throws back into it.
 */

import { ratioBucket, watchBucket, type ErrorClass } from '../../functions/api/_lib/telemetryContract'
import { streamKey } from './streamKey'
import { track, trackLatency } from './telemetry'

interface Session {
  channelId: string
  url: string
  startedAt: number
  firstFrameAt: number | null
  stalledMs: number
  stallStartedAt: number | null
}

let session: Session | null = null
/** Stream keys that already produced a `play_fail` this session (page lifetime). */
const failed = new Set<string>()

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/**
 * A channel starts loading. A no-op while a session for the same channel is open (a proxy retry
 * or the next candidate is the same play); a different channel ends the previous session first.
 */
export function beginPlay(channelId: string, url: string | undefined): void {
  try {
    if (session && session.channelId === channelId) return
    endPlay()
    if (!url) return
    session = { channelId, url, startedAt: now(), firstFrameAt: null, stalledMs: 0, stallStartedAt: null }
    void streamKey(url).then((s) => {
      if (s) track({ e: 'play', c: channelId, s })
    })
  } catch {
    // Never on a user path.
  }
}

/** The first frame rendered. Idempotent. */
export function markFirstFrame(): void {
  try {
    if (!session || session.firstFrameAt !== null) return
    session.firstFrameAt = now()
    trackLatency('video_start_time', session.firstFrameAt - session.startedAt)
  } catch {
    // Never on a user path.
  }
}

/** Playback stalled after the first frame. */
export function stallStart(): void {
  if (!session || session.firstFrameAt === null || session.stallStartedAt !== null) return
  session.stallStartedAt = now()
}

/** Playback resumed. */
export function stallEnd(): void {
  if (!session || session.stallStartedAt === null) return
  session.stalledMs += now() - session.stallStartedAt
  session.stallStartedAt = null
}

/**
 * A stream failed for a stream-specific reason. Sent once per stream per session, whatever the
 * player does next (retry, proxy, next candidate).
 */
export function failPlay(channelId: string, url: string | undefined, errorClass: ErrorClass): void {
  try {
    if (!url) return
    void streamKey(url).then((s) => {
      if (!s || failed.has(s)) return
      failed.add(s)
      track({ e: 'play_fail', c: channelId, s, k: errorClass })
    })
  } catch {
    // Never on a user path.
  }
}

/** The channel is left (switch, back, unmount). */
export function endPlay(): void {
  try {
    const s = session
    session = null
    if (!s) return
    stallEndOn(s)
    const watchedMs = s.firstFrameAt === null ? 0 : Math.max(0, now() - s.firstFrameAt)
    void streamKey(s.url).then((key) => {
      if (!key) return
      track({ e: 'play_end', c: s.channelId, s: key, d: watchBucket(watchedMs / 1000) })
    })
    if (s.firstFrameAt !== null && watchedMs > 0) {
      track({ e: 'perf', k: 'rebuffer_ratio', d: ratioBucket(Math.min(1, s.stalledMs / watchedMs)) })
    }
  } catch {
    // Never on a user path.
  }
}

function stallEndOn(s: Session): void {
  if (s.stallStartedAt === null) return
  s.stalledMs += now() - s.stallStartedAt
  s.stallStartedAt = null
}
