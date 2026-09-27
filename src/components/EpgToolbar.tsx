import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Category, EnrichedChannel } from '../api/types'
import { formatCountryDisplay, getCountryFlag, getCountryName } from '../util/country'
import { getLanguageName } from '../util/language'
import type { LanguageOption } from '../util/language'
import {
  activeFilterCount,
  facetBundle,
  hasActiveFilters,
} from '../util/epgFilter'
import { useChannels } from '../hooks/useChannels'
import type { GuideFilters } from '../util/epgFilter'
import { computeMatchSet, normalizeSearch } from '../util/searchText'
import { FilterSheet } from './FilterSheet'
import { SearchBar } from './SearchBar'
import '../pages/Home.css'
import './FilterSheet.css'

interface Props {
  filters: GuideFilters
  channels: EnrichedChannel[]
  categories: Category[]
  epgChannelIds: Set<string>
  resultCount: number
  translate: boolean
  onToggleTranslate: () => void
  onScrollToNow: () => void
}

/** Quality buckets, identical to the Home screen's resolution filter. */
const QUALITY_OPTIONS = ['4K', 'FHD (1080p)', 'HD (720p)', 'SD']

/** Categories pinned to the front of the track, as on the Home screen. */
const PRIORITY_CATEGORIES = ['music', 'movies', 'cartoons', 'comedy', 'news', 'sports']

const CATEGORY_ICONS: Record<string, string> = {
  music: '🎵', movies: '🎬', cartoons: '🦄', kids: '🧸', comedy: '😂', news: '📰',
  sports: '⚽', documentary: '🌍', entertainment: '🍿', lifestyle: '✨', general: '📺',
  series: '🎞️', auto: '🏎️', science: '🔬', travel: '✈️', cooking: '🍳',
  family: '👨‍👩‍👧', classic: '📻', business: '💼',
}

/**
 * Filter bar for the TV guide.
 *
 * Mirrors the Home screen exactly: the same `SearchBar`, the same `FilterSheet`
 * bottom sheet, the same active-filter chips and the same quick filter row with
 * its scrollable category track. Both surfaces are fed by `facetCounts`, which
 * evaluates each facet against every *other* active filter so a control never
 * collapses to its own selection.
 */
export function EpgToolbar({
  filters,
  channels,
  categories,
  epgChannelIds,
  resultCount,
  translate,
  onToggleTranslate,
  onScrollToNow,
}: Props) {
  const { allChannels } = useChannels()
  const scope = useMemo(
    () => channels.filter((ch) => epgChannelIds.has(ch.id) && ch.stream),
    [channels, epgChannelIds],
  )
  const [sheetOpen, setSheetOpen] = useState(false)
  const categoriesScrollRef = useRef<HTMLDivElement>(null)

  /**
   * Resolve the search query to a small set of channel ids exactly once per
   * keystroke; every facet below reads from it instead of re-scanning the
   * catalogue. `null` means "no search restriction" so the bundle runs every
   * row through the same inline filter chain.
   */
  const matchSet = useMemo(
    () => computeMatchSet(normalizeSearch(filters.search.trim()), allChannels),
    [filters.search, allChannels],
  )

  /**
   * One walk over `scope` produces every facet's count map. Replaces the
   * previous four-walk-per-keystroke implementation.
   */
  const bundle = useMemo(() => facetBundle(scope, filters, matchSet), [scope, filters, matchSet])

  const countries = useMemo(() => {
    const counts = bundle.country
    return [...counts.keys()]
      .map((code) => ({
        code,
        flag: getCountryFlag(code),
        name: getCountryName(code),
        count: counts.get(code) ?? 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [bundle])

  const categoryOptions = useMemo(() => {
    const counts = bundle.category
    return categories
      .filter((cat) => (counts.get(cat.id) ?? 0) > 0)
      .map((cat) => ({
        id: cat.id,
        name: cat.name,
        count: counts.get(cat.id) ?? 0,
        icon: CATEGORY_ICONS[cat.id.toLowerCase()] ?? '📺',
      }))
      .sort((a, b) => {
        const ai = PRIORITY_CATEGORIES.indexOf(a.id.toLowerCase())
        const bi = PRIORITY_CATEGORIES.indexOf(b.id.toLowerCase())
        if (ai !== -1 && bi !== -1) return ai - bi
        if (ai !== -1) return -1
        if (bi !== -1) return 1
        return a.name.localeCompare(b.name)
      })
  }, [categories, bundle])

  const languages = useMemo<LanguageOption[]>(() => {
    const counts = bundle.language
    return [...counts.keys()]
      .map((code) => ({ code, name: getLanguageName(code), count: counts.get(code) ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [bundle])

  // Only offer resolutions that exist in the current subset, like Home does.
  const qualities = useMemo(() => {
    const counts = bundle.quality
    return ['All Quality', ...QUALITY_OPTIONS.filter((q) => (counts.get(q) ?? 0) > 0)]
  }, [bundle])

  // Wheel over the category track scrolls it horizontally, as on Home.
  useEffect(() => {
    const el = categoriesScrollRef.current
    if (!el) return
    function onWheel(e: WheelEvent) {
      const track = categoriesScrollRef.current
      if (!track || e.deltaY === 0 || track.scrollWidth <= track.clientWidth) return
      e.preventDefault()
      track.scrollLeft += e.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onSearch = useCallback((v: string) => filters.onSearch(v), [filters])
  const count = activeFilterCount(filters)
  const isFiltered = hasActiveFilters(filters)
  const selectedCategory = filters.category
    ? categoryOptions.find((c) => c.id === filters.category)
    : undefined


  return (
    <>
      <div className="epg-toolbar">
        <div className="epg-toolbar__row">
          <div className="epg-toolbar__search-slot">
            <SearchBar
              value={filters.search}
              onChange={onSearch}
              resultCount={filters.search.trim() ? resultCount : undefined}
            />
          </div>

          <button
            type="button"
            className={`home-filter-btn${count > 0 ? ' home-filter-btn--active' : ''}`}
            onClick={() => setSheetOpen(true)}
            aria-label="Open filter settings"
            title="Filter channels by country, category, resolution"
          >
            <span>🎛️ Filters</span>
            {count > 0 && <span className="home-filter-btn__badge">{count}</span>}
          </button>

          <button
            type="button"
            className={`epg-toolbar__btn${translate ? ' epg-toolbar__btn--active' : ''}`}
            onClick={onToggleTranslate}
            aria-pressed={translate}
            title="Translate programme titles to English"
          >
            <span aria-hidden="true">🌐</span>
            {translate ? 'English' : 'Original'}
          </button>

          <button type="button" className="epg-toolbar__btn" onClick={onScrollToNow}>
            <span aria-hidden="true">◉</span>
            Now
          </button>

          <span className="epg-toolbar__count">
            {resultCount.toLocaleString()} {resultCount === 1 ? 'channel' : 'channels'}
          </span>
        </div>

        {isFiltered && (
          <div className="home-active-chips">
            {filters.favOnly && (
              <button className="active-chip" onClick={filters.onToggleFav}>
                <span>♥ Favourites</span>
                <span className="active-chip__remove">✕</span>
              </button>
            )}
            {filters.country && (
              <button className="active-chip" onClick={() => filters.onCountry(null)}>
                <span>{formatCountryDisplay(filters.country)}</span>
                <span className="active-chip__remove">✕</span>
              </button>
            )}
            {selectedCategory && (
              <button className="active-chip" onClick={() => filters.onCategory(null)}>
                <span>
                  {selectedCategory.icon} {selectedCategory.name}
                </span>
                <span className="active-chip__remove">✕</span>
              </button>
            )}
            {filters.language && (
              <button className="active-chip" onClick={() => filters.onLanguage(null)}>
                <span>🌐 {getLanguageName(filters.language)}</span>
                <span className="active-chip__remove">✕</span>
              </button>
            )}
            {filters.quality !== 'All Quality' && (
              <button className="active-chip" onClick={() => filters.onQuality('All Quality')}>
                <span>📺 {filters.quality}</span>
                <span className="active-chip__remove">✕</span>
              </button>
            )}
            <button className="active-chip__clear-all" onClick={filters.onClear}>
              Clear all
            </button>
          </div>
        )}

        <div className="home-filters-row">
          <div className="home-quick-filters">
            <button
              className={`filter-pill${filters.favOnly ? ' filter-pill--active' : ''}`}
              onClick={filters.onToggleFav}
              title="Filter favourites"
            >
              <span>♥ Favourites</span>
              {filters.favouriteIds.size > 0 && (
                <span className="filter-pill__count">{filters.favouriteIds.size}</span>
              )}
            </button>

            <div className="filter-select-wrap">
              <select
                className={`filter-select${filters.quality !== 'All Quality' ? ' filter-select--active' : ''}`}
                value={filters.quality}
                onChange={(e) => filters.onQuality(e.target.value)}
                aria-label="Filter by quality"
              >
                {qualities.map((q) => (
                  <option key={q} value={q}>
                    📺 {q}
                  </option>
                ))}
              </select>
              <span className="filter-select-arrow">▼</span>
            </div>

            <div className="filter-select-wrap">
              <select
                className={`filter-select${filters.country ? ' filter-select--active' : ''}`}
                value={filters.country ?? ''}
                onChange={(e) => filters.onCountry(e.target.value || null)}
                aria-label="Filter by country"
              >
                <option value="">🌍 All Countries ({countries.length})</option>
                {countries.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.flag} {c.name} ({c.count})
                  </option>
                ))}
              </select>
              <span className="filter-select-arrow">▼</span>
            </div>

            {languages.length > 0 && (
              <div className="filter-select-wrap">
                <select
                  className={`filter-select${filters.language ? ' filter-select--active' : ''}`}
                  value={filters.language ?? ''}
                  onChange={(e) => filters.onLanguage(e.target.value || null)}
                  aria-label="Filter by language"
                >
                  <option value="">🌐 All Languages ({languages.length})</option>
                  {languages.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.name} ({l.count})
                    </option>
                  ))}
                </select>
                <span className="filter-select-arrow">▼</span>
              </div>
            )}
          </div>

          <div className="home-categories-scroll-wrap">
            <div className="home-categories-scroll" ref={categoriesScrollRef}>
              {categoryOptions.length === 0 ? (
                <span className="epg-toolbar__hint">No categories in this view</span>
              ) : (
                categoryOptions.map((cat) => {
                  const isActive = filters.category === cat.id
                  return (
                    <button
                      key={cat.id}
                      className={`filter-pill${isActive ? ' filter-pill--active' : ''}`}
                      onClick={() => filters.onCategory(isActive ? null : cat.id)}
                      title={`${cat.name} (${cat.count} channels)`}
                    >
                      <span className="filter-pill__icon">{cat.icon}</span>
                      <span>{cat.name}</span>
                      <span className="filter-pill__count">{cat.count}</span>
                    </button>
                  )
                })
              )}
            </div>
          </div>
        </div>
      </div>

      <FilterSheet
        isOpen={sheetOpen}
        onClose={() => setSheetOpen(false)}
        totalChannelsCount={resultCount}
        availableCountries={countries}
        selectedCountry={filters.country}
        onSelectCountry={filters.onCountry}
        availableCategories={categoryOptions.map(({ id, name, count }) => ({ id, name, count }))}
        selectedCategory={filters.category}
        onSelectCategory={filters.onCategory}
        availableLanguages={languages}
        selectedLanguage={filters.language}
        onSelectLanguage={filters.onLanguage}
        availableQualities={qualities}
        selectedQuality={filters.quality}
        onSelectQuality={filters.onQuality}
        showFavOnly={filters.favOnly}
        onToggleFavOnly={filters.onToggleFav}
        favCount={filters.favouriteIds.size}
        onClearAll={filters.onClear}
        hasActiveFilters={isFiltered}
      />
    </>
  )
}


