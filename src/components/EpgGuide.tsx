import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Category, EnrichedChannel, EpgProgram } from '../api/types'
import { fetchEpg } from '../api/catalogueSource'
import { persistSchedules, readPersistedSchedules } from '../util/scheduleLoader'
import {
  PIXELS_PER_MINUTE,
  ROW_HEIGHT,
  SIDEBAR_WIDTH,
  NOW_REFRESH_MS,
  buildGuideWindow,
  hourMarks,
} from '../util/epgTime'
import {
  isTranslationEnabled,
  setTranslationEnabled,
  useTranslationVersion,
} from '../util/translate'
import { applyFilters } from '../util/epgFilter'
import { prefetchPlaylist } from '../util/playlistPrefetch'
import type { GuideFilters } from '../util/epgFilter'
import { EpgToolbar } from './EpgToolbar'
import { EpgTimeline } from './EpgTimeline'
import { EpgRow } from './EpgRow'
import { COMPACT_MAX, MEDIUM_MAX } from '../styles/breakpoints'
import './EpgGuide.css'

interface Props {
  channels: EnrichedChannel[]
  categories: Category[]
  epgChannelIds: Set<string>
  /** Generation `channels` and `epgChannelIds` actually are; null before the first load. */
  generation: number | null
  filters: GuideFilters
  /**
   * Pre-resolved set of channel ids matching the current search query, or
   * `null` when there is no search restriction. Pre-computed once per
   * keystroke by the Guide page and threaded through so every filter pass
   * below can membership-test in O(1) instead of re-scanning.
   */
  matchSet: Set<string> | null
  /**
   * True when the schedule index could not be read. The guide then lists the
   * playable channels without programme data, shows a notice, and skips the
   * per-channel schedule requests that could only fail.
   */
  schedulesUnavailable?: boolean
  onRetrySchedules?: () => void
}

/** Rows rendered beyond the viewport on each side. */
const OVERSCAN_PX = 320

/** How far behind the clock the feed may lag before the grid re-anchors. */
const STALE_THRESHOLD_MS = 30 * 60 * 1000

/** Channels whose schedules are requested at once. */
const FETCH_CONCURRENCY = 12

/**
 * Rows whose schedules are fetched beyond the viewport: enough that a normal
 * scroll step lands on rows that are already loaded, and no more. Every read is
 * metered, so the guide reads what is on screen (plus this margin), not the list.
 */
const PREFETCH_AHEAD_ROWS = 12
/** Covers the virtualizer's overscan above the viewport, which renders rows too. */
const PREFETCH_BEHIND_ROWS = 6

/** How long scrolling must pause before the rows it stopped on are fetched. */
const PREFETCH_SETTLE_MS = 150

/**
 * Module-level EPG cache.
 *
 * Keeps the row list referentially stable while a fetch is in flight. Schedules
 * that were read once are also persisted in IndexedDB (see scheduleLoader.ts), so
 * neither a reload nor the Watch page's `useEpg` re-reads them from Redis.
 *
 * Capped: a scroll through a long guide can touch thousands of channels and each
 * schedule is a day of programmes, so entries are evicted oldest-first once the
 * cap is hit.
 */
const EPG_CACHE_LIMIT = 1500
const epgCache = new Map<string, EpgProgram[]>()

/** Generation `epgCache` was filled from; a newer publish invalidates it. */
let epgCacheGeneration: number | null = null

function cacheEpg(channelId: string, programs: EpgProgram[]) {
  epgCache.set(channelId, programs)
  if (epgCache.size > EPG_CACHE_LIMIT) {
    // Map preserves insertion order, so the first key is the stalest.
    const oldest = epgCache.keys().next().value
    if (oldest !== undefined) epgCache.delete(oldest)
  }
}

/** Program list for a channel, always the same array instance per schedule. */
function cachedEpg(channelId: string): EpgProgram[] | undefined {
  return epgCache.get(channelId)
}

/**
 * Channels whose last read came back empty, mapped to when they may be retried.
 *
 * An empty result is indistinguishable from a transient read failure, so it is
 * not pinned in `epgCache` (that would hide a schedule arriving moments later),
 * but it is also not re-requested on every filter change: a short cooldown
 * keeps a partially published feed from turning into a request storm.
 */
const EMPTY_RETRY_MS = 60_000
const emptyRetryAt = new Map<string, number>()

function isCoolingDown(channelId: string): boolean {
  const until = emptyRetryAt.get(channelId)
  if (until === undefined) return false
  if (until > Date.now()) return true
  emptyRetryAt.delete(channelId)
  return false
}

/** Reads one schedule (R2, then Redis), pinned to the generation the caller keys storage by. */
async function loadEpg(channelId: string, generation: number): Promise<EpgProgram[]> {
  try {
    const data = await fetchEpg(channelId, generation)
    if (data.length > 0) {
      emptyRetryAt.delete(channelId)
      cacheEpg(channelId, data)
    } else {
      emptyRetryAt.set(channelId, Date.now() + EMPTY_RETRY_MS)
    }
    return data
  } catch {
    emptyRetryAt.set(channelId, Date.now() + EMPTY_RETRY_MS)
    return []
  }
}



// ---- Program loading state ----

/** Channels whose schedule is queued or in flight, so overlapping passes never repeat a read. */
const pending = new Set<string>()

/** Stable empty list so rows without a schedule keep one prop identity. */
const EMPTY_PROGRAMS: EpgProgram[] = []

/** Lets the caller withdraw a pass whose rows are no longer on screen. */
interface PrefetchPass {
  cancelled: boolean
}

/**
 * Loads schedules for `ids`: from IndexedDB where stored, otherwise from the network at
 * most FETCH_CONCURRENCY at a time, then stores what it returned.
 *
 * `generation` is the caller's own held generation (`useChannels`' `generation`,
 * the same one `channels` and `epgChannelIds` are already for), not re-resolved
 * here: the catalogue pointer can move on in the background (a refresh, another
 * tab's load) between when this view's catalogue loaded and when it scrolls, and
 * reading the pointer fresh at that point would fetch schedules for a generation
 * other than the one actually on screen.
 *
 * Notifications are coalesced per animation frame: a screenful of schedules
 * arrives as dozens of separate awaits, and repainting per channel would cost
 * one render each instead of one render for the whole wave.
 */
async function prefetchEpg(
  ids: string[],
  generation: number | null,
  onLoaded: () => void,
  pass: PrefetchPass,
) {
  if (generation === null) {
    // No catalogue is held yet, so no schedule can be. Cool the rows down
    // rather than fetching for a generation the view isn't showing.
    for (const id of ids) emptyRetryAt.set(id, Date.now() + EMPTY_RETRY_MS)
    return
  }
  if (epgCacheGeneration !== generation) {
    // A new generation replaced the one these schedules came from.
    const replaced = epgCacheGeneration !== null
    epgCache.clear()
    emptyRetryAt.clear()
    epgCacheGeneration = generation
    if (replaced) onLoaded()
  }

  const missing = ids.filter((id) => !epgCache.has(id) && !pending.has(id) && !isCoolingDown(id))
  if (missing.length === 0 || pass.cancelled) return
  for (const id of missing) pending.add(id)

  let pendingNotify = false
  const scheduleNotify = () => {
    if (pendingNotify) return
    pendingNotify = true
    // Coalesce every completion in this frame into a single repaint.
    queueMicrotask(() => {
      pendingNotify = false
      onLoaded()
    })
  }

  try {
    const stored = await readPersistedSchedules(generation, missing)
    for (const [id, programs] of stored) cacheEpg(id, programs)
    if (stored.size > 0) scheduleNotify()

    const toFetch = missing.filter((id) => !stored.has(id))
    const fetched: [string, EpgProgram[]][] = []
    let index = 0
    const workers = Array.from({ length: Math.min(FETCH_CONCURRENCY, toFetch.length) }, async () => {
      while (index < toFetch.length && !pass.cancelled) {
        const id = toFetch[index]
        index += 1
        const programs = await loadEpg(id, generation)
        if (programs.length > 0) fetched.push([id, programs])
        scheduleNotify()
      }
    })
    await Promise.all(workers)
    if (fetched.length > 0) await persistSchedules(generation, fetched)
  } finally {
    for (const id of missing) pending.delete(id)
  }
}

/** Sidebar width and row height per breakpoint.
 *
 *  JS owns both so the sticky column, the spacer width, the now-line offset and
 *  the virtualizer can never disagree with what is actually painted — a mismatch
 *  is what makes rows overlap or leave gaps. */
function useGuideMetrics() {
  const [metrics, setMetrics] = useState(() => guideMetricsFor(currentViewportWidth()))
  useEffect(() => {
    const onResize = () => setMetrics(guideMetricsFor(currentViewportWidth()))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return metrics
}

/** Viewport width, defaulting to a desktop grid when there is no window. */
function currentViewportWidth(): number {
  return typeof window === 'undefined' ? 1440 : window.innerWidth
}

/**
 * Per-channel schedule coverage, for the channels that have data.
 *
 * Returned as `{ earliestEnd, latestEnd }` rather than raw lists because the
 * time axis only needs two facts about the data: where it stops for the
 * earliest-finishing channel, and where it stops for the latest-finishing one.
 * Anchoring within that band is what lets every row show its programmes.
 */
function channelCoverage(channelIds: string[]): { earliestEnd: number; latestEnd: number } | null {
  let earliestEnd = Infinity
  let latestEnd = 0
  for (const id of channelIds) {
    const programs = epgCache.get(id)
    if (!programs || programs.length === 0) continue
    let end = 0
    for (const p of programs) {
      const e = new Date(p.end_time).getTime()
      if (Number.isFinite(e) && e > end) end = e
    }
    if (end <= 0) continue
    if (end < earliestEnd) earliestEnd = end
    if (end > latestEnd) latestEnd = end
  }
  return latestEnd > 0 ? { earliestEnd, latestEnd } : null
}

function guideMetricsFor(viewportWidth: number): { sidebar: number; rowHeight: number } {
  if (viewportWidth <= COMPACT_MAX) return { sidebar: 104, rowHeight: 52 }
  if (viewportWidth <= MEDIUM_MAX) return { sidebar: 132, rowHeight: 56 }
  return { sidebar: SIDEBAR_WIDTH, rowHeight: ROW_HEIGHT }
}

export function EpgGuide({
  channels,
  categories,
  epgChannelIds,
  generation,
  filters,
  matchSet,
  schedulesUnavailable = false,
  onRetrySchedules,
}: Props) {
  const navigate = useNavigate()
  const viewportRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef(0)
  const { sidebar: sidebarWidth, rowHeight } = useGuideMetrics()
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(640)
  const [translate, setTranslateState] = useState(isTranslationEnabled)
  // Version counter drives re-render when the translation store changes.
  useTranslationVersion()
  // Bumped when a wave of schedules lands, which is what makes the virtualized
  // rows pick up their programs from the cache below.
  const [cacheTick, setCacheTick] = useState(0)

  // Hour labels and the now-marker re-anchor once a minute. Keeping this in
  // separate state from scroll means scrolling never recomputes the timeline.
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), NOW_REFRESH_MS)
    return () => clearInterval(timer)
  }, [])

  // Translation state lives outside React; the version hook above re-renders on
  // change, so the local flag only needs to mirror the toggle.

  // A schedule arriving must repaint the rows that now have data. The callback
  // is coalesced by `prefetchEpg`, so a whole wave costs one render.
  const bumpCache = useCallback(() => setCacheTick((t) => t + 1), [])

  // Guide channels: have a schedule key, are playable, and pass the toolbar.
  const guideChannels = useMemo(
    () => applyFilters(channels.filter((ch) => epgChannelIds.has(ch.id) && ch.stream), filters, matchSet),
    [channels, epgChannelIds, filters, matchSet],
  )

  // Row window, derived from scroll position. Used both to virtualize rendering
  // and to scope the time axis to the rows the viewer is actually looking at.
  const firstRowForWindow = Math.max(0, Math.floor((scrollTop - OVERSCAN_PX) / rowHeight))
  const lastRowForWindow = Math.min(
    guideChannels.length,
    Math.ceil((scrollTop + viewportH + OVERSCAN_PX) / rowHeight),
  )

  /**
   * The shared time axis.
   *
   * Normally it shows "now" with an hour of history. This feed lags the present
   * by days, and channels finish a few hours apart, so when the data is stale the
   * window is placed to cover that spread: it starts shortly before the
   * earliest-finishing channel and runs forward past the latest-finishing one.
   * Any anchor outside that band leaves rows at one end with nothing to draw,
   * which is what made the guide look broken.
   *
   * The span stays one screen-and-a-bit wide: stretching it across a multi-day
   * backlog would trade an empty grid for an unreadable one.
   */
  const gridWindow = useMemo(() => {
    const ids = guideChannels.slice(firstRowForWindow, lastRowForWindow).map((c) => c.id)
    const scope = ids.length > 0 ? ids : guideChannels.map((c) => c.id)
    const coverage = channelCoverage(scope)

    if (!coverage || coverage.latestEnd >= now.getTime() - STALE_THRESHOLD_MS) {
      return buildGuideWindow(now)
    }

    // Anchor the window at the earliest channel's final programme, rounded down
    // to the half hour. Simple and predictable: the left edge is the oldest point
    // at which every channel still has data, so no row is empty and no row's
    // content is pushed under the channel column.
    const step = 30 * 60 * 1000
    const origin = Math.floor(coverage.earliestEnd / step) * step
    return buildGuideWindow(new Date(origin), true, undefined, 0)
    // `cacheTick` re-runs this when a new wave of schedules lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, cacheTick, guideChannels, firstRowForWindow, lastRowForWindow])

  const marks = useMemo(() => hourMarks(gridWindow), [gridWindow])
  const nowOffset = gridWindow.nowOffset
  const isStale = gridWindow.stale

  // Ids only: the prefetch effect must not restart when the search text changes
  // but the matching set is identical.
  const guideKey = useMemo(() => guideChannels.map((c) => c.id).join('\u0000'), [guideChannels])

  // Rows whose schedules are wanted: those in the viewport plus a small margin
  // either side. Deliberately not the whole list; every schedule is one metered
  // read, and rows scrolled into view later fetch on arrival.
  const prefetchFirst = Math.max(0, Math.floor(scrollTop / rowHeight) - PREFETCH_BEHIND_ROWS)
  const prefetchLast = Math.min(
    guideChannels.length,
    Math.ceil((scrollTop + viewportH) / rowHeight) + PREFETCH_AHEAD_ROWS,
  )
  const hasPrefetchedRef = useRef(false)

  useEffect(() => {
    if (schedulesUnavailable || guideChannels.length === 0) return
    const ids = guideChannels.slice(prefetchFirst, prefetchLast).map((c) => c.id)
    const pass: PrefetchPass = { cancelled: false }
    // The first screen goes out at once. After that a fling through the list
    // would fetch every row it passes, so wait for the scroll to settle.
    const delay = hasPrefetchedRef.current ? PREFETCH_SETTLE_MS : 0
    const timer = setTimeout(() => {
      hasPrefetchedRef.current = true
      void prefetchEpg(ids, generation, bumpCache, pass)
    }, delay)
    return () => {
      clearTimeout(timer)
      pass.cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the id set and row window
  }, [guideKey, prefetchFirst, prefetchLast, bumpCache, schedulesUnavailable, generation])

  // Vertical virtualization: only rows intersecting the viewport are rendered.
  const totalHeight = guideChannels.length * rowHeight
  const visibleRows = useMemo(
    () => guideChannels.slice(firstRowForWindow, lastRowForWindow),
    // `cacheTick` is the re-render trigger for schedules arriving; the slice
    // itself only depends on the row window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [guideChannels, firstRowForWindow, lastRowForWindow, cacheTick],
  )

  /**
   * Arrow-key grid movement (S5): Left/Right walk the focusable stops within
   * the current row (channel column, then each programme box); Up/Down move
   * to the row above/below, landing on the programme box closest to the same
   * horizontal position so a viewer scanning a time column stays in it.
   *
   * Rows outside the virtualizer's rendered window (`OVERSCAN_PX`) don't
   * exist in the DOM yet, so a jump that lands there is a no-op — the normal
   * case only up/down by one row from what's already rendered.
   */
  const handleGuideKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return
    const target = e.target as HTMLElement
    const row = target.closest<HTMLElement>('.epg-guide__row')
    if (!row) return

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const stops = Array.from(row.querySelectorAll<HTMLElement>('[tabindex="0"]'))
      const idx = stops.indexOf(target)
      if (idx === -1) return
      const next = stops[idx + (e.key === 'ArrowRight' ? 1 : -1)]
      if (next) {
        e.preventDefault()
        next.focus()
        next.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
      }
      return
    }

    const rowIndex = Number(row.dataset.rowIndex)
    if (Number.isNaN(rowIndex)) return
    const direction = e.key === 'ArrowDown' ? 1 : -1
    const targetRow = viewportRef.current?.querySelector<HTMLElement>(
      `.epg-guide__row[data-row-index="${rowIndex + direction}"]`,
    )
    e.preventDefault()
    if (!targetRow) {
      // The target row is one step beyond the virtualizer's rendered window (its
      // overscan is generous but finite). Nudge the scroll position the same
      // direction so the window grows to cover it — the next press then lands
      // normally — instead of leaving the key press with no visible effect.
      viewportRef.current?.scrollBy({ top: direction * rowHeight, behavior: 'smooth' })
      return
    }

    const isChannelColumn = target.classList.contains('epg-guide__channel')
    const channelStop = targetRow.querySelector<HTMLElement>('.epg-guide__channel')
    let landing: HTMLElement | null = channelStop
    if (!isChannelColumn) {
      const targetLeft = target.getBoundingClientRect().left
      const boxes = Array.from(targetRow.querySelectorAll<HTMLElement>('.epg-guide__program'))
      landing =
        boxes.reduce<HTMLElement | null>((closest, el) => {
          if (!closest) return el
          const d = Math.abs(el.getBoundingClientRect().left - targetLeft)
          const dClosest = Math.abs(closest.getBoundingClientRect().left - targetLeft)
          return d < dClosest ? el : closest
        }, null) ?? channelStop
    }
    if (landing) {
      landing.focus()
      landing.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
    }
  }, [rowHeight])

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    // rAF-throttle: one state write per frame regardless of scroll event rate.
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      setScrollTop(el.scrollTop)
    })
  }, [])

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const measure = () => setViewportH(el.clientHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const scrollToNow = useCallback(() => {
    const el = viewportRef.current
    if (!el) return
    const playingId = sessionStorage.getItem('sl_last_viewed')
    const rowIndex = playingId ? guideChannels.findIndex((c) => c.id === playingId) : -1
    const top =
      rowIndex >= 0 ? Math.max(0, rowIndex * rowHeight - el.clientHeight / 2 + rowHeight / 2) : el.scrollTop
    const left = Math.max(0, nowOffset * PIXELS_PER_MINUTE - (el.clientWidth - sidebarWidth) / 2)
    el.scrollTo({ top, left, behavior: 'smooth' })
  }, [guideChannels, rowHeight, sidebarWidth, nowOffset])

  // Stable across filter edits: rows are memoized on this prop, so a new
  // identity here would re-render every visible row on each keystroke.
  const playlistRef = useRef<string[]>([])
  const guideChannelsRef = useRef(guideChannels)
  useEffect(() => {
    playlistRef.current = guideChannels.map((c) => c.id)
    guideChannelsRef.current = guideChannels
  }, [guideChannels])

  const handlePick = useCallback(
    (channelId: string) => {
      const picked = guideChannelsRef.current.find((c) => c.id === channelId)
      if (picked) prefetchPlaylist(picked)
      sessionStorage.setItem('sl_last_viewed', channelId)
      navigate(`/watch/${encodeURIComponent(channelId)}`, {
        state: { playlist: playlistRef.current, returnTo: '/guide' },
      })
    },
    [navigate],
  )

  // Restore the row that was last watched.
  useEffect(() => {
    const targetId = sessionStorage.getItem('sl_last_viewed')
    if (!targetId || guideChannels.length === 0) return
    const index = guideChannels.findIndex((c) => c.id === targetId)
    const el = viewportRef.current
    if (index < 0 || !el) return
    el.scrollTop = Math.max(0, index * rowHeight - el.clientHeight / 2 + rowHeight / 2)
    setScrollTop(el.scrollTop)
  }, [guideChannels, rowHeight])

  return (
    <div
      className="epg-guide"
      style={{
        ['--epg-sidebar-w' as string]: sidebarWidth + 'px',
        ['--epg-row-h' as string]: rowHeight + 'px',
      }}
    >
      <EpgToolbar
        filters={filters}
        channels={channels}
        categories={categories}
        epgChannelIds={epgChannelIds}
        resultCount={guideChannels.length}
        translate={translate}
        onToggleTranslate={() => {
          setTranslationEnabled(!translate)
          setTranslateState(!translate)
        }}
        onScrollToNow={scrollToNow}
      />

      {schedulesUnavailable && (
        <div className="epg-guide__stale" role="status">
          <span aria-hidden="true">⚠</span>
          Programme schedules aren&apos;t available right now. Channels are still live, so pick one to watch.
          {onRetrySchedules && (
            <button type="button" className="epg-guide__stale-action" onClick={onRetrySchedules}>
              Try again
            </button>
          )}
        </div>
      )}

      {isStale && !schedulesUnavailable && (
        <div className="epg-guide__stale" role="status">
          <span aria-hidden="true">⚠</span>
          Showing the latest published schedules ({new Date(
            gridWindow.origin + gridWindow.anchorOffset * 60_000,
          ).toLocaleDateString([], { month: 'short', day: 'numeric' })}) — today&apos;s guide has
          not been published yet.
        </div>
      )}

      <div
        className="epg-guide__grid"
        ref={viewportRef}
        onScroll={handleScroll}
        onKeyDown={handleGuideKeyDown}
      >
        <EpgTimeline
          marks={marks}
          gridWidth={gridWindow.width}
          nowOffset={nowOffset}
          sidebarWidth={sidebarWidth}
        />

        {guideChannels.length > 0 ? (
          <div
            className="epg-guide__spacer"
            style={{ height: totalHeight, width: sidebarWidth + gridWindow.width }}
          >
            {visibleRows.map((ch, i) => (
              <EpgRow
                key={ch.id}
                channel={ch}
                programs={cachedEpg(ch.id) ?? EMPTY_PROGRAMS}
                origin={gridWindow.origin}
                nowOffset={nowOffset}
                spanMinutes={gridWindow.span}
                translate={translate}
                sidebarWidth={sidebarWidth}
                top={(firstRowForWindow + i) * rowHeight}
                rowHeight={rowHeight}
                rowIndex={firstRowForWindow + i}
                onPick={handlePick}
              />
            ))}
            <div
              className="epg-guide__now-line"
              style={{ transform: `translateX(${nowOffset * PIXELS_PER_MINUTE}px)` }}
            />
          </div>
        ) : (
          <div className="epg-guide__empty">
            <p className="epg-guide__empty-title">No channels match these filters</p>
            <p className="epg-guide__empty-hint">
              Try clearing the search or choosing a different country, language or category.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
