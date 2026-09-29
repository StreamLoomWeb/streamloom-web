import { SHORTCUT_GROUPS, openShortcuts } from '../util/shortcutList'
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
import { isOptedOut, setOptedOut } from '../telemetry/telemetry'
import './Settings.css'

export function Settings() {
  const { channels, allChannels, refresh } = useChannels()
  const { theme, preference, setTheme } = useTheme()
  const [lowLatency, setLowLatency] = useState(() => {
    return localStorage.getItem('sl_low_latency') !== 'false'
  })
  const [autoSkip, setAutoSkip] = useState(() => isAutoSkipEnabled())
  const [hideBroken, setHideBroken] = useState(() => isHideBrokenStreamsEnabled())
  const [shareStats, setShareStats] = useState(() => !isOptedOut())
  const [brokenCount, setBrokenCount] = useState(() => getBrokenCount())
  const [hiddenIds, setHiddenIds] = useState(() => [...getHiddenSet()])
  const [clearedNotice, setClearedNotice] = useState(false)
  // Inline confirmation for the two destructive buttons (no blocking window.confirm: it is
  // unreachable with a TV remote and jarring on touch).
  const [pendingConfirm, setPendingConfirm] = useState<'cache' | 'recent' | null>(null)
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

  const handleShareStatsChange = (enabled: boolean) => {
    setShareStats(enabled)
    setOptedOut(!enabled)
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
    setPendingConfirm(null)
    try {
      // The catalogue lives in IndexedDB now, so clear that too. Continue
      // Watching (sl_recent_v2) is a separate, user-visible history — it has
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
    setPendingConfirm(null)
    try {
      localStorage.removeItem('sl_recent_v1')
      localStorage.removeItem('sl_recent_v2')
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
                <strong>Refresh Catalogue</strong>
                <span>Fetch the latest channel list now</span>
              </div>
              <button className="settings-btn" onClick={refresh}>
                Refresh
              </button>
            </div>

            <div className="settings-item">
              <div className="settings-item__info">
                <strong>Cached Channels</strong>
                <span>
                  {channels.length} {allChannels && allChannels.length !== channels.length ? `visible (${allChannels.length} total)` : 'channels'} indexed locally
                </span>
              </div>
              {pendingConfirm === 'cache' ? (
                <div className="settings-confirm" role="alertdialog" aria-label="Yes, clear cache">
                  <span className="settings-confirm__text">Clear the cached catalogue and stream health? Favourites and Jump back in stay.</span>
                  <button className="settings-btn settings-btn--danger" onClick={handleClearCache} autoFocus>
                    Yes, clear cache
                  </button>
                  <button className="settings-btn" onClick={() => setPendingConfirm(null)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  className="settings-btn settings-btn--danger"
                  onClick={() => setPendingConfirm('cache')}
                  disabled={clearedNotice}
                >
                  {clearedNotice ? 'Cleared!' : 'Clear Cache'}
                </button>
              )}
            </div>

            <div className="settings-item">
              <div className="settings-item__info">
                <strong>Jump back in History</strong>
                <span>Channels remembered for the Jump back in row on Home</span>
              </div>
              {pendingConfirm === 'recent' ? (
                <div className="settings-confirm" role="alertdialog" aria-label="Yes, clear history">
                  <span className="settings-confirm__text">Clear Jump back in history? This cannot be undone.</span>
                  <button className="settings-btn settings-btn--danger" onClick={handleClearRecent} autoFocus>
                    Yes, clear history
                  </button>
                  <button className="settings-btn" onClick={() => setPendingConfirm(null)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  className="settings-btn settings-btn--danger"
                  onClick={() => setPendingConfirm('recent')}
                  disabled={clearedRecentNotice}
                >
                  {clearedRecentNotice ? 'Cleared!' : 'Clear History'}
                </button>
              )}
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
              <p>
                Effortless navigation for desktop, trackpad, and TV remotes. Press{' '}
                <button type="button" className="settings-btn" onClick={openShortcuts}>?</button>{' '}
                anywhere for this list.
              </p>
            </div>
          </div>
          <div className="settings-card__body">
            <div className="shortcut-list">
            {SHORTCUT_GROUPS.flatMap((g) => g.items).map((it) => (
              <div className="shortcut-item" key={it.label}>
                {it.keys.map((k) => (
                  <kbd key={k}>{k}</kbd>
                ))}
                <span>{it.label}</span>
              </div>
            ))}
            </div>
          </div>
        </section>

        {/* About Section */}
        {/* Privacy & usage statistics (ADR-0032, ADR-0047) */}
        <section className="settings-card glass" data-testid="privacy-card">
          <div className="settings-card__header">
            <span className="settings-card__icon">🛡️</span>
            <div>
              <h3>Privacy & Usage Statistics</h3>
              <p>What StreamLoom counts, what it never collects, and how to turn it off</p>
            </div>
          </div>
          <div className="settings-card__body">
            <div className="settings-item">
              <div className="settings-item__info">
                <strong>Share anonymous usage statistics</strong>
                <span>
                  Aggregate counts only — how many times the app was opened, a channel played or
                  failed, how fast video started. No identifier of any kind. Off means nothing is
                  sent at all.
                </span>
              </div>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={shareStats}
                  onChange={(e) => handleShareStatsChange(e.target.checked)}
                  aria-label="Share anonymous usage statistics"
                />
                <span className="toggle-slider" />
              </label>
            </div>
            <div className="settings-item settings-item--stacked">
              <div className="settings-item__info privacy-text">
                <strong>What is collected</strong>
                <span>
                  Counts, in batches, with no way to tell one person from another: app opens (with a
                  flag for the first open of the day, week or month, so users can be counted without
                  naming any); a channel played, stopped or failed and which of its public streams
                  it was; how long a channel was watched, as a range; whether a search found
                  nothing; how long the catalogue, the guide and video took to appear, as ranges;
                  and the country and region the request came from, derived at the edge and
                  shown only when at least 20 people opened the app there that day.
                </span>
                <strong>What is never collected</strong>
                <span>
                  An IP address, a user agent, a referrer, a cookie, an install or session id, a
                  hash of any of those, the text of a search, a timestamp from this device, your
                  favourites, your history, or anything you type. There is no third-party
                  analytics and no account.
                </span>
                <strong>How to opt out</strong>
                <span>
                  Turn the switch above off; the choice is kept on this device and nothing is sent
                  while it is off. A browser that sends Global Privacy Control or Do Not Track is
                  honoured automatically, at the server as well as here, with nothing written.
                </span>
                <span>
                  <a
                    href="https://github.com/StreamLoomAndroid/streamloom-android/blob/main/docs/PRIVACY_POLICY.md"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="privacy-link"
                  >
                    Read the full privacy policy ↗
                  </a>
                </span>
              </div>
            </div>
          </div>
        </section>

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
