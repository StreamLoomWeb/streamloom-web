/**
 * `catalogue/active-channel-ids.json` (WO-21, backend PR #43) — the sorted ids of every channel
 * with at least one active stream in the live generation, written by the sync worker right after
 * `meta.json` goes live.
 *
 * Read through the same `CATALOGUE_BUCKET` binding `/api/picks` already has, not the public R2
 * base URL: the picker search runs at the edge, in the same isolate, and a binding read has no
 * network hop and nothing to be down. `GET /api/picks/channels?live=true` uses this to narrow
 * its iptv-org search to channels actually reachable right now.
 *
 * Never throws and never refuses a search: a missing binding, an absent object (nothing
 * published yet), or a malformed one all mean "cannot filter this time", and the caller falls
 * back to the unfiltered list — exactly the fallback the backend's own doc comment on
 * `publishActiveChannelIds` describes for its write side failing.
 */

import type { CatalogueBucket } from './catalogueBucket'

export const ACTIVE_CHANNEL_IDS_KEY = 'catalogue/active-channel-ids.json'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** The live ids as a Set, or null when they could not be read or parsed. */
export async function loadActiveChannelIds(bucket: CatalogueBucket): Promise<Set<string> | null> {
  let object
  try {
    object = await bucket.get(ACTIVE_CHANNEL_IDS_KEY)
  } catch {
    return null
  }
  if (!object) return null

  let parsed: unknown
  try {
    parsed = await object.json()
  } catch {
    return null
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.ids)) return null
  const ids = parsed.ids.filter((id): id is string => typeof id === 'string')
  return new Set(ids)
}
