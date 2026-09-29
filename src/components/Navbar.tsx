import { useMemo } from 'react'
import { NavLink } from 'react-router-dom'
import { useChannels, useFavourites } from '../hooks/useChannels'
import { useTheme } from '../hooks/useTheme'
import { useAppBadge } from '../hooks/useAppBadge'
import { setTranslationEnabled, useTranslateEnabled } from '../util/translate'
import { GlobeIcon, GuideIcon, HeartIcon, HomeIcon, MoonIcon, PlayIcon, SettingsIcon, SunIcon } from './icons'
import './Navbar.css'

export function Navbar() {
  const { loading, channels } = useChannels()
  const { favouriteIds } = useFavourites()
  const { isDark, toggleTheme } = useTheme()
  const translate = useTranslateEnabled()
  const favCount = favouriteIds.size
  useAppBadge(useMemo(() => channels.filter((c) => c.stream && favouriteIds.has(c.id)).length, [channels, favouriteIds]))

  return (
    <>
      {/* Top Navbar for all screens */}
      <nav className="navbar glass" role="navigation" aria-label="Main navigation">
        <NavLink to="/" className="navbar__brand">
          <span className="navbar__logo-icon"><PlayIcon /></span>
          <span className="navbar__logo-text gradient-text">StreamLoom</span>
        </NavLink>

        {/* Desktop / Tablet navigation links */}
        <div className="navbar__links">
          <NavLink to="/" className={({ isActive }) => `navbar__link ${isActive ? 'navbar__link--active' : ''}`} end>
            Home
          </NavLink>
          <NavLink to="/guide" className={({ isActive }) => `navbar__link ${isActive ? 'navbar__link--active' : ''}`}>
            TV Guide
          </NavLink>
          <NavLink to="/favourites" className={({ isActive }) => `navbar__link ${isActive ? 'navbar__link--active' : ''}`}>
            Favourites
            {favCount > 0 && <span className="navbar__badge">{favCount}</span>}
          </NavLink>
        </div>

        <div className="navbar__actions">
          {loading && <span className="navbar__spinner" title="Loading catalogue…" />}
          <button
            className={`navbar__icon-btn navbar__icon-btn--translate ${translate ? 'navbar__icon-btn--active' : ''}`}
            onClick={() => setTranslationEnabled(!translate)}
            aria-pressed={translate}
            title={translate ? 'Showing English titles — click to show original' : 'Translate programme titles to English'}
            aria-label={translate ? 'Showing English titles' : 'Translate programme titles to English'}
          >
            <GlobeIcon />
          </button>
          <button
            className="navbar__icon-btn navbar__icon-btn--theme"
            onClick={toggleTheme}
            title={isDark ? 'Switch to Light mode' : 'Switch to Dark mode'}
            aria-label={isDark ? 'Switch to Light mode' : 'Switch to Dark mode'}
          >
            {isDark ? <SunIcon /> : <MoonIcon />}
          </button>
          <NavLink to="/settings" className="navbar__icon-btn navbar__icon-btn--settings" title="Settings" aria-label="Settings">
            <SettingsIcon />
          </NavLink>
        </div>
      </nav>

      {/* Mobile Bottom Navigation Bar (below medium — see src/styles/breakpoints.css) */}
      <nav className="mobile-nav glass" role="navigation" aria-label="Mobile navigation">
        <NavLink
          to="/"
          className={({ isActive }) => `mobile-nav__item ${isActive ? 'mobile-nav__item--active' : ''}`}
          end
        >
          <span className="mobile-nav__icon"><HomeIcon /></span>
          <span className="mobile-nav__label">Home</span>
        </NavLink>

        <NavLink
          to="/guide"
          className={({ isActive }) => `mobile-nav__item ${isActive ? 'mobile-nav__item--active' : ''}`}
        >
          <span className="mobile-nav__icon"><GuideIcon /></span>
          <span className="mobile-nav__label">TV Guide</span>
        </NavLink>

        <NavLink
          to="/favourites"
          className={({ isActive }) => `mobile-nav__item ${isActive ? 'mobile-nav__item--active' : ''}`}
        >
          <span className="mobile-nav__icon">
            <HeartIcon />
            {favCount > 0 && <span className="mobile-nav__badge">{favCount}</span>}
          </span>
          <span className="mobile-nav__label">Favourites</span>
        </NavLink>

        <NavLink
          to="/settings"
          className={({ isActive }) => `mobile-nav__item ${isActive ? 'mobile-nav__item--active' : ''}`}
        >
          <span className="mobile-nav__icon"><SettingsIcon /></span>
          <span className="mobile-nav__label">Settings</span>
        </NavLink>
      </nav>
    </>
  )
}
