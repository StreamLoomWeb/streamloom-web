import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import type { EnrichedChannel } from '../hooks/useChannels'
import { formatCountryDisplay } from '../util/country'
import { LOGO_SIZE, logoUrl, handleLogoError } from '../util/logo'
import { prefetchPlaylist } from '../util/playlistPrefetch'
import { prefersReducedMotion } from '../util/motion'
import './HeroSection.css'

interface Props {
  channels: EnrichedChannel[]
}

export function HeroSection({ channels }: Props) {
  const navigate = useNavigate()
  const [index, setIndex] = useState(0)
  // Auto-advancing content needs a way to stop it (vestibular safety); start
  // stopped for anyone who has already told the OS they don't want motion.
  const [isPaused, setIsPaused] = useState(prefersReducedMotion)

  // Rotate every 8 seconds across top 5 channels with streams & logos
  const heroChannels = channels.filter((c) => c.stream && logoUrl(c.logo)).slice(0, 5)

  useEffect(() => {
    if (heroChannels.length <= 1 || isPaused) return
    const id = setInterval(() => {
      setIndex((i) => (i + 1) % heroChannels.length)
    }, 8000)
    return () => clearInterval(id)
  }, [heroChannels.length, isPaused])

  const featured = heroChannels[index]
  if (!featured) return null

  const countryDisplay = formatCountryDisplay(featured.country)
  const logoSrc = logoUrl(featured.logo)!

  return (
    <section className="hero noise">
      {/*
        Blurred backdrop rendered as a real <img> rather than a background-image,
        so it rides the same 128px CDN object (scaled + blurred in CSS) and gets a
        decoding hint. Above the fold and decorative, hence alt="" and eager load.
      */}
      <img
        src={logoSrc}
        alt=""
        aria-hidden="true"
        width={LOGO_SIZE}
        height={LOGO_SIZE}
        decoding="async"
        onError={handleLogoError}
        className="hero__bg"
      />
      <div className="hero__overlay" />

      <div className="hero__content fade-up" key={featured.id}>
        <div className="hero__logo-wrap">
          <img
            src={logoSrc}
            alt={featured.name}
            width={LOGO_SIZE}
            height={LOGO_SIZE}
            decoding="async"
            onError={handleLogoError}
            className="hero__logo"
          />
        </div>
        <h1 className="hero__name">{featured.name}</h1>
        {countryDisplay && (
          <p className="hero__meta">
            <span className="hero__badge">{countryDisplay}</span>
          </p>
        )}
        <div className="hero__actions">
          <button
            className="hero__btn hero__btn--primary"
            onClick={() => {
              prefetchPlaylist(featured)
              sessionStorage.setItem('sl_last_viewed', featured.id)
              try {
                sessionStorage.removeItem('sl_active_playlist')
              } catch {}
              navigate(`/watch/${encodeURIComponent(featured.id)}`, {
                state: {
                  returnTo: '/',
                },
              })
            }}
          >
            ▶ Watch Now
          </button>
          <button
            className="hero__btn hero__btn--secondary"
            onClick={() => navigate('/guide')}
          >
            ≡ TV Guide
          </button>
        </div>
      </div>

      {/* Dots indicator */}
      <div className="hero__dots">
        {heroChannels.length > 1 && (
          <button
            className="hero__pause"
            onClick={() => setIsPaused((p) => !p)}
            aria-label={isPaused ? 'Resume auto-rotating' : 'Pause auto-rotating'}
            title={isPaused ? 'Resume' : 'Pause'}
          >
            {isPaused ? '▶' : '⏸'}
          </button>
        )}
        {heroChannels.map((_, i) => (
          <button
            key={i}
            className={`hero__dot ${i === index ? 'hero__dot--active' : ''}`}
            onClick={() => setIndex(i)}
            aria-label={`Show channel ${i + 1}`}
          />
        ))}
      </div>
    </section>
  )
}
