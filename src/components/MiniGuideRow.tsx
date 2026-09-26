import { memo, useState } from 'react'
import type { EnrichedChannel } from '../hooks/useChannels'
import { useEpg } from '../hooks/useChannels'
import { useVisible } from '../hooks/useVisible'
import { getCurrentProgram, getNextProgram } from '../util/epgNow'
import { formatCountryDisplay } from '../util/country'
import { LOGO_SIZE, logoUrl, handleLogoError } from '../util/logo'

interface Props {
  channel: EnrichedChannel
  active: boolean
  /** Whether this channel has a published schedule at all — skips the fetch otherwise. */
  hasSchedule: boolean
  onPick: (channel: EnrichedChannel) => void
}

/**
 * One row of the player's mini-guide (S3): logo, name, and now/next when a
 * schedule exists. Its own component, not inlined in a `.map()`, because each
 * row needs its own visibility gate and its own `useEpg` fetch — one schedule
 * read per channel the viewer actually scrolls to, not the whole playlist.
 */
export const MiniGuideRow = memo(function MiniGuideRow({ channel, active, hasSchedule, onPick }: Props) {
  const [ref, visible] = useVisible<HTMLButtonElement>()
  const { programs } = useEpg(hasSchedule && visible ? channel.id : null)
  // The drawer is short-lived and opened on demand, so "now" is captured once per
  // mount rather than ticked — good enough for a row a viewer glances at and closes.
  const [now] = useState(() => Date.now())
  const nowPlaying = getCurrentProgram(programs, now)
  const nextProgram = nowPlaying ? getNextProgram(programs, now) : undefined
  const logoSrc = logoUrl(channel.logo)

  return (
    <button
      ref={ref}
      type="button"
      className={`player__drawer-item ${active ? 'player__drawer-item--active' : ''}`}
      onClick={() => onPick(channel)}
    >
      {logoSrc ? (
        <img
          src={logoSrc}
          alt={channel.name}
          width={LOGO_SIZE}
          height={LOGO_SIZE}
          loading="lazy"
          decoding="async"
          onError={handleLogoError}
          className="player__drawer-logo"
        />
      ) : (
        <div className="player__drawer-initials">{channel.name.slice(0, 2).toUpperCase()}</div>
      )}
      <div className="player__drawer-info">
        <span className="player__drawer-name">{channel.name}</span>
        {nowPlaying ? (
          <span className="player__drawer-epg">
            <span className="live-dot" />
            <span className="player__drawer-epg-text">{nowPlaying.title}</span>
            {nextProgram && <span className="player__drawer-next">Next: {nextProgram.title}</span>}
          </span>
        ) : channel.country ? (
          <span className="player__drawer-badge">{formatCountryDisplay(channel.country)}</span>
        ) : null}
      </div>
    </button>
  )
})
