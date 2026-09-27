/**
 * The R2 snapshot contract (ADR-0030, ADR-0034 in streamloom-backend), with no I/O.
 *
 * Object layout, one directory per generation:
 *   catalogue/meta.json                       { generation, version, layout, counts, ... }
 *   catalogue/g<N>/channels.json.br           Channel[]
 *   catalogue/g<N>/streams.json.br            Stream[]
 *   catalogue/g<N>/categories.json.br         Category[]
 *   catalogue/g<N>/epg/ids.json.br            string[]      (channels with a schedule)
 *   catalogue/g<N>/epg/<channelId>.json.br    EpgProgram[]  (one channel, on demand)
 *
 * Everything here is pure so the golden fixture can be decoded in a plain Node test
 * through the same code the browser runs. The fetching lives in `r2.ts`.
 */

import type { Category, Channel, EpgProgram, Stream } from './types'

/** Shape of the rows; must match CATALOGUE_VERSION in the sync worker and the Redis path. */
export const SUPPORTED_VERSION = 2

/** Naming of the objects; must match R2_LAYOUT_VERSION in the sync worker. */
export const SUPPORTED_LAYOUT = 1

export interface R2Meta {
  generation: number
  version: number
  layout: number
  syncedAt?: string
  hash?: string
  guide?: boolean
  counts: {
    channels: number
    streams: number
    categories: number
    epgChannels: number
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

/**
 * A meta this client can read, or null.
 *
 * An unknown `version` (row shape) or `layout` (object naming) is refused rather than
 * guessed at, so a newer worker can never make an older client mis-read a generation.
 */
export function parseMeta(raw: unknown): R2Meta | null {
  if (!isRecord(raw)) return null
  if (raw.version !== SUPPORTED_VERSION || raw.layout !== SUPPORTED_LAYOUT) return null
  if (!isCount(raw.generation)) return null
  const counts = raw.counts
  if (!isRecord(counts)) return null
  if (
    !isCount(counts.channels) ||
    !isCount(counts.streams) ||
    !isCount(counts.categories) ||
    !isCount(counts.epgChannels)
  ) {
    return null
  }
  return {
    generation: raw.generation,
    version: raw.version,
    layout: raw.layout,
    syncedAt: typeof raw.syncedAt === 'string' ? raw.syncedAt : undefined,
    hash: typeof raw.hash === 'string' ? raw.hash : undefined,
    guide: typeof raw.guide === 'boolean' ? raw.guide : undefined,
    counts: {
      channels: counts.channels,
      streams: counts.streams,
      categories: counts.categories,
      epgChannels: counts.epgChannels,
    },
  }
}

// ---- Object URLs ----

export function metaUrl(base: string): string {
  return base + '/catalogue/meta.json'
}

/**
 * The author's picks (ADR-0033). Generation-independent, so it sits beside
 * `meta.json` rather than inside `catalogue/g<N>/`, and it is plain JSON: it is
 * a few kilobytes and is re-read far more often than a generation.
 */
export function picksUrl(base: string): string {
  return base + '/catalogue/picks.json'
}

/**
 * The fast-track bridge (ADR-0043, WO-19): channels a save just pinned that a narrow, probed
 * job has already found a real stream for, before the next scheduled sync publishes them for
 * real. Generation-independent and plain JSON, same as `picks.json`, and usually empty or tiny.
 */
export function fastTrackUrl(base: string): string {
  return base + '/catalogue/fast-track.json'
}

export type BulkObject = 'channels' | 'streams' | 'categories'

export function bulkUrl(base: string, generation: number, name: BulkObject): string {
  return base + '/catalogue/g' + generation + '/' + name + '.json.br'
}

export function epgIdsUrl(base: string, generation: number): string {
  return base + '/catalogue/g' + generation + '/epg/ids.json.br'
}

/**
 * True when a channel id can be an object key. Mirrors `r2ChannelSegment` in the
 * worker: a CDN percent-decodes the path before looking the key up, so an id with
 * `%`, `/`, `?` or a space has no URL that reaches what was stored. Such an id
 * keeps its guide in Redis only.
 */
export function isSnapshotChannelId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(id) && id !== 'ids'
}

/** URL of one channel's schedule; null for an id that has no object. */
export function epgUrl(base: string, generation: number, channelId: string): string | null {
  if (!isSnapshotChannelId(channelId)) return null
  return base + '/catalogue/g' + generation + '/epg/' + channelId + '.json.br'
}

// ---- Row decoding ----

function rows<T>(value: unknown, isRow: (row: unknown) => boolean): T[] | null {
  if (!Array.isArray(value)) return null
  for (const row of value) if (!isRow(row)) return null
  return value as T[]
}

const isChannel = (row: unknown): boolean =>
  isRecord(row) && typeof row.id === 'string' && typeof row.name === 'string'

const isStream = (row: unknown): boolean => isRecord(row) && typeof row.url === 'string'

const isCategory = (row: unknown): boolean =>
  isRecord(row) && typeof row.id === 'string' && typeof row.name === 'string'

const isProgram = (row: unknown): boolean =>
  isRecord(row) &&
  typeof row.title === 'string' &&
  typeof row.start_time === 'string' &&
  typeof row.end_time === 'string'

export const decodeChannels = (value: unknown): Channel[] | null => rows<Channel>(value, isChannel)
export const decodeStreams = (value: unknown): Stream[] | null => rows<Stream>(value, isStream)
export const decodeCategories = (value: unknown): Category[] | null => rows<Category>(value, isCategory)
export const decodeEpg = (value: unknown): EpgProgram[] | null => rows<EpgProgram>(value, isProgram)
export const decodeEpgIds = (value: unknown): string[] | null =>
  rows<string>(value, (row) => typeof row === 'string')

// ---- Author's picks ----

/** Schema of `picks.json`; must match PICKS_SCHEMA in functions/api/_lib/picksSchema.ts. */
export const PICKS_SCHEMA = 1

export interface PickItem {
  channelId: string
  note?: string
  rank?: number
  /**
   * The channel's iptv-org identity as of the save that pinned it (ADR-0042),
   * server-authored — never present unless the portal wrote it. Lets
   * `PicksRow` render a pin immediately, before the backend sync has ever
   * ingested or published the channel; absent on a document saved before this
   * field existed, or on an item the write path could not resolve, in which
   * case the row falls back to "pending" exactly as it always has.
   */
  name?: string
  country?: string | null
  categories?: string[]
}

export interface PickGroup {
  title: string
  items: PickItem[]
  /** How many items this group may hold, chosen by the admin when it was created. Absent means the portal's default. */
  limit?: number
}

export interface PicksDocument {
  schema: number
  updatedAt?: string
  groups: PickGroup[]
}

/**
 * A picks document this client understands, or null.
 *
 * Deliberately lenient about *extra* fields a future portal might add and strict
 * about the ones it reads: a row it cannot make sense of is dropped rather than
 * failing the whole document, because one bad pin should not remove the row. An
 * unknown `schema`, though, is refused outright — the meaning of the groups
 * would be a guess.
 */
export function decodePicks(raw: unknown): PicksDocument | null {
  if (!isRecord(raw)) return null
  if (raw.schema !== PICKS_SCHEMA) return null
  if (!Array.isArray(raw.groups)) return null

  const groups: PickGroup[] = []
  for (const rawGroup of raw.groups) {
    if (!isRecord(rawGroup)) continue
    if (typeof rawGroup.title !== 'string' || rawGroup.title.length === 0) continue
    if (!Array.isArray(rawGroup.items)) continue

    const items: PickItem[] = []
    for (const rawItem of rawGroup.items) {
      if (!isRecord(rawItem)) continue
      if (typeof rawItem.channelId !== 'string' || rawItem.channelId.length === 0) continue
      const item: PickItem = { channelId: rawItem.channelId }
      if (typeof rawItem.note === 'string' && rawItem.note.length > 0) item.note = rawItem.note
      if (typeof rawItem.rank === 'number' && Number.isFinite(rawItem.rank)) item.rank = rawItem.rank
      if (typeof rawItem.name === 'string' && rawItem.name.length > 0) item.name = rawItem.name
      if (rawItem.country === null || typeof rawItem.country === 'string') {
        item.country = rawItem.country
      }
      if (Array.isArray(rawItem.categories)) {
        const categories = rawItem.categories.filter((c): c is string => typeof c === 'string')
        if (categories.length > 0) item.categories = categories
      }
      items.push(item)
    }
    groups.push({ title: rawGroup.title, items })
  }

  return {
    schema: PICKS_SCHEMA,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
    groups,
  }
}

// ---- Fast-track (ADR-0043, WO-19) ----

export const FAST_TRACK_SCHEMA = 1

export interface FastTrackEntry {
  channelId: string
  name: string
  country: string | null
  categories: string[]
  stream: { url: string; quality: string | null }
  /**
   * The channel's icon, hosted the same way a live-generation channel's is (backend
   * `icons-lib.js`, WO-19 follow-up) — null when none could be fetched (a dead or slow
   * logo host, or the backend's icon credential unconfigured) or hasn't landed yet. A
   * fast-track entry is never held back waiting for one; the row renders the bundled
   * placeholder in the meantime, exactly like an ordinary channel with no logo.
   */
  icon: string | null
}

/**
 * A fast-track document this client understands, or null — same posture as [decodePicks]: an
 * entry it cannot make sense of is dropped, not the whole document, and an unrecognised schema
 * is refused outright rather than guessed at.
 */
export function decodeFastTrack(raw: unknown): FastTrackEntry[] | null {
  if (!isRecord(raw)) return null
  if (raw.schema !== FAST_TRACK_SCHEMA) return null
  if (!Array.isArray(raw.entries)) return null

  const entries: FastTrackEntry[] = []
  for (const rawEntry of raw.entries) {
    if (!isRecord(rawEntry)) continue
    if (typeof rawEntry.channelId !== 'string' || rawEntry.channelId.length === 0) continue
    if (typeof rawEntry.name !== 'string' || rawEntry.name.length === 0) continue
    if (!isRecord(rawEntry.stream) || typeof rawEntry.stream.url !== 'string' || rawEntry.stream.url.length === 0) continue
    entries.push({
      channelId: rawEntry.channelId,
      name: rawEntry.name,
      country: typeof rawEntry.country === 'string' ? rawEntry.country : null,
      categories: Array.isArray(rawEntry.categories) ? rawEntry.categories.filter((c): c is string => typeof c === 'string') : [],
      stream: {
        url: rawEntry.stream.url,
        quality: typeof rawEntry.stream.quality === 'string' ? rawEntry.stream.quality : null,
      },
      icon: typeof rawEntry.icon === 'string' && rawEntry.icon.length > 0 ? rawEntry.icon : null,
    })
  }
  return entries
}

/** Items in the order the row shows them: by `rank`, then by the author's order. */
export function orderPickItems(items: PickItem[]): PickItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const ar = a.item.rank ?? Number.MAX_SAFE_INTEGER
      const br = b.item.rank ?? Number.MAX_SAFE_INTEGER
      if (ar !== br) return ar - br
      return a.index - b.index
    })
    .map((entry) => entry.item)
}

export interface DecodedCatalogue {
  channels: Channel[]
  streams: Stream[]
  categories: Category[]
}

/**
 * The three bulk objects of one generation, checked against the `counts` its meta
 * declares. A count that disagrees means an object is truncated or belongs to a
 * different generation, and the whole load is refused (null) so the caller falls
 * through instead of showing half a catalogue.
 */
export function decodeCatalogue(
  meta: R2Meta,
  raw: { channels: unknown; streams: unknown; categories: unknown },
): DecodedCatalogue | null {
  const channels = decodeChannels(raw.channels)
  const streams = decodeStreams(raw.streams)
  const categories = decodeCategories(raw.categories)
  if (!channels || !streams || !categories) return null
  if (
    channels.length !== meta.counts.channels ||
    streams.length !== meta.counts.streams ||
    categories.length !== meta.counts.categories
  ) {
    return null
  }
  return { channels, streams, categories }
}
