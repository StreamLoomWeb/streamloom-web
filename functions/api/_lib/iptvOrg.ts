/**
 * The public iptv-org channel list and blocklist, fetched and cached at the edge.
 *
 * The picker chooses from the whole upstream list, not from what is currently
 * published (ADR-0033 §1), so both the search endpoint and the save path need it.
 * It is ~7.9 MB of JSON (measured 2026-09-22), far too much to hand to the
 * browser on every keystroke, so it is fetched server-side, trimmed to the eight
 * fields the portal uses and held in the isolate.
 *
 * Fail closed: every function here returns null when the upstream data could not
 * be read, and the caller must turn that into a 503 with no write. Accepting a
 * save that could not be checked would be the one way a blocklisted or NSFW id
 * reaches `picks.json`, which ADR-0033 §4 exists to prevent.
 */

const CHANNELS_URL = 'https://iptv-org.github.io/api/channels.json'
const BLOCKLIST_URL = 'https://iptv-org.github.io/api/blocklist.json'

/** How long an index is reused without trying to refresh it. Upstream changes at most daily. */
const TTL_MS = 6 * 60 * 60 * 1000

/**
 * How stale a copy may get before it stops being usable at all.
 *
 * Past the TTL a stale copy is still preferred to refusing every save during an
 * upstream outage — but only for a bounded time. The blocklist is a takedown
 * list: an id added to it yesterday must not stay pinnable for a week because
 * this isolate happens to hold an old copy. After 24 hours the save fails closed
 * with 503 instead, which is loud, recoverable and never publishes something
 * upstream has since forbidden.
 */
const MAX_STALE_MS = 24 * 60 * 60 * 1000
/** Floor between fetch attempts after a failure, so an outage is not hammered. */
const MIN_RETRY_MS = 60 * 1000

const CHANNELS_MAX_BYTES = 32 * 1024 * 1024
const BLOCKLIST_MAX_BYTES = 4 * 1024 * 1024
const FETCH_TIMEOUT_MS = 20_000

/** The fields the portal shows or decides on. Everything else upstream is dropped. */
export interface IptvChannel {
  id: string
  name: string
  country: string | null
  categories: string[]
  /** iptv-org's own NSFW flag. Refused at save time. */
  nsfw: boolean
  /** Closing date, or null. Accepted with a warning. */
  closed: string | null
  /** Successor channel id, or null. Accepted with a warning. */
  replacedBy: string | null
  /** Blocklist reason (`dmca`, `nsfw`, ...) when the id is on `blocklist.json`; null otherwise. Refused at save time. */
  blocked: string | null
}

export interface IptvIndex {
  byId: Map<string, IptvChannel>
  all: IptvChannel[]
  fetchedAt: number
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

let cached: IptvIndex | null = null
let lastAttempt = 0
/** Concurrent requests share one fetch rather than each pulling 8 MB. */
let inFlight: Promise<IptvIndex | null> | null = null

/*
 * Test seams, absent in production. See the same block in accessJwt.ts: the
 * registry is created by e2e/support/testSeams.ts before this module is
 * evaluated, and by nothing in the deployed bundle, so no mutator of `cached`
 * is exported from here.
 */
{
  const seams = (globalThis as { __streamloomTestSeams?: Record<string, unknown> })
    .__streamloomTestSeams
  if (seams) {
    seams.resetIptvCache = () => {
      cached = null
      lastAttempt = 0
      inFlight = null
    }
    // Backdates the held copy and the retry floor, so the staleness rules can be
    // exercised without waiting hours.
    seams.ageIptvCache = (byMs: number) => {
      if (cached) cached.fetchedAt -= byMs
      lastAttempt -= byMs
    }
  }
}

async function getJson(url: string, maxBytes: number): Promise<unknown | null> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { accept: 'application/json' },
      cf: { cacheTtl: 3600, cacheEverything: true },
    } as RequestInit)
    if (!res.ok) return null
    if (Number(res.headers.get('content-length') ?? 0) > maxBytes) return null
    const text = await res.text()
    if (text.length > maxBytes) return null
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** `blocklist.json` -> channel id to reason. Null when it could not be read. */
async function loadBlocklist(): Promise<Map<string, string> | null> {
  const raw = await getJson(BLOCKLIST_URL, BLOCKLIST_MAX_BYTES)
  if (!Array.isArray(raw)) return null
  const out = new Map<string, string>()
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const channel = entry.channel
    if (typeof channel !== 'string' || channel.length === 0) continue
    const reason = typeof entry.reason === 'string' ? entry.reason : 'blocked'
    if (!out.has(channel)) out.set(channel, reason)
  }
  return out
}

async function build(): Promise<IptvIndex | null> {
  // Both or neither: a channel list without its blocklist cannot be used to
  // decide a save, because every id would look permitted.
  const [rawChannels, blocklist] = await Promise.all([
    getJson(CHANNELS_URL, CHANNELS_MAX_BYTES),
    loadBlocklist(),
  ])
  if (!Array.isArray(rawChannels) || rawChannels.length === 0 || !blocklist) return null

  const byId = new Map<string, IptvChannel>()
  const all: IptvChannel[] = []

  for (const raw of rawChannels) {
    if (!isRecord(raw)) continue
    const id = raw.id
    const name = raw.name
    if (typeof id !== 'string' || id.length === 0) continue
    if (typeof name !== 'string' || name.length === 0) continue
    if (byId.has(id)) continue

    const channel: IptvChannel = {
      id,
      name,
      country: typeof raw.country === 'string' ? raw.country : null,
      categories: Array.isArray(raw.categories)
        ? raw.categories.filter((c): c is string => typeof c === 'string')
        : [],
      // Anything other than an explicit `false` is treated as NSFW: a list that
      // stopped publishing the field must not silently un-flag every channel.
      nsfw: raw.is_nsfw !== false,
      closed: typeof raw.closed === 'string' ? raw.closed : null,
      replacedBy: typeof raw.replaced_by === 'string' ? raw.replaced_by : null,
      blocked: blocklist.get(id) ?? null,
    }
    byId.set(id, channel)
    all.push(channel)
  }

  if (byId.size === 0) return null
  return { byId, all, fetchedAt: Date.now() }
}

/** A copy older than this is treated as if it were not held at all. */
const usable = (index: IptvIndex | null, now: number): IptvIndex | null =>
  index && now - index.fetchedAt < MAX_STALE_MS ? index : null

/**
 * The index, from cache when it is fresh. Null when it could not be built and no
 * copy inside `MAX_STALE_MS` is held — the caller must then refuse the request.
 *
 * Within that window a stale copy is preferred to nothing: the blocklist changes
 * rarely and serving yesterday's is far better than refusing every save during an
 * upstream outage. Past it, refusing is the safer answer (see `MAX_STALE_MS`).
 */
export async function loadIptvIndex(): Promise<IptvIndex | null> {
  const now = Date.now()
  if (cached && now - cached.fetchedAt < TTL_MS) return cached
  if (inFlight) return inFlight
  if (now - lastAttempt < MIN_RETRY_MS) return usable(cached, now)

  lastAttempt = now
  inFlight = build()
    .then((built) => {
      if (built) cached = built
      return usable(cached, Date.now())
    })
    .catch(() => usable(cached, Date.now()))
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

/**
 * How old the copy `index` was built from is, in whole minutes.
 *
 * Reported to the author when a save was checked against a stale list, so a
 * warning that "this was checked against a list from 9 hours ago" is visible
 * rather than implied.
 */
export const indexAgeMinutes = (index: IptvIndex): number =>
  Math.max(0, Math.floor((Date.now() - index.fetchedAt) / 60_000))

/** True when `index` is past its refresh window and a save should say so. */
export const isIndexStale = (index: IptvIndex): boolean => Date.now() - index.fetchedAt >= TTL_MS

export type PickVerdict =
  | { verdict: 'ok'; channel: IptvChannel }
  | { verdict: 'warn'; channel: IptvChannel; warning: string }
  | { verdict: 'refuse'; reason: string }

/**
 * What iptv-org says about one pinned id (ADR-0033 §4).
 *
 * Refused: unknown to the list, on `blocklist.json`, or flagged `is_nsfw`.
 * Warned:  `closed`, or `replaced_by` another channel. Both are still published.
 */
export function judgeChannel(index: IptvIndex, channelId: string): PickVerdict {
  const channel = index.byId.get(channelId)
  if (!channel) return { verdict: 'refuse', reason: `"${channelId}" is not in the iptv-org channel list` }
  if (channel.blocked) {
    return { verdict: 'refuse', reason: `"${channelId}" is on the iptv-org blocklist (${channel.blocked})` }
  }
  if (channel.nsfw) {
    return { verdict: 'refuse', reason: `"${channelId}" is flagged is_nsfw by iptv-org` }
  }
  if (channel.replacedBy) {
    return {
      verdict: 'warn',
      channel,
      warning: `"${channelId}" was replaced by "${channel.replacedBy}" upstream; pinning it anyway`,
    }
  }
  if (channel.closed) {
    return {
      verdict: 'warn',
      channel,
      warning: `"${channelId}" is marked closed upstream (${channel.closed}); pinning it anyway`,
    }
  }
  return { verdict: 'ok', channel }
}

export interface SearchQuery {
  text?: string
  country?: string
  category?: string
  limit: number
  /**
   * When given, only channels in this set are matched at all — narrows to the live generation
   * (WO-21). Absent means unfiltered, the behaviour before this existed.
   */
  liveIds?: ReadonlySet<string>
}

export interface SearchResponse {
  total: number
  results: IptvChannel[]
}

/**
 * Substring search by name or id, narrowed by country and category.
 *
 * A linear pass over ~31K trimmed rows, which is a fraction of a millisecond and
 * needs no index to maintain or invalidate.
 */
export function searchChannels(index: IptvIndex, query: SearchQuery): SearchResponse {
  const text = query.text?.trim().toLowerCase() ?? ''
  const country = query.country?.trim().toUpperCase() ?? ''
  const category = query.category?.trim().toLowerCase() ?? ''

  const results: IptvChannel[] = []
  let total = 0

  for (const channel of index.all) {
    if (query.liveIds && !query.liveIds.has(channel.id)) continue
    if (country && channel.country !== country) continue
    if (category && !channel.categories.includes(category)) continue
    if (text && !channel.name.toLowerCase().includes(text) && !channel.id.toLowerCase().includes(text)) {
      continue
    }
    total += 1
    if (results.length < query.limit) results.push(channel)
  }

  // A name that starts with the query is almost always the one wanted; then
  // shortest name, which puts "BBC News" above "BBC News Arabic".
  if (text) {
    results.sort((a, b) => {
      const aStarts = a.name.toLowerCase().startsWith(text) ? 0 : 1
      const bStarts = b.name.toLowerCase().startsWith(text) ? 0 : 1
      if (aStarts !== bStarts) return aStarts - bStarts
      if (a.name.length !== b.name.length) return a.name.length - b.name.length
      return a.name.localeCompare(b.name)
    })
  }

  return { total, results }
}
