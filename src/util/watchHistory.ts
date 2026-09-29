/**
 * Local-only watch memory for "Surprise me" and the resume line. Nothing here leaves the
 * device: no identifier, no upload, no telemetry. Two small records:
 *  - `sl_cat_weights_v1`: how often each category id has been played (capped, decayed).
 *  - `sl_last_watch_v1`: the last channel played and when.
 */
import type { EnrichedChannel } from '../hooks/useChannels'

const WEIGHTS_KEY = 'sl_cat_weights_v1'
const LAST_KEY = 'sl_last_watch_v1'
/** Past this many tracked categories the smallest are dropped, so the record stays tiny. */
const MAX_CATEGORIES = 60
/** Counts are halved once any reaches this, so old habits fade and new ones can surface. */
const DECAY_AT = 200

export interface LastWatch {
  id: string
  t: number
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export function getCategoryWeights(): Record<string, number> {
  const w = readJson<Record<string, number>>(WEIGHTS_KEY, {})
  return w && typeof w === 'object' ? w : {}
}

/** Called when a channel actually plays (not merely opens). */
export function recordWatch(channel: Pick<EnrichedChannel, 'id' | 'categoryIds'>, now = Date.now()) {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({ id: channel.id, t: now } satisfies LastWatch))
    const w = getCategoryWeights()
    for (const c of channel.categoryIds ?? []) w[c] = (w[c] ?? 0) + 1
    if (Object.values(w).some((n) => n >= DECAY_AT)) {
      for (const k of Object.keys(w)) w[k] = Math.floor(w[k] / 2)
    }
    const entries = Object.entries(w).filter(([, n]) => n > 0)
    const kept = entries.length > MAX_CATEGORIES ? entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_CATEGORIES) : entries
    localStorage.setItem(WEIGHTS_KEY, JSON.stringify(Object.fromEntries(kept)))
  } catch {
    // storage full or blocked: the feature simply learns nothing
  }
}

export function getLastWatch(): LastWatch | null {
  const v = readJson<Partial<LastWatch> | null>(LAST_KEY, null)
  return v && typeof v.id === 'string' && typeof v.t === 'number' ? { id: v.id, t: v.t } : null
}
