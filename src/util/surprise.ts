/**
 * "Surprise me": one random live channel, leaning towards what this device has watched
 * before. Local only. The weighting is deliberately gentle (base 1 + category affinity +
 * a bonus for a stream already known to work) so it still surprises.
 */
import type { EnrichedChannel } from '../hooks/useChannels'
import { getCategoryWeights } from './watchHistory'
import { getWorkingMapSnapshot, isChannelHidden, isStreamBroken } from './stream'
import { hasRecentFailure } from './recentFailures'
import { isUnsupportedStreamUrl } from './streamKind'

/** A stream known to work outweighs a whole category affinity: a surprise should play. */
const WORKING_BONUS = 20
/** Extra lean towards a stream that worked within the last day. */
const RECENT_SUCCESS_BONUS = 5
const RECENT_SUCCESS_MS = 24 * 60 * 60 * 1000

function isPlayable(c: EnrichedChannel): boolean {
  if (!c.stream) return false
  const urls = c.streams?.length ? c.streams.map((s) => s.url) : [c.stream.url]
  return urls.some((u) => !isUnsupportedStreamUrl(u))
}

export function surpriseWeight(
  channel: Pick<EnrichedChannel, 'id' | 'categoryIds'>,
  weights: Record<string, number>,
  working: Record<string, unknown>,
  now = Date.now(),
): number {
  let affinity = 0
  for (const c of channel.categoryIds ?? []) affinity += Math.sqrt(weights[c] ?? 0)
  const rec = working[channel.id] as { timestamp?: number } | undefined
  let bonus = 0
  if (rec) {
    bonus = WORKING_BONUS
    if (typeof rec.timestamp === 'number' && now - rec.timestamp < RECENT_SUCCESS_MS) bonus += RECENT_SUCCESS_BONUS
  }
  return 1 + affinity + bonus
}

/**
 * The candidate pool. Hidden, unplayable-scheme and broken-marked channels are out whatever the
 * hide-broken setting says (this is internal only; nothing listed changes). Channels that failed
 * in the last 30 minutes are out unless nothing else remains.
 */
function surprisePool(channels: EnrichedChannel[], excludeId?: string, skip?: ReadonlySet<string>): EnrichedChannel[] {
  const base = channels.filter(
    (c) =>
      isPlayable(c) && c.id !== excludeId && !skip?.has(c.id) && !isChannelHidden(c.id) && !isStreamBroken(c.id),
  )
  const fresh = base.filter((c) => !hasRecentFailure(c.id))
  return fresh.length ? fresh : base
}

/** `rand` is injectable for tests; returns null when nothing is playable. `skip` = ids already rejected. */
export function pickSurprise(
  channels: EnrichedChannel[],
  excludeId?: string,
  rand: () => number = Math.random,
  skip?: ReadonlySet<string>,
): EnrichedChannel | null {
  const weights = getCategoryWeights()
  const working = getWorkingMapSnapshot()
  const pool = surprisePool(channels, excludeId, skip)
  if (!pool.length) return null
  const w = pool.map((c) => surpriseWeight(c, weights, working))
  let r = rand() * w.reduce((a, b) => a + b, 0)
  for (let i = 0; i < pool.length; i++) {
    r -= w[i]
    if (r <= 0) return pool[i]
  }
  return pool[pool.length - 1]
}

/** The most trustworthy fallback: the cached-working channel with the newest success. */
export function bestCachedWorking(
  channels: EnrichedChannel[],
  excludeId?: string,
  skip?: ReadonlySet<string>,
): EnrichedChannel | null {
  const working = getWorkingMapSnapshot()
  let best: EnrichedChannel | null = null
  let bestAt = -1
  for (const c of surprisePool(channels, excludeId, skip)) {
    const at = working[c.id]?.timestamp
    if (at !== undefined && at > bestAt) {
      best = c
      bestAt = at
    }
  }
  return best
}
