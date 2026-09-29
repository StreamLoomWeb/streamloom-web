import { memo, useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { EnrichedChannel } from '../hooks/useChannels'
import { useEpg } from '../hooks/useChannels'
import { useMinuteClock } from '../hooks/useNowPlaying'
import { getNextProgram } from '../util/epgNow'
import { LOGO_SIZE, logoUrl, handleLogoError } from '../util/logo'
import { prefetchPlaylist } from '../util/playlistPrefetch'
import { toggleReminder, useReminders } from '../util/reminders'
import './StartingSoon.css'

/** A favourite's next programme is called "starting soon" within this window. */
const SOON_MS = 45 * 60 * 1000
/** Bounds the schedule reads this strip can cause: one per favourite shown. */
const MAX_CHANNELS = 8

interface ChipProps {
  channel: EnrichedChannel
  returnTo: string
}

const SoonChip = memo(function SoonChip({ channel, returnTo }: ChipProps) {
  const navigate = useNavigate()
  const now = useMinuteClock()
  const { programs } = useEpg(channel.id)
  const reminders = useReminders()
  const next = getNextProgram(programs, now)
  if (!next) return null
  const start = new Date(next.start_time).getTime()
  const mins = Math.max(1, Math.round((start - now) / 60_000))
  if (start - now > SOON_MS) return null

  const remind = reminders.some((r) => r.c === channel.id && r.s === start)
  const logo = logoUrl(channel.logo)
  return (
    <div className="soon-chip" role="listitem">
      <button
        type="button"
        className="soon-chip__main"
        onClick={() => {
          prefetchPlaylist(channel)
          navigate(`/watch/${encodeURIComponent(channel.id)}`, { state: { returnTo } })
        }}
      >
        {logo && (
          <img
            src={logo}
            alt=""
            width={LOGO_SIZE}
            height={LOGO_SIZE}
            loading="lazy"
            decoding="async"
            onError={handleLogoError}
            className="soon-chip__logo"
          />
        )}
        <span className="soon-chip__text">
          <span className="soon-chip__label">Starting soon · in {mins} min</span>
          <span className="soon-chip__title">
            {next.title} <span className="soon-chip__channel">on {channel.name}</span>
          </span>
        </span>
      </button>
      <button
        type="button"
        className={`soon-chip__bell ${remind ? 'soon-chip__bell--on' : ''}`}
        aria-pressed={remind}
        aria-label={remind ? `Remove reminder for ${next.title}` : `Remind me when ${next.title} starts`}
        title={remind ? 'Reminder set (while StreamLoom is open)' : 'Remind me while StreamLoom is open'}
        onClick={() => toggleReminder({ c: channel.id, n: channel.name, p: next.title, s: start })}
      >
        {remind ? '🔔' : '🔕'}
      </button>
    </div>
  )
})

/**
 * Chips for favourites whose next programme begins within the hour. Each chip fetches its
 * own schedule and renders nothing unless it qualifies, so the strip is empty (and hidden)
 * when nothing is starting. Reminders stay on this device and fire only while the app is open.
 */
export function StartingSoon({ channels, returnTo }: { channels: EnrichedChannel[]; returnTo: string }) {
  const shown = useMemo(() => channels.filter((c) => c.stream).slice(0, MAX_CHANNELS), [channels])
  if (!channels.length) {
    return (
      <p className="soon-teaser">
        <span aria-hidden="true">♥</span> Favourite a channel to get “starting soon” alerts and reminders.{' '}
        <Link to="/favourites">Your favourites</Link>
      </p>
    )
  }
  if (!shown.length) return null
  return (
    <div className="soon-strip" role="list" aria-label="Favourites starting soon">
      {shown.map((c) => (
        <SoonChip key={c.id} channel={c} returnTo={returnTo} />
      ))}
    </div>
  )
}
