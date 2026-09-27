/**
 * Where the catalogue is read from: R2 snapshots first, Redis as the fallback.
 *
 * Order (ADR-0030): `catalogue/meta.json` on R2 names the live generation; the
 * bulk objects of that one generation follow. On any miss, malformed object or
 * timeout the read falls through to the Redis path (redis.ts), which is unchanged.
 * The browser never calls the database directly, so Redis is the last resort and a
 * failure of both is the existing "couldn't load channels" state.
 *
 * One generation per load: a load resolves its meta once and uses that generation
 * throughout. When R2 fails part-way the whole load restarts from Redis's own meta
 * rather than mixing objects, and the generation actually loaded is reported back
 * so schedules are read from the same one.
 */

import * as redis from './redis'
import * as r2 from './r2'
import type { R2Meta } from './r2Contract'
import { isSnapshotChannelId } from './r2Contract'
import type { Category, Channel, EpgProgram, Stream } from './types'

export type CatalogueSource = 'r2' | 'redis'

/** The generation a read resolved, with what its store needs to read it. Plain data, safe to post to a worker. */
export type CatalogueGeneration =
  | { source: 'r2'; generation: number; r2: R2Meta }
  | { source: 'redis'; generation: number; redis: redis.CatalogueGeneration }

export interface Catalogue {
  generation: number
  source: CatalogueSource
  channels: Channel[]
  streams: Stream[]
  categories: Category[]
}

/**
 * R2 named a generation it could not serve, but Redis's own generation is the one
 * the caller already holds, so there is nothing to download.
 */
export interface UnchangedCatalogue {
  unchanged: true
  generation: number
  source: CatalogueSource
}

/** True when at least one store is configured. */
export const isCatalogueSourceConfigured = r2.isR2Configured || redis.isUpstashConfigured

/** The generation, and store, that schedule reads of this JS context follow. */
let _pin: { generation: number; source: CatalogueSource } | null = null
let _metaInflight: Promise<CatalogueGeneration | null> | null = null

/** Records where schedules should be read from. The main thread calls this with what its worker loaded. */
export function pinGeneration(pin: { generation: number; source: CatalogueSource }) {
  _pin = { generation: pin.generation, source: pin.source }
}

async function readMeta(): Promise<CatalogueGeneration | null> {
  const fromR2 = await r2.fetchR2Meta()
  if (fromR2) return { source: 'r2', generation: fromR2.generation, r2: fromR2 }

  const fromRedis = await redis.fetchCatalogueMeta()
  if (fromRedis) return { source: 'redis', generation: fromRedis.generation, redis: fromRedis }
  return null
}

/**
 * Names the live generation (one small request when R2 answers) and pins schedule
 * reads to it. Concurrent callers share one request: a screenful of schedule reads
 * starting at once must not each read the pointer first. Null when neither store
 * can name a generation.
 */
export function fetchCatalogueMeta(): Promise<CatalogueGeneration | null> {
  if (!isCatalogueSourceConfigured) return Promise.resolve(null)
  if (_metaInflight) return _metaInflight
  _metaInflight = readMeta()
    .then((meta) => {
      if (meta) pinGeneration(meta)
      return meta
    })
    .finally(() => { _metaInflight = null })
  return _metaInflight
}

/**
 * The current generation, from memory when this context already read it. `fresh`
 * re-reads the pointer, for long-lived tabs whose remembered value may predate a
 * newer publish.
 */
export async function resolveGeneration(fresh = false): Promise<number | null> {
  if (_pin && !fresh) return _pin.generation
  const meta = await fetchCatalogueMeta()
  return meta ? meta.generation : null
}

async function fromRedis(meta: redis.CatalogueGeneration): Promise<Catalogue | null> {
  const loaded = await redis.fetchCatalogueFromRedis(meta)
  if (!loaded) return null
  pinGeneration({ generation: loaded.generation, source: 'redis' })
  return { ...loaded, source: 'redis' }
}

/**
 * Downloads the catalogue of the generation `meta` names.
 *
 * From R2 when `meta` came from R2; if any of its objects fails, Redis is asked for
 * its own meta and the whole catalogue is read from that generation instead. The
 * result carries the generation it really is.
 *
 * `held` is the generation the caller already has. When R2 cannot serve the
 * generation it named and Redis's own generation is `held`, nothing is downloaded
 * (`UnchangedCatalogue`): otherwise an R2 generation that is unreadable (say its
 * objects were retired under a live meta) would re-download the whole catalogue
 * from Redis on every start.
 */
export async function fetchCatalogue(
  meta: CatalogueGeneration,
  held: number | null = null,
): Promise<Catalogue | UnchangedCatalogue | null> {
  if (meta.source === 'r2') {
    const loaded = await r2.fetchCatalogueFromR2(meta.r2)
    if (loaded) {
      pinGeneration({ generation: meta.generation, source: 'r2' })
      return { generation: meta.generation, source: 'r2', ...loaded }
    }
    const fallback = await redis.fetchCatalogueMeta()
    if (!fallback) return null
    if (held !== null && fallback.generation === held) {
      pinGeneration({ generation: held, source: 'redis' })
      return { unchanged: true, generation: held, source: 'redis' }
    }
    return fromRedis(fallback)
  }
  return fromRedis(meta.redis)
}

/** The pinned generation and store, resolving the pointer first when nothing is pinned. */
async function resolvePin(fresh: boolean) {
  if (!_pin || fresh) await fetchCatalogueMeta()
  return _pin
}

/**
 * Channel ids that have a schedule, for `generation` when given, otherwise for
 * whatever generation is currently pinned (`fresh` re-reads the pointer first).
 *
 * `_pin` is shared, module-level state: a concurrent load elsewhere can repin it
 * between a caller's own catalogue read and this call. Passing the caller's own
 * `generation` (as `fetchEpg` already requires) keeps the ids tied to the same
 * generation as the catalogue that caller is holding, instead of whatever the
 * pointer says right now.
 *
 * Null when the list could not be read (missing, unreachable or malformed), so
 * callers can tell "schedules unavailable" from a list that is legitimately empty.
 */
export async function fetchEpgIds(generation?: number, fresh = false): Promise<string[] | null> {
  let gen: number
  let source: CatalogueSource
  if (generation !== undefined) {
    gen = generation
    source = _pin && _pin.generation === generation ? _pin.source : 'r2'
  } else {
    const pin = await resolvePin(fresh)
    if (!pin) return null
    gen = pin.generation
    source = pin.source
  }
  if (source === 'r2') {
    const ids = await r2.fetchEpgIdsFromR2(gen)
    if (ids) return ids
  }
  return redis.fetchEpgIdsFromRedis(false, gen)
}

/**
 * One channel's schedule, read on demand and pinned to `generation` (the one the
 * caller keys its own storage by). R2 answers when the catalogue came from R2 and
 * the id has an object; a failed or missing object falls through to Redis for the
 * same generation.
 */
export async function fetchEpg(channelId: string, generation: number): Promise<EpgProgram[]> {
  const source = _pin && _pin.generation === generation ? _pin.source : 'r2'
  if (source === 'r2' && isSnapshotChannelId(channelId)) {
    const programs = await r2.fetchEpgFromR2(channelId, generation)
    if (programs) return programs
  }
  return redis.fetchEpgFromRedis(channelId, generation)
}
