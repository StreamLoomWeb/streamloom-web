import { memo, useEffect, useRef, useState } from 'react'
import type { EnrichedChannel } from '../hooks/useChannels'
import { useEpg } from '../hooks/useChannels'
import { useVisible } from '../hooks/useVisible'
import { getCurrentProgram, getNextProgram } from '../util/epgNow'
import { formatCountryDisplay } from '../util/country'
import { LOGO_SIZE, logoUrl, handleLogoError } from '../util/logo'
import { getTranslation, requestTranslations, useTranslateEnabled } from '../util/translate'

interface Props {
  channel: EnrichedChannel
  active: boolean
  /** Whether this channel has a published schedule at all — skips the fetch otherwise. */
  hasSchedule: boolean
  onPick: (channel: EnrichedChannel) => void
  /** Fired once focus or hover has rested on this row for `DWELL_MS`. */
  onDwell?: (channel: EnrichedChannel) => void
  /** Focus or hover left this row. */
  onDwellEnd?: () => void
}

/** How long a row must be rested on before its preview shows. */
const DWELL_MS = 800

/**
 * One row of the player's mini-guide (S3): logo, name, and now/next when a
 * schedule exists. Its own component, not inlined in a `.map()`, because each
 * row needs its own visibility gate and its own `useEpg` fetch — one schedule
 * read per channel the viewer actually scrolls to, not the whole playlist.
 */
export const MiniGuideRow = memo(function MiniGuideRow({ channel, active, hasSchedule, onPick, onDwell, onDwellEnd }: Props) {
  const dwellTimer = useRef<number | null>(null)
  const startDwell = () => {
    if (!onDwell || dwellTimer.current !== null) return
    dwellTimer.current = window.setTimeout(() => {
      dwellTimer.current = null
      onDwell(channel)
    }, DWELL_MS)
  }
  const endDwell = () => {
    if (dwellTimer.current !== null) window.clearTimeout(dwellTimer.current)
    dwellTimer.current = null
    onDwellEnd?.()
  }
  useEffect(() => () => { if (dwellTimer.current !== null) window.clearTimeout(dwellTimer.current) }, [])

  const [ref, visible] = useVisible<HTMLButtonElement>()
  const { programs } = useEpg(hasSchedule && visible ? channel.id : null)
  // The drawer is short-lived and opened on demand, so "now" is captured once per
  // mount rather than ticked — good enough for a row a viewer glances at and closes.
  const [now] = useState(() => Date.now())
  const nowPlaying = getCurrentProgram(programs, now)
  const nextProgram = nowPlaying ? getNextProgram(programs, now) : undefined
  const logoSrc = logoUrl(channel.logo)

  const translate = useTranslateEnabled()
  useEffect(() => {
    if (!translate) return
    const titles = [nowPlaying?.title, nextProgram?.title].filter((t): t is string => !!t)
    if (titles.length > 0) requestTranslations(titles)
  }, [translate, nowPlaying, nextProgram])
  const nowTitle = nowPlaying ? (translate && getTranslation(nowPlaying.title)) || nowPlaying.title : null
  const nextTitle = nextProgram ? (translate && getTranslation(nextProgram.title)) || nextProgram.title : null

  return (
    <button
      ref={ref}
      type="button"
      className={`player__drawer-item ${active ? 'player__drawer-item--active' : ''}`}
      onClick={() => onPick(channel)}
      onFocus={startDwell}
      onBlur={endDwell}
      onMouseEnter={startDwell}
      onMouseLeave={endDwell}
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
            <span className="player__drawer-epg-text">{nowTitle}</span>
            {nextProgram && <span className="player__drawer-next">Next: {nextTitle}</span>}
          </span>
        ) : channel.country ? (
          <span className="player__drawer-badge">{formatCountryDisplay(channel.country)}</span>
        ) : null}
      </div>
    </button>
  )
})
