import { useState, useEffect, useMemo } from 'react'
import { useChannels, clearCatalogueCache } from '../hooks/useChannels'
import { useTheme } from '../hooks/useTheme'
import {
  getBrokenCount,
  clearBrokenStreams,
  clearWorkingStreams,
  isHideBrokenStreamsEnabled,
  setHideBrokenStreamsEnabled,
  isAutoSkipEnabled,
  setAutoSkipEnabled,
  getHiddenSet,
  unhideChannel,
  clearHiddenChannels,
  onStreamStateChange,
} from '../util/stream'
import './Settings.css'

export function Settings() {
  const { channels, allChannels, refresh } = useChannels()
  const { theme, preference, setTheme } = useTheme()
  const [lowLatency, setLowLatency] = useState(() => {
    return localStorage.getItem('sl_low_latency') !== 'false'
  })
  const [autoSkip, setAutoSkip] = useState(() => isAutoSkipEnabled())
  const [hideBroken, setHideBroken] = useState(() => isHideBrokenStreamsEnabled())
  const [brokenCount, setBrokenCount] = useState(() => getBrokenCount())
  const [hiddenIds, setHiddenIds] = useState(() => [...getHiddenSet()])
  const [clearedNotice, setClearedNotice] = useState(false)
  const [clearedBrokenNotice, setClearedBrokenNotice] = useState(false)
  const [clearedRecentNotice, setClearedRecentNotice] = useState(false)

  useEffect(() => {
    return onStreamStateChange(() => {
      setBrokenCount(getBrokenCount())
      setHiddenIds([...getHiddenSet()])
      setHideBroken(isHideBrokenStreamsEnabled())
      setAutoSkip(isAutoSkipEnabled())
    })
  }, [])

  // Channel names come from the unfiltered catalogue, since hidden ones are not in `channels`.
  const hiddenNames = useMemo(() => {
    const wanted = new Set(hiddenIds)
    return new Map((allChannels ?? []).filter((c) => wanted.has(c.id)).map((c) => [c.id, c.name]))
  }, [allChannels, hiddenIds])

  const handleLowLatencyChange = (enabled: boolean) => {
    setLowLatency(enabled)
    localStorage.setItem('sl_low_latency', enabled ? 'true' : 'false')
  }

  const handleAutoSkipChange = (enabled: boolean) => {
    setAutoSkip(enabled)
    setAutoSkipEnabled(enabled)
  }

  const handleHideBrokenChange = (enabled: boolean) => {
    setHideBroken(enabled)
    setHideBrokenStreamsEnabled(enabled)
  }

  const handleClearBrokenStreams = () => {
    clearBrokenStreams()
    setBrokenCount(0)
    setClearedBrokenNotice(true)
    setTimeout(() => {
      setClearedBrokenNotice(false)
    }, 1500)
  }

  const handleClearCache = () => {
    if (!window.confirm('Clear the cached catalogue and stream health records? This does not touch your Continue Watching history or favourites.')) {
      return
    }
    try {
      // The catalogue lives in IndexedDB now, so clear that too. Continue
      // Watching (sl_recent_v1) is a separate, user-visible history — it has
      // its own button below and is never touched by this one.
      clearCatalogueCache()
      localStorage.removeItem('sl_catalogue_v5')
      localStorage.removeItem('sl_catalogue_v4')
      localStorage.removeItem('sl_catalogue_v3')
      localStorage.removeItem('sl_catalogue_v2')
      sessionStorage.removeItem('sl_active_playlist')
      clearWorkingStreams()
      setClearedNotice(true)
      setTimeout(() => {
        setClearedNotice(false)
        refresh()
      }, 1500)
    } catch {
      // ignore
    }
  }

  const handleClearRecent = () => {
    if (!window.confirm('Clear your Continue Watching history? This cannot be undone.')) {
      return
    }
    try {
      localStorage.removeItem('sl_recent_v1')
      setClearedRecentNotice(true)
      setTimeout(() => {
        setClearedRecentNotice(false)
        refresh()
      }, 1500)
    } catch {
      // ignore
    }
  }

  return (
    <div className="page-wrapper settings-page">
      <div className="settings-page__header">
        <h1 className="settings-page__title">Settings</h1>
        <p className="settings-page__subtitle">Playback preferences, storage management, and shortcuts</p>
      </div>

      <div className="settings-grid">
        {/* Appearance & Theme Section */}
        <section className="settings-card glass">
          <div className="settings-card__header">
            <span className="settings-card__icon">🎨</span>
            <div>
              <h3>Appearance & Theme</h3>
              <p>Personalize your visual experience with curated luxury palettes</p>
            </div>
          </div>
          <div className="settings-card__body">
            <div className="settings-item settings-item--theme">
              <div className="settings-item__info">
                <strong>Color Palette</strong>
                <span>
                  {preference === 'system'
                    ? `Follows your device (currently ${theme === 'dark' ? 'Agate Black' : 'Alabaster Silk'})`
                    : theme === 'dark'
                      ? 'Agate Black (Deep sleek onyx & graphite styling)'
                      : 'Alabaster Silk (Warm cashmere light background with crisp typography)'}
                </span>
              </div>
              <div className="theme-toggle-group" role="radiogroup" aria-label="Theme selection">
                <button
                  type="button"
                  role="radio"
                  aria-checked={preference === 'system'}
                  className={`theme-toggle-btn ${preference === 'system' ? 'theme-toggle-btn--active' : ''}`}
                  onClick={() => setTheme('system')}
                >
                  <span className="theme-toggle-btn__icon">🖥️</span>
                  <span className="theme-toggle-btn__label">System</span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={preference === 'dark'}
                  className={`theme-toggle-btn ${preference === 'dark' ? 'theme-toggle-btn--active' : ''}`}
                  onClick={() => setTheme('dark')}
                >
                  <span className="theme-toggle-btn__icon">🌙</span>
                  <span className="theme-toggle-btn__label">Dark</span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={preference === 'light'}
                  className={`theme-toggle-btn ${preference === 'light' ? 'theme-toggle-btn--active' : ''}`}
                  onClick={() => setTheme('light')}
                >
                  <span className="theme-toggle-btn__icon">☀️</span>
                  <span className="theme-toggle-btn__label">Light</span>
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* Playback Section */}
        <section className="settings-card glass">
          <div className="settings-card__header">
            <span className="settings-card__icon">🎬</span>
            <div>
              <h3>Playback Engine & Resiliency</h3>
              <p>Fine-tune live video buffer, latency profile, and auto-failover</p>
            </div>
          </div>
          <div className="settings-card__body">
            <div className="settings-item">
              <div className="settings-item__info">
                <strong>Ultra-Low Latency Mode</strong>
                <span>Synchronize directly with live edge broadcasts for minimal delay</span>
              </div>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={lowLatency}
                  onChange={(e) => handleLowLatencyChange(e.target.checked)}
                  aria-label="Ultra-Low Latency Mode"
                />
                <span className="toggle-slider" />
              </label>
            </div>

            <div className="settings-item">
              <div className="settings-item__info">
                <strong>Auto-Skip Unavailable Channels</strong>
                <span>Seamlessly advance to next channel if a stream errors or times out</span>
              </div>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={autoSkip}
                  onChange={(e) => handleAutoSkipChange(e.target.checked)}
                  aria-label="Auto-Skip Unavailable Channels"
                />
                <span className="toggle-slider" />
              </label>
            </div>

            <div className="settings-item">
              <div className="settings-item__info">
                <strong>Hide Failed Channels</strong>
                <span>Exclude channels whose streams fail to load from the guide, home grid, and channel lists</span>
              </div>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={hideBroken}
                  onChange={(e) => handleHideBrokenChange(e.target.checked)}
                  aria-label="Hide Failed Channels"
                />
                <span className="toggle-slider" />
              </label>
            </div>
          </div>
        </section>

        {/* Cache & Storage Section */}
        <section className="settings-card glass">
          <div className="settings-card__header">
            <span className="settings-card__icon">💾</span>
            <div>
              <h3>Storage & Resilience Cache</h3>
              <p>Manage locally cached channels and stream health records</p>
            </div>
          </div>
          <div className="settings-card__body">
            <div className="settings-item">
              <div className="settings-item__info">
                <strong>Cached Channels</strong>
                <span>
                  {channels.length} {allChannels && allChannels.length !== channels.length ? `visible (${allChannels.length} total)` : 'channels'} indexed locally
                </span>
              </div>
              <button
                className="settings-btn settings-btn--danger"
                onClick={handleClearCache}
                disabled={clearedNotice}
              >
                {clearedNotice ? 'Cleared!' : 'Clear Cache'}
              </button>
            </div>

            <div className="settings-item">
              <div className="settings-item__info">
                <strong>Continue Watching History</strong>
                <span>Channels remembered for the Continue Watching row on Home</span>
              </div>
              <button
                className="settings-btn settings-btn--danger"
                onClick={handleClearRecent}
                disabled={clearedRecentNotice}
              >
                {clearedRecentNotice ? 'Cleared!' : 'Clear History'}
              </button>
            </div>

            <div className="settings-item settings-item--stacked">
              <div className="settings-item__row">
                <div className="settings-item__info">
                  <strong>Hidden Channels</strong>
                  <span>
                    {hiddenIds.length === 0
                      ? 'None. Hide a channel from the player to remove it from every list.'
                      : `${hiddenIds.length} hidden by you, always kept out of lists`}
                  </span>
                </div>
                <button
                  className="settings-btn"
                  onClick={clearHiddenChannels}
                  disabled={hiddenIds.length === 0}
                >
                  Restore All
                </button>
              </div>
              {hiddenIds.length > 0 && (
                <ul className="settings-hidden-list">
                  {hiddenIds.map((id) => (
                    <li key={id} className="settings-hidden-list__item">
                      <span>{hiddenNames.get(id) ?? id}</span>
                      <button
                        className="settings-btn settings-btn--sm"
                        onClick={() => unhideChannel(id)}
                        aria-label={`Restore ${hiddenNames.get(id) ?? id}`}
                      >
                        Restore
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="settings-item">
              <div className="settings-item__info">
                <strong>Unavailable Channels Log</strong>
                <span>
                  {brokenCount} unresponsive {brokenCount === 1 ? 'channel' : 'channels'} flagged {hideBroken ? '(hidden from lists)' : '(shown in lists)'}
                </span>
              </div>
              <button
                className="settings-btn"
                onClick={handleClearBrokenStreams}
                disabled={clearedBrokenNotice || brokenCount === 0}
              >
                {clearedBrokenNotice ? 'Reset!' : 'Reset Log'}
              </button>
            </div>
          </div>
        </section>

        {/* Keyboard & Remote Controls Section */}
        <section className="settings-card glass">
          <div className="settings-card__header">
            <span className="settings-card__icon">⌨️</span>
            <div>
              <h3>Keyboard & Remote Shortcuts</h3>
              <p>Effortless navigation for desktop, trackpad, and TV remotes</p>
            </div>
          </div>
          <div className="settings-card__body">
            <div className="shortcut-list">
              <div className="shortcut-item">
                <kbd>←</kbd> <kbd>→</kbd>
                <span>Navigate Channels in Grid / Row</span>
              </div>
              <div className="shortcut-item">
                <kbd>↑</kbd> <kbd>↓</kbd>
                <span>Switch Rows / Categories</span>
              </div>
              <div className="shortcut-item">
                <kbd>[</kbd> <kbd>]</kbd>
                <span>Previous / Next Channel in Player</span>
              </div>
              <div className="shortcut-item">
                <kbd>Enter</kbd>
                <span>Play Selected Channel</span>
              </div>
              <div className="shortcut-item">
                <kbd>/</kbd>
                <span>Quick Focus Search</span>
              </div>
              <div className="shortcut-item">
                <kbd>Space</kbd>
                <span>Play / Pause</span>
              </div>
              <div className="shortcut-item">
                <kbd>F</kbd>
                <span>Toggle Fullscreen</span>
              </div>
              <div className="shortcut-item">
                <kbd>M</kbd>
                <span>Toggle Mute</span>
              </div>
              <div className="shortcut-item">
                <kbd>C</kbd>
                <span>Toggle Subtitles</span>
              </div>
              <div className="shortcut-item">
                <kbd>A</kbd>
                <span>Cycle Audio Track</span>
              </div>
              <div className="shortcut-item">
                <kbd>Esc</kbd>
                <span>Clear Filters / Back</span>
              </div>
            </div>
          </div>
        </section>

        {/* About Section */}
        <section className="settings-card glass">
          <div className="settings-card__header">
            <span className="settings-card__icon">👤</span>
            <div>
              <h3>About</h3>
              <p>Application and creator information</p>
            </div>
          </div>
          <div className="settings-card__body">
            <div className="about-details">
              <p style={{ fontSize: '1.05rem' }}>
                <strong>Author:</strong>{' '}
                <a
                  href="https://www.linkedin.com/in/surajchavda/"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    color: 'var(--accent)',
                    fontWeight: 700,
                    textDecoration: 'underline',
                    textUnderlineOffset: '3px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  Suraj Chavda ↗
                </a>
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
