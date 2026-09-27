/**
 * Upstash Redis REST client — read-only.
 *
 * This is the client's only data source. Supabase is never called from the
 * browser: the sync worker publishes the catalogue and EPG into Redis and the
 * app reads it back over the ADR-0015 scheme below.
 *
 * Key scheme (matches sync worker / mobile app):
 *   catalogue:meta                    -> { generation, version, pages }
 *   catalogue:g<N>:channels:page:<i>  -> Channel[]
 *   catalogue:g<N>:streams:page:<i>   -> Stream[]
 *   catalogue:g<N>:categories         -> Category[]
 *   catalogue:g<N>:epg:ids            -> string[]      (channels with schedules)
 *   catalogue:g<N>:epg:<channelId>    -> EpgProgram[]  (per-channel, on demand)
 *
 * Every read is one HTTPS GET. A miss returns null/empty so the caller can show
 * a retry state instead of silently falling back to another origin.
 */

import type { Category, Channel, EpgProgram, Stream } from './types'

const UPSTASH_URL = (
  import.meta.env.VITE_UPSTASH_REDIS_REST_URL ||
  import.meta.env.VITE_UPSTASH_REDIS_URL ||
  import.meta.env.UPSTASH_REDIS_REST_URL ||
  import.meta.env.UPSTASH_REDIS_URL
) as string | undefined

const UPSTASH_TOKEN = (
  import.meta.env.VITE_UPSTASH_REDIS_REST_READONLY_TOKEN ||
  import.meta.env.VITE_UPSTASH_REDIS_READONLY_TOKEN ||
  import.meta.env.UPSTASH_REDIS_REST_READONLY_TOKEN ||
  import.meta.env.UPSTASH_REDIS_READONLY_TOKEN
) as string | undefined

/** True when Upstash credentials are configured. */
export const isUpstashConfigured = Boolean(UPSTASH_URL && UPSTASH_TOKEN)

/** Maximum allowed response size (2 MB) — same ceiling as the mobile app. */
const MAX_BYTES = 2 * 1024 * 1024

/** Budget in ms for the whole catalogue read before giving up. */
export const CACHE_BUDGET_MS = 20_000

/**
 * Fetches a single key from Upstash Redis via REST GET.
 * Returns the string value or null on any miss/error.
 */
export async function redisGet(key: string): Promise<string | null> {
  if (!isUpstashConfigured) return null
  try {
    const url = UPSTASH_URL!.replace(/\/$/, '') + '/get/' + encodeURIComponent(key)
    const res = await fetch(url, {
      headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN! },
    })
    if (!res.ok) return null

    // Guard against oversized payloads
    const contentLength = Number(res.headers.get('content-length') ?? 0)
    if (contentLength > MAX_BYTES) return null

    const body = await res.json() as { result: string | null }
    return body.result ?? null
  } catch {
    return null
  }
}

// ---- Catalogue meta ----

/** Must match SUPPORTED_VERSION in the sync worker and mobile app. */
const SUPPORTED_VERSION = 2

interface CatalogueMeta {
  generation: number
  version: number
  pages: { channels: number; streams: number }
  syncedAt?: string
}

/** The generation pointer, plus the key prefix every key of that generation shares. */
export type CatalogueGeneration = CatalogueMeta & { prefix: string }

function prefixFor(generation: number): string {
  return 'catalogue:g' + generation
}

async function readMetaOnce(): Promise<CatalogueGeneration | null> {
  const raw = await redisGet('catalogue:meta')
  if (!raw) return null
  try {
    const meta: CatalogueMeta = JSON.parse(raw)
    if (meta.version !== SUPPORTED_VERSION || meta.generation < 0) return null
    return { ...meta, prefix: prefixFor(meta.generation) }
  } catch {
    return null
  }
}

/** Generation pointer of this JS context, remembered so EPG reads need no second `meta` read. */
let _prefix: string | null = null
let _generation: number | null = null
let _metaInflight: Promise<CatalogueGeneration | null> | null = null

/**
 * Reads `catalogue:meta` (one GET) and remembers the generation it names.
 *
 * Concurrent callers share one request: a screenful of schedule reads starting at
 * once must not each read the pointer first. Returns null when the pointer is
 * missing, unreadable or of an unsupported version.
 */
export function fetchCatalogueMeta(): Promise<CatalogueGeneration | null> {
  if (!isUpstashConfigured) return Promise.resolve(null)
  if (_metaInflight) return _metaInflight
  _metaInflight = readMetaOnce()
    .then((meta) => {
      if (meta) {
        _prefix = meta.prefix
        _generation = meta.generation
      }
      return meta
    })
    .finally(() => { _metaInflight = null })
  return _metaInflight
}

/**
 * The current generation, from memory when this context has already read it.
 * `fresh` re-reads the pointer, for long-lived tabs whose remembered value may
 * predate a newer publish.
 */
export async function resolveGeneration(fresh = false): Promise<number | null> {
  if (_generation !== null && !fresh) return _generation
  const meta = await fetchCatalogueMeta()
  return meta ? meta.generation : null
}

async function resolvePrefix(fresh = false): Promise<string | null> {
  if (_prefix && !fresh) return _prefix
  const meta = await fetchCatalogueMeta()
  return meta ? meta.prefix : null
}

/** Reads multiple pages of a resource concurrently and concatenates them. */
async function readPages<T>(prefix: string, resource: string, pageCount: number): Promise<T[] | null> {
  if (pageCount <= 0 || pageCount > 200) return null
  const pagePromises = Array.from({ length: pageCount }, async (_, i) => {
    const raw = await redisGet(prefix + ':' + resource + ':page:' + i)
    if (!raw) return null
    try {
      return JSON.parse(raw) as T[]
    } catch {
      return null
    }
  })
  const results = await Promise.all(pagePromises)
  if (results.some((r) => r === null)) return null
  return results.flat() as T[]
}

/** Reads a resource stored under a single key. */
async function readSingle<T>(prefix: string, resource: string): Promise<T[] | null> {
  const raw = await redisGet(prefix + ':' + resource)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T[]
  } catch {
    return null
  }
}

// ---- Public catalogue fetchers ----

export interface CatalogueFromRedis {
  generation: number
  channels: Channel[]
  streams: Stream[]
  categories: Category[]
}

/**
 * Loads the full catalogue from Upstash Redis within CACHE_BUDGET_MS.
 *
 * Pages are read concurrently, so wall time is the slowest single page rather
 * than the sum of every page. Returns null on any miss or budget expiry.
 *
 * `meta` is the generation the caller has already read (and compared against what
 * it holds); passing it avoids a second `catalogue:meta` GET and guarantees every
 * page comes from the generation that was checked.
 */
export async function fetchCatalogueFromRedis(
  known?: CatalogueGeneration,
): Promise<CatalogueFromRedis | null> {
  if (!isUpstashConfigured) return null

  return withBudget(async () => {
    const meta = known ?? (await fetchCatalogueMeta())
    if (!meta) return null

    const [channels, streams, categories] = await Promise.all([
      readPages<Channel>(meta.prefix, 'channels', meta.pages.channels),
      readPages<Stream>(meta.prefix, 'streams', meta.pages.streams),
      readSingle<Category>(meta.prefix, 'categories'),
    ])

    if (!channels || !streams || !categories) return null

    _prefix = meta.prefix
    _generation = meta.generation
    return { generation: meta.generation, channels, streams, categories }
  })
}

/**
 * Channel ids that have schedule data, read from the current generation.
 *
 * Returns null when the list could not be read (missing, unreachable or
 * malformed), so callers can tell "schedules unavailable" apart from a
 * successful read that simply lists no channels. `fresh` re-reads the
 * generation pointer first, for long-lived tabs whose cached prefix may be stale.
 * `generation` pins the read to a generation the caller already chose (the one the
 * catalogue came from), so the list never comes from a different one.
 */
export async function fetchEpgIdsFromRedis(fresh = false, generation?: number): Promise<string[] | null> {
  const prefix = generation !== undefined ? prefixFor(generation) : await resolvePrefix(fresh)
  if (!prefix) return null
  const raw = await redisGet(prefix + ':epg:ids')
  if (!raw) return null
  try {
    const ids = JSON.parse(raw)
    return Array.isArray(ids) ? (ids as string[]) : null
  } catch {
    return null
  }
}

/**
 * Schedule for a single channel, read on demand.
 *
 * `generation` pins the read to the generation the caller keys its own storage
 * by; without it the current generation is used.
 */
export async function fetchEpgFromRedis(channelId: string, generation?: number): Promise<EpgProgram[]> {
  const prefix = generation !== undefined ? prefixFor(generation) : await resolvePrefix()
  if (!prefix) return []
  const raw = await redisGet(prefix + ':epg:' + channelId)
  if (!raw) return []
  try {
    const list = JSON.parse(raw)
    return Array.isArray(list) ? (list as EpgProgram[]) : []
  } catch {
    return []
  }
}

async function withBudget<T>(fn: () => Promise<T | null>): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), CACHE_BUDGET_MS)
    fn()
      .then((result) => { clearTimeout(timer); resolve(result) })
      .catch(() => { clearTimeout(timer); resolve(null) })
  })
}
