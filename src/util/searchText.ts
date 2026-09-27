/**
 * Trigram inverted index for channel text search.
 *
 * Each channel's haystack (name + country code + country name, lower-cased and
 * diacritic-stripped via `normalizeSearch`) is shingled into overlapping
 * 3-character windows. A posting list maps every trigram to the channel ids
 * that contain it. A query is shingled the same way and resolved by intersecting
 * the smallest posting lists first and verifying the few survivors with an
 * exact `String.includes` check — so semantics match the previous behaviour
 * exactly (no false negatives, no fuzzy tolerance).
 *
 * Why not a Bloom filter: a Bloom answers "is this *exact* token in the set?"
 * with false positives, which does not match substring queries like "new s"
 * inside "News Channel". Trigrams do, deterministically, in O(trigrams) lookups
 * instead of O(N) scans.
 *
 * Why not just length-3 substring matching over the haystack: with thousands of
 * channels the linear scan dominates the keystroke budget. Trigrams turn a
 * query into a handful of `Map.get` calls plus an intersect over small arrays.
 *
 * Built once per catalogue generation in the catalogue worker (off the main
 * thread), shipped alongside the enriched channels, and held in module-level
 * state so search never pays the build cost during typing.
 */

import type { EnrichedChannel } from '../api/types'
import { getCountryName } from './country'

/** Minimal haystack length (chars) for which trigram matching is worthwhile. */
const TRIGRAM_MIN_QUERY = 3

/** Window size for shingles. */
const TRIGRAM_SIZE = 3

/** Default char budget for an intersected posting list before we fall back. */
const SHORT_LIST_THRESHOLD = 50

/**
 * The compiled index. Opaque to callers; built by `buildSearchIndex` and
 * consumed by `intersectMatches`.
 */
export interface SearchIndex {
  /** Total number of channels indexed (kept for stats and fallbacks). */
  size: number
  /** Pre-normalized haystacks, indexed by row. */
  haystacks: string[]
  /** Channel ids indexed by row (parallel to `haystacks`). */
  ids: string[]
  /** Maps channel id -> row index in `haystacks`/`ids`. */
  idToIndex: Map<string, number>
  /** Trigram -> sorted, deduplicated array of row indices. */
  postings: Map<string, number[]>
  /** Pre-sorted list of distinct trigrams, for cheap iteration. */
  trigrams: string[]
}

/**
 * Lowercases and strips diacritics so "espana" matches "España" and
 * "UNITED" matches "United".
 */
export function normalizeSearch(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

/**
 * Text this channel is matched against, normalized.
 *
 * Combines the channel name, country code and full country name so the same
 * query finds "CNN US", "CNN" picked under the 🇺🇸 United States filter, and
 * "espana" picking up Spain-locale names.
 */
export function searchHaystack(channel: EnrichedChannel): string {
  return normalizeSearch(
    `${channel.name} ${channel.country ?? ''} ${getCountryName(channel.country)}`,
  )
}

/**
 * Trigram shingles of `value`.
 *
 * No padding is added — for substring matching we want every length-3 window
 * that occurs in the string. A query of length 3 generates exactly one
 * trigram, and a haystack contains that trigram iff the haystack contains the
 * query as a substring. The same holds for any query length: the query is a
 * candidate match against a haystack iff the (query.length - 2) trigrams of
 * the query all appear in the haystack.
 */
function trigramsOf(value: string): string[] {
  if (value.length < TRIGRAM_SIZE) return []
  const out: string[] = []
  for (let i = 0; i <= value.length - TRIGRAM_SIZE; i += 1) {
    out.push(value.slice(i, i + TRIGRAM_SIZE))
  }
  return out
}

/**
 * Builds the inverted trigram index for `channels`. Pure function so it can
 * run inside the catalogue worker and on the main thread identically.
 */
export function buildSearchIndex(channels: readonly EnrichedChannel[]): SearchIndex {
  const haystacks = new Array<string>(channels.length)
  const ids = new Array<string>(channels.length)
  const idToIndex = new Map<string, number>()
  const postings = new Map<string, number[]>()

  for (let i = 0; i < channels.length; i += 1) {
    const ch = channels[i]
    idToIndex.set(ch.id, i)
    ids[i] = ch.id
    const hay = searchHaystack(ch)
    haystacks[i] = hay
    const seen = new Set<string>()
    for (const tg of trigramsOf(hay)) {
      if (seen.has(tg)) continue
      seen.add(tg)
      let list = postings.get(tg)
      if (!list) {
        list = []
        postings.set(tg, list)
      }
      list.push(i)
    }
  }

  return {
    size: channels.length,
    haystacks,
    ids,
    idToIndex,
    postings,
    trigrams: [...postings.keys()].sort(),
  }
}

/**
 * Resolves `normalizedQuery` to the matching channel **ids** using the index.
 *
 * Returns `null` for empty queries ("no search restriction" — callers must
 * walk the full list in that case), and falls back to a single linear scan
 * for queries shorter than `TRIGRAM_MIN_QUERY` (which would produce at most
 * one trigram and provide no pruning benefit).
 */
export function intersectMatches(index: SearchIndex, normalizedQuery: string): Set<string> | null {
  if (!normalizedQuery) return null
  if (index.size === 0) return new Set()
  if (normalizedQuery.length < TRIGRAM_MIN_QUERY) return scanAll(index, normalizedQuery)

  const queryTrigrams = trigramsOf(normalizedQuery)
  if (queryTrigrams.length === 0) return scanAll(index, normalizedQuery)

  // Gather posting lists for each query trigram. Missing trigrams mean no
  // matches at all (deterministic — no false positives, no false negatives).
  const lists: number[][] = []
  for (const tg of queryTrigrams) {
    const list = index.postings.get(tg)
    if (!list || list.length === 0) return new Set()
    lists.push(list)
  }

  // Process the smallest list first so the intersection stays tiny.
  lists.sort((a, b) => a.length - b.length)

  // Count occurrences across lists; a hit on every query trigram is a
  // candidate. Counts are held in a plain array (the candidate set is
  // bounded by the smallest posting list, typically tens of entries).
  const smallest = lists[0]
  const candidates: number[] = []
  for (let i = 0; i < smallest.length; i += 1) {
    const idx = smallest[i]
    let hits = 1
    for (let li = 1; li < lists.length; li += 1) {
      if (binaryIncludes(lists[li], idx)) hits += 1
    }
    if (hits === lists.length) candidates.push(idx)
  }

  // Verify exact substring on the small survivor set. Cheap, and keeps
  // semantics identical to the previous `haystack.includes(query)`.
  const verified = new Set<string>()
  for (const idx of candidates) {
    if (index.haystacks[idx].includes(normalizedQuery)) {
      verified.add(index.ids[idx])
    }
  }
  return verified
}

/**
 * Linear-scan fallback for short queries. Used when the query is shorter
 * than the trigram window or when the index is empty.
 */
function scanAll(index: SearchIndex, normalizedQuery: string): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i < index.haystacks.length; i += 1) {
    if (index.haystacks[i].includes(normalizedQuery)) {
      out.add(index.ids[i])
    }
  }
  return out
}

function binaryIncludes(sorted: number[], target: number): boolean {
  let lo = 0
  let hi = sorted.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const v = sorted[mid]
    if (v === target) return true
    if (v < target) lo = mid + 1
    else hi = mid - 1
  }
  return false
}

/**
 * True when the channel matches the search query.
 *
 * `normalizedQuery` must already have been passed through `normalizeSearch`.
 * When `matchSet` is supplied (the typical path from a UI that has already
 * resolved the query against the index), membership is O(1). Without a set
 * we fall back to the haystack scan — same semantics as before, but the
 * indexed path is what Home/Guide/Favourites use.
 */
export function matchesSearch(
  channel: EnrichedChannel,
  normalizedQuery: string,
  matchSet?: Set<string> | null,
): boolean {
  if (!normalizedQuery) return true
  if (matchSet) return matchSet.has(channel.id)
  return searchHaystack(channel).includes(normalizedQuery)
}

// ---- One index per catalogue ----

/*
 * Keyed by the catalogue array itself, so a match set can never be computed
 * against another generation's index: callers memoise on the same array they
 * pass in, and a superseded catalogue's index is collected with it.
 */
const _indexes = new WeakMap<readonly EnrichedChannel[], SearchIndex>()

/** Installs an index built elsewhere (the catalogue worker) for `catalogue`. */
export function setSearchIndex(catalogue: readonly EnrichedChannel[], index: SearchIndex): void {
  _indexes.set(catalogue, index)
}

/**
 * The index for `catalogue`, built on first use if nothing installed one. The
 * build is O(catalogue): pass the one unfiltered list, never a derived array,
 * or every new array builds (and keeps) an index of its own.
 */
export function searchIndexFor(catalogue: readonly EnrichedChannel[]): SearchIndex {
  let index = _indexes.get(catalogue)
  if (!index) {
    index = buildSearchIndex(catalogue)
    _indexes.set(catalogue, index)
  }
  return index
}

/**
 * Returns the ids in `catalogue` matching `normalizedQuery`, or `null` when the
 * query is empty (meaning "no restriction"). Always returns a `Set` (possibly
 * empty) for non-empty queries so callers can `has(id)` without null-checks.
 * `catalogue` is the full, unfiltered channel list (`useChannels().allChannels`).
 */
export function computeMatchSet(normalizedQuery: string, catalogue: readonly EnrichedChannel[]): Set<string> | null {
  if (!normalizedQuery) return null
  return intersectMatches(searchIndexFor(catalogue), normalizedQuery)
}

/** Re-exported for tests / diagnostics. */
export const SEARCH_SHORT_QUERY_THRESHOLD = SHORT_LIST_THRESHOLD
