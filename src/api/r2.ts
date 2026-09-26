/**
 * R2 snapshot client — read-only, plain HTTPS GETs (ADR-0030).
 *
 * The catalogue is published as immutable brotli objects behind a public CDN
 * hostname, so a read costs nothing per request and an unchanged generation costs
 * one small `meta.json` fetch. The browser decodes `Content-Encoding: br` itself,
 * so `res.json()` yields the rows directly.
 *
 * Every function resolves to null on any miss, malformed object or timeout so the
 * caller (catalogueSource.ts) can fall through to Redis. Nothing here throws.
 *
 * Requests carry no custom headers, so they are CORS "simple" requests and never
 * preflight; the bucket's CORS rule only has to allow the site's origin for GET.
 */

import type { EpgProgram } from './types'
import {
  bulkUrl,
  decodeCatalogue,
  decodeEpg,
  decodeEpgIds,
  decodeFastTrack,
  decodePicks,
  epgIdsUrl,
  epgUrl,
  fastTrackUrl,
  metaUrl,
  parseMeta,
  picksUrl,
} from './r2Contract'
import type { DecodedCatalogue, FastTrackEntry, PicksDocument, R2Meta } from './r2Contract'

/** The CDN hostname the snapshot is served from. A build-time setting; never hard-coded. */
const BASE_URL = (
  ((import.meta.env.VITE_CATALOGUE_R2_BASE_URL as string | undefined) ?? '').trim().replace(/\/+$/, '')
)

/** True when a usable snapshot base URL is configured (the build refuses to ship without one). */
export const isR2Configured = /^https?:\/\//i.test(BASE_URL)

if (BASE_URL && !isR2Configured) {
  console.warn('[catalogue] VITE_CATALOGUE_R2_BASE_URL must start with http:// or https://; R2 is disabled')
}

/** Ceiling on one object's transfer size; the real ones are a few hundred KB brotli. */
const MAX_BYTES = 8 * 1024 * 1024

/** Budgets before giving up on R2 and falling through to Redis. */
export const R2_META_BUDGET_MS = 5_000
export const R2_CATALOGUE_BUDGET_MS = 8_000
export const R2_EPG_BUDGET_MS = 6_000
export const R2_PICKS_BUDGET_MS = 4_000
export const R2_FAST_TRACK_BUDGET_MS = 4_000

/**
 * After a transport failure of `meta.json` or a bulk object R2 is skipped for this
 * long, so a dead CDN costs one timeout rather than one per request.
 *
 * A single schedule object failing does not trip it (one bad object says nothing
 * about the rest); EPG_TRIP_AFTER failures in a row do, so a CDN that dies
 * mid-session is still given up on after a few rows instead of one wait per row.
 */
const COOLDOWN_MS = 30_000
const EPG_TRIP_AFTER = 3
let downUntil = 0
let epgFailuresInARow = 0

const available = () => isR2Configured && Date.now() >= downUntil
const markDown = () => { downUntil = Date.now() + COOLDOWN_MS }

/** Reason a sibling request aborts its peers; not a transport failure of its own. */
const SIBLING = 'sibling-failed'

/**
 * GETs and JSON-decodes one object; null on any failure.
 *
 * A 4xx is a definite "not there" and is no transport failure; a network error,
 * timeout, 5xx or undecodable body is, and is reported through `onTransportFailure`.
 */
async function getJson(
  url: string,
  ctl: AbortController,
  onTransportFailure: () => void = markDown,
): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: ctl.signal })
    if (!res.ok) {
      if (res.status >= 500) onTransportFailure()
      return null
    }
    if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) return null
    return await res.json()
  } catch {
    // Aborted by a sibling that already failed (and said so): not a second failure.
    if (ctl.signal.aborted && ctl.signal.reason === SIBLING) return null
    onTransportFailure()
    return null
  }
}

/** Runs `fn` with an AbortController that fires after `ms`. */
async function withBudget<T>(ms: number, fn: (ctl: AbortController) => Promise<T | null>): Promise<T | null> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), ms)
  try {
    return await fn(ctl)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** True when the snapshot host is configured at all; the picks row needs to know before it asks. */
export const r2BaseUrl = (): string | null => (isR2Configured ? BASE_URL : null)

/**
 * The short cache ADR-0033 §7 asks for, in memory.
 *
 * It also makes the row cost one request per page load rather than one per mount:
 * `StrictMode` mounts every effect twice in development, and a second row (or a
 * remount on navigation) would otherwise re-read the object. A reload clears it,
 * so a save is still visible within a minute.
 */
const PICKS_MEMO_MS = 60_000
let picksMemo: { value: PicksDocument | null; until: number } | null = null
let picksInFlight: Promise<PicksDocument | null> | null = null

/**
 * `catalogue/picks.json`: the author's picks (ADR-0033). Null on any failure, so
 * the row renders nothing rather than a broken one.
 *
 * Generation-independent and small, so it is read on its own short cache rather
 * than with a generation. A failure here is deliberately *not* reported as a
 * transport failure: picks.json may simply never have been published, and one
 * missing optional object must not put the whole catalogue path into cooldown.
 */
export async function fetchPicksFromR2(): Promise<PicksDocument | null> {
  if (!available()) return null

  const now = Date.now()
  if (picksMemo && now < picksMemo.until) return picksMemo.value
  if (picksInFlight) return picksInFlight

  picksInFlight = withBudget(R2_PICKS_BUDGET_MS, async (ctl) =>
    decodePicks(await getJson(picksUrl(BASE_URL), ctl, () => {})),
  )
    .then((value) => {
      picksMemo = { value, until: Date.now() + PICKS_MEMO_MS }
      return value
    })
    .finally(() => {
      picksInFlight = null
    })

  return picksInFlight
}

/** Same short cache as picks.json — see [PICKS_MEMO_MS]. */
const FAST_TRACK_MEMO_MS = 60_000
let fastTrackMemo: { value: FastTrackEntry[] | null; until: number } | null = null
let fastTrackInFlight: Promise<FastTrackEntry[] | null> | null = null

/**
 * `catalogue/fast-track.json` (ADR-0043, WO-19): channels a save just pinned that a probe has
 * already found a real stream for. Null on any failure, same as [fetchPicksFromR2] and for the
 * same reason — this object may simply not exist yet, which is the common case.
 */
export async function fetchFastTrackFromR2(): Promise<FastTrackEntry[] | null> {
  if (!available()) return null

  const now = Date.now()
  if (fastTrackMemo && now < fastTrackMemo.until) return fastTrackMemo.value
  if (fastTrackInFlight) return fastTrackInFlight

  fastTrackInFlight = withBudget(R2_FAST_TRACK_BUDGET_MS, async (ctl) =>
    decodeFastTrack(await getJson(fastTrackUrl(BASE_URL), ctl, () => {})),
  )
    .then((value) => {
      fastTrackMemo = { value, until: Date.now() + FAST_TRACK_MEMO_MS }
      return value
    })
    .finally(() => {
      fastTrackInFlight = null
    })

  return fastTrackInFlight
}

/** `catalogue/meta.json`: which generation is live. One small GET. */
export async function fetchR2Meta(): Promise<R2Meta | null> {
  if (!available()) return null
  return withBudget(R2_META_BUDGET_MS, async (ctl) => parseMeta(await getJson(metaUrl(BASE_URL), ctl)))
}

/**
 * The bulk objects of the generation `meta` names (three requests, in parallel).
 *
 * Every URL is built from `meta.generation`, so the objects cannot come from two
 * generations. The first failure aborts the others.
 */
export async function fetchCatalogueFromR2(meta: R2Meta): Promise<DecodedCatalogue | null> {
  if (!available()) return null
  return withBudget(R2_CATALOGUE_BUDGET_MS, async (ctl) => {
    const get = async (name: 'channels' | 'streams' | 'categories') => {
      const value = await getJson(bulkUrl(BASE_URL, meta.generation, name), ctl)
      if (value === null) ctl.abort(SIBLING)
      return value
    }
    const [channels, streams, categories] = await Promise.all([
      get('channels'),
      get('streams'),
      get('categories'),
    ])
    return decodeCatalogue(meta, { channels, streams, categories })
  })
}

/** Channel ids that have a schedule in `generation`; null when unreadable. */
export async function fetchEpgIdsFromR2(generation: number): Promise<string[] | null> {
  if (!available()) return null
  return withBudget(R2_EPG_BUDGET_MS, async (ctl) => decodeEpgIds(await getJson(epgIdsUrl(BASE_URL, generation), ctl)))
}

/**
 * One channel's schedule from `generation`. Null (not an empty list) when it could
 * not be read, so the caller can tell "no such object" from "nothing scheduled".
 */
export async function fetchEpgFromR2(channelId: string, generation: number): Promise<EpgProgram[] | null> {
  if (!available()) return null
  const url = epgUrl(BASE_URL, generation, channelId)
  if (!url) return null
  return withBudget(R2_EPG_BUDGET_MS, async (ctl) => {
    const programs = decodeEpg(
      await getJson(url, ctl, () => {
        epgFailuresInARow += 1
        if (epgFailuresInARow >= EPG_TRIP_AFTER) markDown()
      }),
    )
    if (programs) epgFailuresInARow = 0
    return programs
  })
}
