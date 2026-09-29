/**
 * "Surprise me": one random live channel, leaning towards what this device has watched
 * before. Local only. The weighting is deliberately gentle (base 1 + category affinity +
 * a bonus for a stream already known to work) so it still surprises.
 */
import type { EnrichedChannel } from '../hooks/useChannels'
import { getCategoryWeights } from './watchHistory'
import { getWorkingMapSnapshot, isChannelHidden, isHideBrokenStreamsEnabled, isStreamBroken } from './stream'

const WORKING_BONUS = 3

export function surpriseWeight(
  channel: Pick<EnrichedChannel, 'id' | 'categoryIds'>,
  weights: Record<string, number>,
  working: Record<string, unknown>,
): number {
  let affinity = 0
  for (const c of channel.categoryIds ?? []) affinity += Math.sqrt(weights[c] ?? 0)
  return 1 + affinity + (working[channel.id] ? WORKING_BONUS : 0)
}

/** `rand` is injectable for tests; returns null when nothing is playable. */
export function pickSurprise(
  channels: EnrichedChannel[],
  excludeId?: string,
  rand: () => number = Math.random,
): EnrichedChannel | null {
  const weights = getCategoryWeights()
  const working = getWorkingMapSnapshot()
  const hideBroken = isHideBrokenStreamsEnabled()
  const pool = channels.filter(
    (c) => c.stream && c.id !== excludeId && !isChannelHidden(c.id) && !(hideBroken && isStreamBroken(c.id)),
  )
  if (!pool.length) return null
  const w = pool.map((c) => surpriseWeight(c, weights, working))
  let r = rand() * w.reduce((a, b) => a + b, 0)
  for (let i = 0; i < pool.length; i++) {
    r -= w[i]
    if (r <= 0) return pool[i]
  }
  return pool[pool.length - 1]
}
