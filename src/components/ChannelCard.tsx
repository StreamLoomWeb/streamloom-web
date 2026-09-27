import { useCallback, useEffect, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import type { EnrichedChannel } from '../hooks/useChannels'
import { useFavourites } from '../hooks/useChannels'
import { useNowPlaying } from '../hooks/useNowPlaying'
import { useVisible } from '../hooks/useVisible'
import { programProgress } from '../util/epgNow'
import { formatCountryDisplay } from '../util/country'
import { getLanguageName } from '../util/language'
import { LOGO_SIZE, logoUrl, handleLogoError } from '../util/logo'
import { preconnectChannel } from '../util/preconnect'
import { prefetchPlaylist } from '../util/playlistPrefetch'
import { navigateWithLogoTransition } from '../util/viewTransition'
import './ChannelCard.css'

interface Props {
  channel: EnrichedChannel
  /** Channel ids with a published schedule (epg/ids.json). Gates the now-playing fetch. */
  epgChannelIds?: Set<string>
  size?: 'small' | 'medium' | 'large'
  onWatch?: (channelId: string) => void
  playlist?: string[]
}

export function ChannelCard({ channel, epgChannelIds, size = 'medium', onWatch, playlist }: Props) {
  const navigate = useNavigate()
  const location = useLocation()
  const { isFavourite, toggle } = useFavourites()
  const [visibleRef, visible] = useVisible<HTMLElement>()
  const hasSchedule = epgChannelIds?.has(channel.id) ?? false
  const { program: nowPlaying, now } = useNowPlaying(hasSchedule && visible ? channel.id : null)
  const progress = nowPlaying ? programProgress(nowPlaying, now) : null

  const hasStream = !!channel.stream
  const fav = isFavourite(channel.id)
  const logoRef = useRef<HTMLImageElement | null>(null)

  const handleClick = useCallback(() => {
    if (!hasStream) return
    prefetchPlaylist(channel)
    onWatch?.(channel.id)
    sessionStorage.setItem('sl_last_viewed', channel.id)
    const returnPath = location.pathname + location.search
    sessionStorage.setItem('sl_return_to', returnPath)
    const hasMultipleInPlaylist = Boolean(playlist && playlist.length > 1)
    if (hasMultipleInPlaylist) {
      try {
        sessionStorage.setItem('sl_active_playlist', JSON.stringify(playlist))
      } catch {}
    } else {
      try {
        sessionStorage.removeItem('sl_active_playlist')
      } catch {}
    }
    navigateWithLogoTransition(logoRef.current, () =>
      navigate(`/watch/${encodeURIComponent(channel.id)}`, {
        state: {
          playlist: hasMultipleInPlaylist ? playlist : undefined,
          returnTo: returnPath,
        },
      }),
    )
  }, [hasStream, channel, playlist, location.pathname, location.search, navigate, onWatch])

  // A short dwell, so a D-pad sweep along a row does not open a socket per card passed.
  const warmTimer = useRef<number | null>(null)
  const warm = useCallback(() => {
    if (!hasStream || warmTimer.current) return
    warmTimer.current = window.setTimeout(() => {
      warmTimer.current = null
      preconnectChannel(channel)
    }, 150)
  }, [hasStream, channel])
  const unwarm = useCallback(() => {
    if (warmTimer.current) window.clearTimeout(warmTimer.current)
    warmTimer.current = null
  }, [])
  useEffect(() => unwarm, [unwarm])

  const handleFav = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    toggle(channel.id)
  }, [channel.id, toggle])

  const countryDisplay = formatCountryDisplay(channel.country)
  const languageDisplay = channel.languages?.[0] ? getLanguageName(channel.languages[0]) : null
  const fallbackDisplay = [languageDisplay, countryDisplay].filter(Boolean).join(' · ')
  const logoSrc = logoUrl(channel.logo)

  return (
    <article
      ref={visibleRef}
      className={`channel-card channel-card--${size} ${!hasStream ? 'channel-card--no-stream' : ''}`}
      data-card="channel"
      data-channel-id={channel.id}
    >
      {/* The playable surface is its own button: a <button> can't legally
          contain the favourite <button> below it, and AT users would land on
          two overlapping interactive targets with no clear order. */}
      <button
        type="button"
        className="channel-card__surface"
        onClick={handleClick}
        onFocus={warm}
        onPointerEnter={warm}
        onBlur={unwarm}
        onPointerLeave={unwarm}
        disabled={!hasStream}
        aria-label={`Play ${channel.name}`}
      >
        <div className="channel-card__thumb">
          {logoSrc ? (
            <img
              ref={logoRef}
              src={logoSrc}
              alt={channel.name}
              width={LOGO_SIZE}
              height={LOGO_SIZE}
              loading="lazy"
              decoding="async"
              onError={handleLogoError}
            />
          ) : (
            <span className="channel-card__initials">
              {channel.name.slice(0, 2).toUpperCase()}
            </span>
          )}
          {hasStream && <div className="channel-card__play-overlay">▶</div>}

          {/* Quality badge */}
          {channel.stream?.quality && channel.stream.quality !== '' && (
            <span className="channel-card__quality">{channel.stream.quality.toUpperCase()}</span>
          )}
        </div>

        <div className="channel-card__info">
          <p className="channel-card__name" title={channel.name}>{channel.name}</p>
          {nowPlaying ? (
            <>
              <p className="channel-card__epg" title={nowPlaying.title}>
                <span className="live-dot" style={{ marginRight: 6 }} />
                <span className="channel-card__epg-text">{nowPlaying.title}</span>
              </p>
              {progress !== null && (
                <div className="channel-card__progress" aria-hidden="true">
                  <div className="channel-card__progress-fill" style={{ width: `${progress * 100}%` }} />
                </div>
              )}
            </>
          ) : fallbackDisplay ? (
            <p className="channel-card__country" title={fallbackDisplay}>{fallbackDisplay}</p>
          ) : null}
        </div>
      </button>

      {/* Favourite button: a sibling of the surface, not nested in it. */}
      <button
        className={`channel-card__fav ${fav ? 'channel-card__fav--active' : ''}`}
        onClick={handleFav}
        aria-label={fav ? 'Remove from favourites' : 'Add to favourites'}
        title={fav ? 'Remove favourite' : 'Add to favourites'}
      >
        {fav ? '♥' : '♡'}
      </button>
    </article>
  )
}
