import { NavLink } from 'react-router-dom'
import { useChannels, useFavourites } from '../hooks/useChannels'
import { useTheme } from '../hooks/useTheme'
import './Navbar.css'

export function Navbar() {
  const { loading, refresh } = useChannels()
  const { favouriteIds } = useFavourites()
  const { isDark, toggleTheme } = useTheme()
  const favCount = favouriteIds.size

  return (
    <>
      {/* Top Navbar for all screens */}
      <nav className="navbar glass" role="navigation" aria-label="Main navigation">
        <NavLink to="/" className="navbar__brand">
          <span className="navbar__logo-icon">▶</span>
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
            className="navbar__icon-btn navbar__icon-btn--theme"
            onClick={toggleTheme}
            title={isDark ? 'Switch to Light mode' : 'Switch to Dark mode'}
            aria-label={isDark ? 'Switch to Light mode' : 'Switch to Dark mode'}
          >
            {isDark ? '☀️' : '🌙'}
          </button>
          <button
            className="navbar__icon-btn"
            onClick={refresh}
            title="Refresh catalogue"
            aria-label="Refresh catalogue"
          >
            ↻
          </button>
          <NavLink to="/settings" className="navbar__icon-btn navbar__icon-btn--settings" title="Settings" aria-label="Settings">
            ⚙
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
          <span className="mobile-nav__icon">🏠</span>
          <span className="mobile-nav__label">Home</span>
        </NavLink>

        <NavLink
          to="/guide"
          className={({ isActive }) => `mobile-nav__item ${isActive ? 'mobile-nav__item--active' : ''}`}
        >
          <span className="mobile-nav__icon">📋</span>
          <span className="mobile-nav__label">TV Guide</span>
        </NavLink>

        <NavLink
          to="/favourites"
          className={({ isActive }) => `mobile-nav__item ${isActive ? 'mobile-nav__item--active' : ''}`}
        >
          <span className="mobile-nav__icon">
            ♥
            {favCount > 0 && <span className="mobile-nav__badge">{favCount}</span>}
          </span>
          <span className="mobile-nav__label">Favourites</span>
        </NavLink>

        <NavLink
          to="/settings"
          className={({ isActive }) => `mobile-nav__item ${isActive ? 'mobile-nav__item--active' : ''}`}
        >
          <span className="mobile-nav__icon">⚙</span>
          <span className="mobile-nav__label">Settings</span>
        </NavLink>
      </nav>
    </>
  )
}
