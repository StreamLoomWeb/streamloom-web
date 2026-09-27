import { useEffect, useRef, useState, useMemo } from 'react'
import type { LanguageOption } from '../util/language'
import './FilterSheet.css'

interface FilterSheetProps {
  isOpen: boolean
  onClose: () => void
  totalChannelsCount: number
  // Countries
  availableCountries: Array<{ code: string; name: string; flag: string; count: number }>
  selectedCountry: string | null
  onSelectCountry: (code: string | null) => void
  // Categories
  availableCategories: Array<{ id: string; name: string; count: number }>
  selectedCategory: string | null
  onSelectCategory: (id: string | null) => void
  // Languages
  availableLanguages: LanguageOption[]
  selectedLanguage: string | null
  onSelectLanguage: (code: string | null) => void
  // Quality
  availableQualities: string[]
  selectedQuality: string
  onSelectQuality: (q: string) => void
  // Favourites
  showFavOnly: boolean
  onToggleFavOnly: () => void
  favCount: number
  // Clear
  onClearAll: () => void
  hasActiveFilters: boolean
}

export function FilterSheet({
  isOpen,
  onClose,
  totalChannelsCount,
  availableCountries,
  selectedCountry,
  onSelectCountry,
  availableCategories,
  selectedCategory,
  onSelectCategory,
  availableLanguages,
  selectedLanguage,
  onSelectLanguage,
  availableQualities,
  selectedQuality,
  onSelectQuality,
  showFavOnly,
  onToggleFavOnly,
  favCount,
  onClearAll,
  hasActiveFilters,
}: FilterSheetProps) {
  const [countrySearch, setCountrySearch] = useState('')
  const dialogRef = useRef<HTMLDialogElement>(null)

  // <dialog>.showModal() is what gives this a focus trap and native
  // Esc-to-close for free, instead of the hand-rolled backdrop this used
  // to be (which let Esc fall through to the page's own "clear filters"
  // shortcut — see useKeyboardNav's dialog[open] guard).
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (isOpen && !dialog.open) dialog.showModal()
    else if (!isOpen && dialog.open) dialog.close()
  }, [isOpen])

  const filteredCountries = useMemo(() => {
    const q = countrySearch.trim().toLowerCase()
    if (!q) return availableCountries
    return availableCountries.filter(
      (c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q),
    )
  }, [availableCountries, countrySearch])

  return (
    <dialog
      ref={dialogRef}
      className="filter-sheet-backdrop"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose()
      }}
    >
      <div className="filter-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="filter-sheet__drag-handle" />

        <div className="filter-sheet__header">
          <div className="filter-sheet__title-group">
            <h3 className="filter-sheet__title">Filters</h3>
            <span className="filter-sheet__count">{totalChannelsCount} channels</span>
          </div>
          <button className="filter-sheet__close-btn" onClick={onClose} aria-label="Close filters">
            ✕
          </button>
        </div>

        <div className="filter-sheet__body">
          {/* Quick Favourites Toggle */}
          <div
            className={`filter-sheet__toggle-row ${showFavOnly ? 'filter-sheet__toggle-row--active' : ''}`}
            onClick={onToggleFavOnly}
          >
            <div className="filter-sheet__toggle-info">
              <span>♥ Only Favourites</span>
              {favCount > 0 && <span className="filter-chip__count">{favCount}</span>}
            </div>
            <input
              type="checkbox"
              checked={showFavOnly}
              onChange={() => {}}
              style={{ accentColor: '#ef4444', transform: 'scale(1.2)' }}
            />
          </div>

          {/* Quality / Resolution */}
          <div className="filter-sheet__section">
            <span className="filter-sheet__section-title">Resolution / Quality</span>
            <div className="filter-sheet__chips-wrap">
              {availableQualities.map((q) => (
                <button
                  key={q}
                  className={`filter-chip ${selectedQuality === q ? 'filter-chip--active' : ''}`}
                  onClick={() => onSelectQuality(q)}
                >
                  <span>📺 {q}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Categories */}
          <div className="filter-sheet__section">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="filter-sheet__section-title">Categories</span>
              {selectedCategory && (
                <button
                  onClick={() => onSelectCategory(null)}
                  style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}
                >
                  Clear category
                </button>
              )}
            </div>
            <div className="filter-sheet__chips-wrap">
              {availableCategories.map((cat) => {
                const isActive = selectedCategory === cat.id
                return (
                  <button
                    key={cat.id}
                    className={`filter-chip ${isActive ? 'filter-chip--active' : ''}`}
                    onClick={() => onSelectCategory(isActive ? null : cat.id)}
                  >
                    <span>{cat.name}</span>
                    <span className="filter-chip__count">{cat.count}</span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Countries with live search */}
          <div className="filter-sheet__section">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="filter-sheet__section-title">Country ({availableCountries.length})</span>
              {selectedCountry && (
                <button
                  onClick={() => onSelectCountry(null)}
                  style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}
                >
                  Clear country
                </button>
              )}
            </div>

            <input
              type="search"
              placeholder="Search countries…"
              className="filter-sheet__search-input"
              value={countrySearch}
              onChange={(e) => setCountrySearch(e.target.value)}
            />

            <div className="filter-sheet__country-list">
              <div
                className={`filter-sheet__country-item ${!selectedCountry ? 'filter-sheet__country-item--active' : ''}`}
                onClick={() => onSelectCountry(null)}
              >
                <div className="filter-sheet__country-name">
                  <span>🌍</span>
                  <span>All Countries</span>
                </div>
              </div>
              {filteredCountries.map((c) => {
                const isActive = selectedCountry === c.code
                return (
                  <div
                    key={c.code}
                    className={`filter-sheet__country-item ${isActive ? 'filter-sheet__country-item--active' : ''}`}
                    onClick={() => onSelectCountry(isActive ? null : c.code)}
                  >
                    <div className="filter-sheet__country-name">
                      <span>{c.flag}</span>
                      <span>{c.name}</span>
                    </div>
                    <span className="filter-chip__count">{c.count}</span>
                  </div>
                )
              })}
            </div>
          </div>
          {/* Languages: single-select, mirroring the desktop picker. Hidden
              until the sync worker publishes languages. */}
          {availableLanguages.length > 0 && (
            <div className="filter-sheet__section">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="filter-sheet__section-title">Language</span>
                {selectedLanguage && (
                  <button
                    onClick={() => onSelectLanguage(null)}
                    style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}
                  >
                    Clear language
                  </button>
                )}
              </div>
              <div className="filter-sheet__chips-wrap">
                {availableLanguages.map((lang) => {
                  const isActive = selectedLanguage === lang.code
                  return (
                    <button
                      key={lang.code}
                      className={`filter-chip ${isActive ? 'filter-chip--active' : ''}`}
                      onClick={() => onSelectLanguage(isActive ? null : lang.code)}
                    >
                      <span>🌐 {lang.name}</span>
                      <span className="filter-chip__count">{lang.count}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        <div className="filter-sheet__footer">
          {hasActiveFilters && (
            <button className="filter-sheet__btn-reset" onClick={onClearAll}>
              Reset All
            </button>
          )}
          <button className="filter-sheet__btn-apply" onClick={onClose}>
            View {totalChannelsCount} Channels
          </button>
        </div>
      </div>
    </dialog>
  )
}
