/**
 * Resolution ranking helpers.
 *
 * The catalogue stores each candidate's resolution in `Stream.quality` as free
 * text ("4K", "FHD", "1080p", "HD", "720", "SD", "unknown", ...). Selection used
 * to ignore this field entirely and order candidates by protocol only, so a 360p
 * HTTPS candidate could win over a 1080p HTTPS candidate.
 *
 * These helpers give every candidate a comparable score so the highest resolution
 * stream is always chosen first.
 */

import type { Stream } from '../api/types'
import { withXtreamHlsTwins } from './streamKind'

/** Higher score wins. Unknown resolutions rank lowest so named ones always win. */
export function rankResolution(quality: string | null | undefined): number {
  if (!quality) return 0
  const q = quality.toLowerCase()

  if (q.includes('4k') || q.includes('2160') || q.includes('uhd')) return 4
  if (q.includes('1080') || q.includes('fhd') || q.includes('full hd')) return 3
  if (q.includes('720') || q.includes('hd')) return 2
  if (q.includes('576') || q.includes('480') || q.includes('360') || q.includes('sd')) return 1
  return 0
}

/** True when the resolution can be identified from the quality label. */
export function isKnownResolution(quality: string | null | undefined): boolean {
  return rankResolution(quality) > 0
}

/**
 * Higher is better. Keeps the existing preference for HTTPS and active status as
 * a tiebreaker so two candidates of equal resolution do not lose their ordering.
 */
function streamScore(stream: Stream): number {
  let score = rankResolution(stream.quality) * 10
  if (stream.url.startsWith('https://')) score += 2
  if (stream.status === 'active') score += 1
  return score
}

/**
 * Stable sort of candidates by descending resolution.
 *
 * Array.prototype.sort is stable in every supported engine, so candidates of the
 * same resolution retain the order the catalogue produced.
 */
export function sortStreamsByResolution(streams: Stream[]): Stream[] {
  return [...streams].sort((a, b) => streamScore(b) - streamScore(a))
}

/**
 * Resolves the preferred candidate order for a channel.
 *
 * The verified working stream stays at the front only when it is not beaten by a
 * higher resolution candidate, so returning to a channel keeps the fast start
 * without pinning a low-resolution stream forever.
 */
export function orderStreamsForPlayback(
  streams: Stream[],
  workingUrl?: string | null
): Stream[] {
  return withXtreamHlsTwins(orderCore(streams, workingUrl))
}

function orderCore(streams: Stream[], workingUrl?: string | null): Stream[] {
  if (streams.length <= 1) return streams

  const ordered = sortStreamsByResolution(streams)
  if (!workingUrl) return ordered

  const workingIdx = ordered.findIndex((s) => s.url === workingUrl)
  if (workingIdx <= 0) return ordered

  const working = ordered[workingIdx]
  const top = ordered[0]
  // A cached, proven-good stream wins only when nothing better is available.
  if (rankResolution(working.quality) >= rankResolution(top.quality)) {
    return [working, ...ordered.filter((_, i) => i !== workingIdx)]
  }
  return ordered
}
