import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useChannels, useFavourites } from '../hooks/useChannels'
import { EpgGuide } from '../components/EpgGuide'
import type { GuideFilters, GuideFilterState } from '../util/epgFilter'
import { EMPTY_FILTER_STATE } from '../util/epgFilter'
import { computeMatchSet, normalizeSearch } from '../util/searchText'
import { trackGuideOpen, trackLatency } from '../telemetry/telemetry'
import './Guide.css'

/** Filter state survives navigating to the player and back. */
const SESSION_KEYS = {
  search: 'sl_guide_search',
  country: 'sl_guide_country',
  language: 'sl_guide_language',
  category: 'sl_guide_category',
  quality: 'sl_guide_quality',
  favOnly: 'sl_guide_fav',
} as const

function readInitialState(): GuideFilterState {
  const get = (key: string) => {
    try {
      return sessionStorage.getItem(key)
    } catch {
      return null
    }
  }
  return {
    search: get(SESSION_KEYS.search) ?? '',
    country: get(SESSION_KEYS.country),
    language: get(SESSION_KEYS.language),
    category: get(SESSION_KEYS.category),
    quality: get(SESSION_KEYS.quality) ?? 'All Quality',
    favOnly: get(SESSION_KEYS.favOnly) === 'true',
    favouriteIds: EMPTY_FILTER_STATE.favouriteIds,
  }
}

export function Guide() {
  const { channels, allChannels, categories, epgChannelIds, epgAvailable, refreshEpg, loading, generation } = useChannels()
  const { favouriteIds } = useFavourites()
  const [state, setState] = useState<GuideFilterState>(readInitialState)

  // Telemetry (ADR-0047): one `guide_open` per visit, and how long the guide took to have
  // channels on screen (perf `guide_open`, a bucket index). Fire-and-forget.
  const openedAtRef = useRef<number | null>(null)
  useEffect(() => {
    openedAtRef.current = performance.now()
    trackGuideOpen()
  }, [])
  useEffect(() => {
    if (loading || channels.length === 0 || openedAtRef.current === null) return
    trackLatency('guide_open', performance.now() - openedAtRef.current)
    openedAtRef.current = null
  }, [loading, channels.length])

  // Persist each field so a trip to the player does not reset the view.
  useEffect(() => {
    const write = (key: string, value: string | null) => {
      try {
        if (value) sessionStorage.setItem(key, value)
        else sessionStorage.removeItem(key)
      } catch {
        // Storage denials are non-fatal for a filter preference.
      }
    }
    write(SESSION_KEYS.search, state.search || null)
    write(SESSION_KEYS.country, state.country)
    write(SESSION_KEYS.language, state.language)
    write(SESSION_KEYS.category, state.category)
    write(SESSION_KEYS.quality, state.quality === 'All Quality' ? null : state.quality)
    write(SESSION_KEYS.favOnly, state.favOnly ? 'true' : null)
  }, [state])

  const filters: GuideFilters = useMemo(
    () => ({
      ...state,
      favouriteIds,
      onSearch: (value) => setState((s) => ({ ...s, search: value })),
      onCountry: (value) => setState((s) => ({ ...s, country: value })),
      onLanguage: (value) => setState((s) => ({ ...s, language: value })),
      onCategory: (value) => setState((s) => ({ ...s, category: value })),
      onQuality: (value) => setState((s) => ({ ...s, quality: value })),
      onToggleFav: () => setState((s) => ({ ...s, favOnly: !s.favOnly })),
      onClear: () => setState((s) => ({ ...EMPTY_FILTER_STATE, favouriteIds: s.favouriteIds })),
    }),
    [state, favouriteIds],
  )

  // Without a schedule index the guide falls back to every playable channel, so
  // the page stays a working channel browser instead of an empty grid.
  const schedulesUnavailable = !loading && channels.length > 0 && !epgAvailable

  // Each visit to an unavailable guide gets a fresh, cheap attempt at recovery.
  useEffect(() => {
    if (schedulesUnavailable) void refreshEpg()
  }, [schedulesUnavailable, refreshEpg])

  const guideIds = useMemo(
    () => (schedulesUnavailable
      ? new Set(channels.filter((ch) => ch.stream).map((ch) => ch.id))
      : epgChannelIds),
    [schedulesUnavailable, channels, epgChannelIds],
  )

  const availableCount = useMemo(
    () => channels.filter((ch) => guideIds.has(ch.id) && ch.stream).length,
    [channels, guideIds],
  )

  /**
   * Mirror Home's deferral pattern: the search input updates `state.search`
   * synchronously, but the heavy filter work reads from `deferredSearch` so
   * the input never stalls even when a 40k-row filter pass is in flight.
   */
  const deferredSearch = useDeferredValue(state.search)
  const matchSet = useMemo(
    () => computeMatchSet(normalizeSearch(deferredSearch.trim()), allChannels),
    [deferredSearch, allChannels],
  )

  return (
    <div className="guide-page">
      <div className="guide-page__header">
        <h1 className="guide-page__title">
          TV Guide
          {!loading && !schedulesUnavailable && (
            <span className="guide-page__count">
              {availableCount.toLocaleString()} channels with schedules
            </span>
          )}
        </h1>
        <p className="guide-page__subtitle">
          Live schedules · Click any programme to watch
        </p>
      </div>

      {loading ? (
        <div className="guide-page__loading" role="status" aria-label="Loading channel guide">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="guide-skeleton-row">
              <div className="skeleton guide-skeleton-row__channel" />
              <div className="skeleton guide-skeleton-row__prog" style={{ width: `${30 + ((i * 17) % 35)}%` }} />
              <div className="skeleton guide-skeleton-row__prog" style={{ width: `${20 + ((i * 11) % 25)}%` }} />
            </div>
          ))}
        </div>
      ) : (
        <EpgGuide
          channels={channels}
          categories={categories}
          epgChannelIds={guideIds}
          generation={generation}
          filters={filters}
          matchSet={matchSet}
          schedulesUnavailable={schedulesUnavailable}
          onRetrySchedules={() => void refreshEpg()}
        />
      )}
    </div>
  )
}

