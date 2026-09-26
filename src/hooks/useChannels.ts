import { useEffect, useState, useCallback, useMemo } from 'react'
import type { Category, EnrichedChannel, EpgProgram } from '../api/types'
import {
  fetchCatalogue,
  fetchCatalogueMeta,
  fetchEpgIds,
  isCatalogueSourceConfigured,
  pinGeneration,
} from '../api/catalogueSource'
import type { CatalogueGeneration, CatalogueSource } from '../api/catalogueSource'
import { loadSchedule } from '../util/scheduleLoader'
import { enrichChannels } from '../util/enrich'
import {
  searchIndexFor,
  setSearchIndex as installSearchIndex,
  type SearchIndex,
} from '../util/searchText'
import {
  clearStoredCatalogue,
  readStoredCatalogue,
  writeStoredCatalogue,
} from '../util/catalogueStore'
import type {
  CatalogueWorkerRequest,
  CatalogueWorkerResponse,
} from '../workers/catalogue.worker'
import {
  fetchEdgeVerifiedStreams,
  fetchKnownStreams,
  getBrokenSet,
  getHiddenSet,
  getWorkingMapSnapshot,
  isHideBrokenStreamsEnabled,
  onStreamStateChange,
  unmarkStreamBroken,
} from '../util/stream'

export type { EnrichedChannel }

interface UseChannelsResult {
  channels: EnrichedChannel[]
  allChannels: EnrichedChannel[]
  categories: Category[]
  epgChannelIds: Set<string>
  loading: boolean
  error: string | null
  refresh: () => void
  /** False when the schedule index could not be read; the Guide degrades instead of failing. */
  epgAvailable: boolean
  /** Re-reads only the schedule index (two small requests, not the whole catalogue). */
  refreshEpg: () => Promise<void>
  /** Where catalogue data was last loaded from */
  source: CatalogueSource | 'cache' | null
  /** Generation the held catalogue (`channels`, `epgChannelIds`) actually is; null before the first load. */
  generation: number | null
}

interface CatalogueLoad {
  /** True when the fallback store's generation is the one already held: nothing was downloaded. */
  unchanged?: boolean
  /** Generation the catalogue was read from. */
  generation: number
  /** Store it came from: R2, or Redis when R2 could not serve it. */
  source: CatalogueSource
  channels: EnrichedChannel[]
  categories: Category[]
  /** Null when the schedule index could not be read. */
  epgIds: string[] | null
  /** Optional prebuilt trigram index (worker path only). */
  searchIndex?: SearchIndex
}

// Module-level in-memory state (shared across all hook instances)
let _channels: EnrichedChannel[] | null = null
let _categories: Category[] | null = null
let _epgIds: Set<string> | null = null
let _epgAvailable = false
/** Generation of the catalogue held in `_channels`; null when unknown (e.g. a record from before generations were stored). */
let _generation: number | null = null
let _loading = true
let _error: string | null = null
let _source: CatalogueSource | 'cache' | null = null
const _listeners = new Set<() => void>()

function notify() {
  _listeners.forEach((fn) => fn())
}

onStreamStateChange(() => {
  notify()
})

/** Covers an R2 attempt (8 s) followed by the whole Redis path (20 s). */
const WORKER_TIMEOUT_MS = 35_000

/**
 * Runs the load inside a Web Worker so catalogue parsing and the ~40k-row join
 * stay off the main thread. Resolves undefined when no worker can be used, which
 * tells the caller to fall back to the main thread.
 */
function loadInWorker(meta: CatalogueGeneration): Promise<CatalogueLoad | null | undefined> {
  return new Promise((resolve) => {
    if (typeof Worker === 'undefined') {
      resolve(undefined)
      return
    }

    let worker: Worker
    try {
      worker = new Worker(new URL('../workers/catalogue.worker.ts', import.meta.url), {
        type: 'module',
      })
    } catch {
      resolve(undefined)
      return
    }

    let settled = false
    const finish = (value: CatalogueLoad | null | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.terminate()
      resolve(value)
    }

    const timer = setTimeout(() => finish(undefined), WORKER_TIMEOUT_MS)

    worker.onmessage = (event: MessageEvent<CatalogueWorkerResponse>) => {
      const data = event.data
      if (data && data.ok) {
        // The worker may have fallen back to Redis, so the generation and store it
        // reports are the ones the catalogue really is; schedules must follow them.
        pinGeneration({ generation: data.generation, source: data.source })
        finish({
          unchanged: data.unchanged,
          generation: data.generation,
          source: data.source,
          channels: data.channels,
          categories: data.categories,
          epgIds: data.epgIds,
          searchIndex: data.searchIndex,
        })
      } else {
        finish(null)
      }
    }
    worker.onerror = () => finish(undefined)

    const request: CatalogueWorkerRequest = { working: getWorkingMapSnapshot(), meta, held: _generation }
    worker.postMessage(request)
  })
}

/** Fallback for environments without workers: identical work, main thread. */
async function loadOnMainThread(meta: CatalogueGeneration): Promise<CatalogueLoad | null> {
  const catalogue = await fetchCatalogue(meta, _generation)
  if (!catalogue) return null
  if ('unchanged' in catalogue) {
    return {
      unchanged: true,
      generation: catalogue.generation,
      source: catalogue.source,
      channels: [],
      categories: [],
      epgIds: null,
    }
  }
  const epgIds = await fetchEpgIds(catalogue.generation)
  return {
    generation: catalogue.generation,
    source: catalogue.source,
    channels: enrichChannels(catalogue.channels, catalogue.streams, getWorkingMapSnapshot()),
    categories: catalogue.categories,
    epgIds,
  }
}

async function loadCatalogue(meta: CatalogueGeneration): Promise<CatalogueLoad | null> {
  const fromWorker = await loadInWorker(meta)
  if (fromWorker !== undefined) return fromWorker
  return loadOnMainThread(meta)
}

/** Applies a freshly loaded catalogue to the shared module state. */
function applyLoad(load: CatalogueLoad, source: CatalogueSource | 'cache') {
  _channels = load.channels
  _categories = load.categories
  _generation = load.generation
  if (load.epgIds) {
    _epgIds = new Set(load.epgIds)
    _epgAvailable = load.epgIds.length > 0
  } else {
    // The schedule index could not be read this time. Keep whatever was known
    // rather than replacing it with an empty set that looks like "no schedules".
    _epgAvailable = (_epgIds?.size ?? 0) > 0
  }
  _source = source
  _loading = false
  _error = null
  _retryAttempt = 0
  // The worker ships a ready index; the main-thread fallback builds one at idle.
  if (load.searchIndex) installSearchIndex(load.channels, load.searchIndex)
  else prebuildSearchIndex(load.channels)
}

/**
 * Builds the search index for `catalogue` once the page is idle, so the first
 * keystroke does not pay for it (a search typed sooner builds it on the spot).
 * Skipped if a newer generation replaced `catalogue` in the meantime.
 */
function prebuildSearchIndex(catalogue: EnrichedChannel[]) {
  const build = () => { if (_channels === catalogue) searchIndexFor(catalogue) }
  if (typeof requestIdleCallback === 'function') requestIdleCallback(build, { timeout: 2000 })
  else setTimeout(build, 0)
}

/** Shown when nothing can be loaded and there is no cached catalogue to fall back on. */
const LOAD_FAILED_MESSAGE =
  "We couldn't load channels right now. Check your connection and try again. We'll keep trying in the background."

/** Backoff between automatic retries while the catalogue is empty. */
const RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 300_000]
let _retryTimer: ReturnType<typeof setTimeout> | null = null
let _retryAttempt = 0

function cancelRetry() {
  if (_retryTimer) {
    clearTimeout(_retryTimer)
    _retryTimer = null
  }
}

function scheduleRetry() {
  if (_retryTimer) return
  const delay = RETRY_DELAYS_MS[Math.min(_retryAttempt, RETRY_DELAYS_MS.length - 1)]
  _retryAttempt += 1
  _retryTimer = setTimeout(() => {
    _retryTimer = null
    loadData(true).catch(() => {})
  }, delay)
}

/**
 * Records a failed load. The error only surfaces when there is nothing on
 * screen: a stale-but-working catalogue always beats an error page.
 */
function reportLoadFailure(detail: string) {
  console.warn('[catalogue] load failed:', detail)
  _loading = false
  if (!_channels || _channels.length === 0) {
    _error = LOAD_FAILED_MESSAGE
    scheduleRetry()
  }
  notify()
}

async function loadData(force = false) {
  if (!force && _channels) return
  cancelRetry()

  // Instant path: IndexedDB first. The generation check below then decides, with
  // one small read, whether anything needs downloading.
  if (!force) {
    const stored = await readStoredCatalogue()
    if (stored) {
      _channels = stored.channels
      _categories = stored.categories
      _epgIds = new Set(stored.epgIds)
      _epgAvailable = stored.epgIds.length > 0
      _generation = stored.generation
      _source = 'cache'
      _loading = false
      _error = null
      // The search index is built after the grid paints, not before: the trigram
      // build over every channel is main-thread work a return visit waited on.
      notify()
      prebuildSearchIndex(stored.channels)
      loadData(true).catch(() => {})
      return
    }
  }

  // Only surface the spinner when there is nothing on screen already. An error
  // that is already showing stays put during automatic retries, so the page
  // does not flicker between skeleton and error every few seconds.
  if ((!_channels || _channels.length === 0) && !_error) {
    _loading = true
    notify()
  }

  try {
    // One GET names the current generation. When it is the one already held, the
    // catalogue is identical to what a download would return and nothing is fetched.
    const meta = await fetchCatalogueMeta()

    if (!meta) {
      reportLoadFailure(
        isCatalogueSourceConfigured ? 'catalogue has not been published' : 'data source is not configured',
      )
      return
    }

    if (_channels && _channels.length > 0 && _generation === meta.generation) {
      await confirmUnchangedCatalogue()
      return
    }

    const load = await loadCatalogue(meta)

    if (!load) {
      reportLoadFailure(
        isCatalogueSourceConfigured ? 'catalogue has not been published' : 'data source is not configured',
      )
      return
    }

    if (load.unchanged) {
      // R2 named a generation it could not serve; Redis's is the one already held.
      await confirmUnchangedCatalogue()
      return
    }

    applyLoad(load, load.source)
    notify()

    writeStoredCatalogue({
      generation: load.generation,
      channels: load.channels,
      categories: load.categories,
      epgIds: load.epgIds ?? [...(_epgIds ?? [])],
    }).catch(() => {})
  } catch (e) {
    reportLoadFailure((e as Error).message)
  }
}

/**
 * Settles state after a check that found the held catalogue current.
 *
 * The schedule index belongs to the same generation, so it is only read again when
 * the held copy has none (an earlier read of it failed), which is worth one GET.
 */
async function confirmUnchangedCatalogue() {
  if ((_epgIds?.size ?? 0) === 0 && _generation !== null) {
    const ids = await fetchEpgIds(_generation)
    if (ids && ids.length > 0) {
      _epgIds = new Set(ids)
      _epgAvailable = true
    }
  }
  _loading = false
  _error = null
  _retryAttempt = 0
  notify()
}

let _epgRefresh: Promise<void> | null = null

/**
 * Re-reads just the schedule index and updates availability.
 *
 * Far cheaper than a full catalogue reload, so the Guide can retry on every
 * visit. Reads the generation pointer fresh, since a long-lived tab may hold a
 * prefix from before the sync worker published a newer generation.
 */
function refreshEpgIds(): Promise<void> {
  if (_epgRefresh) return _epgRefresh
  _epgRefresh = (async () => {
    const ids = await fetchEpgIds(undefined, true)
    if (ids && ids.length > 0) {
      _epgIds = new Set(ids)
      _epgAvailable = true
      notify()
    }
  })()
    .catch(() => {})
    .finally(() => { _epgRefresh = null })
  return _epgRefresh
}

// Kick off loading as soon as this module is first imported
loadData()

/**
 * How often the catalogue, schedules and dead-stream list are re-read.
 *
 * Four hours keeps a long-lived tab (a TV browser session can stay open all day)
 * within one refresh of the sync worker, without polling the store in the meantime.
 */
const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000

/** Drops cached schedules so the next refresh re-reads them. */
function invalidateEphemeralCaches() {
  _epgCache.clear()
}

let _refreshTimer: ReturnType<typeof setInterval> | null = null

/** Cap on channels re-probed per tick, so a large broken set cannot stall. */
const REVALIDATE_LIMIT = 50

/**
 * Re-probes channels marked dead and clears the ones that respond again.
 *
 * Streams die and recover on their own schedule, so a channel marked broken
 * earlier is not necessarily broken now. Candidate URLs come from the loaded
 * catalogue rather than the working-stream cache, which is what makes this work
 * for channels that were marked broken before a working stream was ever cached.
 *
 * Best-effort and bounded: a failure leaves the channel marked broken, and only
 * the first REVALIDATE_LIMIT channels are checked per tick.
 */
async function revalidateBrokenStreams() {
  if (!_channels) return
  const broken = [...getBrokenSet()]
  if (broken.length === 0) return

  const byId = new Map(_channels.map((c) => [c.id, c]))
  const targets = broken
    .map((id) => byId.get(id))
    .filter((c): c is EnrichedChannel => Boolean(c && c.streams.length > 0))
    .slice(0, REVALIDATE_LIMIT)

  for (const channel of targets) {
    try {
      // Cheap fast-path: any POP that has verified this channel within the
      // global R2 record's TTL wins. This avoids a per-channel probe when
      // the answer is already known globally.
      const known = await fetchKnownStreams(channel.id)
      if (known?.workingStream) {
        unmarkStreamBroken(channel.id)
        continue
      }

      // Fallback: live probe via the per-POP `/api/streams` endpoint, which
      // itself populates the global R2 record on success.
      const result = await fetchEdgeVerifiedStreams(
        channel.id,
        channel.streams.map((s) => s.url),
        channel.streams.map((s) => s.quality),
        5000,
      )
      if (result?.workingStream) unmarkStreamBroken(channel.id)
    } catch {
      // Leave the channel marked broken.
    }
  }
}

/**
 * Starts the periodic refresh.
 *
 * Guarded so the timer exists once per module load even though `useChannels` is
 * called from every page. Each tick re-reads the catalogue, clears the schedule
 * cache, and re-probes streams that were previously marked dead.
 */
function startRefreshLoop() {
  if (_refreshTimer) return
  _refreshTimer = setInterval(() => {
    invalidateEphemeralCaches()
    loadData(true).catch(() => {})
    revalidateBrokenStreams().catch(() => {})
  }, REFRESH_INTERVAL_MS)
}

startRefreshLoop()

/** Runs `fn` once, as soon as a catalogue is held (now, if one already is). */
export function afterCatalogue(fn: () => void): () => void {
  if (_channels) {
    fn()
    return () => {}
  }
  const check = () => {
    if (!_channels) return
    _listeners.delete(check)
    fn()
  }
  _listeners.add(check)
  return () => { _listeners.delete(check) }
}

const NO_CHANNELS: EnrichedChannel[] = []

export function useChannels(): UseChannelsResult {
  const [, setTick] = useState(0)

  useEffect(() => {
    const rerender = () => setTick((t) => t + 1)
    _listeners.add(rerender)
    return () => { _listeners.delete(rerender) }
  }, [])

  // Clearing the error first shows the loading skeleton, so a manual Retry gives feedback.
  const refresh = useCallback(() => {
    _error = null
    return loadData(true)
  }, [])
  const refreshEpg = useCallback(() => refreshEpgIds(), [])

  const raw = _channels ?? NO_CHANNELS
  const hideBroken = isHideBrokenStreamsEnabled()
  const brokenSet = hideBroken ? getBrokenSet() : null
  const hiddenSet = getHiddenSet()
  // Broken marks hide only while the setting is on; a channel the user hid stays hidden.
  // Memoised on the sets' identity so consumers' memos keep their cache between renders.
  const filtered = useMemo(
    () =>
      (brokenSet && brokenSet.size > 0) || hiddenSet.size > 0
        ? raw.filter((c) => !hiddenSet.has(c.id) && !brokenSet?.has(c.id))
        : raw,
    [raw, brokenSet, hiddenSet]
  )

  return {
    channels: filtered,
    allChannels: raw,
    categories: _categories ?? [],
    epgChannelIds: _epgIds ?? new Set(),
    loading: _loading,
    error: _error,
    refresh,
    epgAvailable: _epgAvailable,
    refreshEpg,
    source: _source,
    generation: _generation,
  }
}

/** Drops the persisted and in-memory catalogue. Used by Settings. */
export async function clearCatalogueCache() {
  await clearStoredCatalogue()
  _channels = null
  _categories = null
  _epgIds = null
  _epgAvailable = false
  _generation = null
  _source = null
}

// ---- Debug helpers ----
export function getDataSource() { return _source }
export function getUpstashConfigured() { return isCatalogueSourceConfigured }

// ---- EPG (read on demand, one object per channel) ----
const _epgCache = new Map<string, EpgProgram[]>()

export function useEpg(channelId: string | null) {
  const [fetchedPrograms, setFetchedPrograms] = useState<{ [id: string]: EpgProgram[] }>({})
  const [loading, setLoading] = useState(false)
  const [tick, setTick] = useState(0)

  const programs = channelId ? (_epgCache.get(channelId) ?? fetchedPrograms[channelId] ?? []) : []

  // `_generation` is module state, not React state, so a mount that lands before
  // the catalogue has one (e.g. an IndexedDB record from before generations were
  // stored, still being replaced by a background reload) would otherwise never
  // retry: `[channelId]` alone doesn't see it change. Subscribing to the same
  // notifications `useChannels` uses re-checks it whenever the catalogue changes.
  useEffect(() => {
    const rerender = () => setTick((t) => t + 1)
    _listeners.add(rerender)
    return () => { _listeners.delete(rerender) }
  }, [])

  useEffect(() => {
    if (!channelId || _epgCache.has(channelId) || _generation === null) return

    let cancelled = false
    Promise.resolve().then(() => {
      if (!cancelled) setLoading(true)
    })
    loadSchedule(channelId, _generation)
      .then((data) => {
        if (!cancelled) {
          _epgCache.set(channelId, data)
          setFetchedPrograms((prev) => ({ ...prev, [channelId]: data }))
          setLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [channelId, tick])

  return { programs, loading }
}

// ---- Favourites ----
const FAV_KEY = 'sl_favourites_v1'

function readFavourites(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]'))
  } catch { return new Set() }
}

function writeFavourites(ids: Set<string>) {
  localStorage.setItem(FAV_KEY, JSON.stringify([...ids]))
}

let _favourites: Set<string> = readFavourites()
const _favListeners = new Set<() => void>()

function notifyFav() { _favListeners.forEach((fn) => fn()) }

export function useFavourites() {
  const [, setTick] = useState(0)

  useEffect(() => {
    const rerender = () => setTick((t) => t + 1)
    _favListeners.add(rerender)

    function onStorage(e: StorageEvent) {
      if (e.key === FAV_KEY) {
        _favourites = readFavourites()
        notifyFav()
      }
    }
    window.addEventListener('storage', onStorage)

    return () => {
      _favListeners.delete(rerender)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const toggle = useCallback((channelId: string) => {
    const next = new Set(_favourites)
    if (next.has(channelId)) {
      next.delete(channelId)
    } else {
      next.add(channelId)
    }
    _favourites = next
    writeFavourites(next)
    notifyFav()
  }, [])

  const isFavourite = useCallback((channelId: string) => _favourites.has(channelId), [])

  return { favouriteIds: _favourites, toggle, isFavourite }
}

// ---- Recently Watched ----
const RECENT_KEY = 'sl_recent_v1'
const RECENT_MAX = 20

function readRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') }
  catch { return [] }
}

let _recent: string[] = readRecent()
const _recentListeners = new Set<() => void>()
function notifyRecent() { _recentListeners.forEach((fn) => fn()) }

export function useRecent() {
  const [, setTick] = useState(0)
  useEffect(() => {
    const rerender = () => setTick((t) => t + 1)
    _recentListeners.add(rerender)
    return () => { _recentListeners.delete(rerender) }
  }, [])

  const addRecent = useCallback((channelId: string) => {
    _recent = [channelId, ..._recent.filter((id) => id !== channelId)].slice(0, RECENT_MAX)
    localStorage.setItem(RECENT_KEY, JSON.stringify(_recent))
    notifyRecent()
  }, [])

  return { recentIds: _recent, addRecent }
}
