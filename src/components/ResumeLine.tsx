import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { EnrichedChannel } from '../hooks/useChannels'
import { useNowPlaying } from '../hooks/useNowPlaying'
import { getLastWatch, type LastWatch } from '../util/watchHistory'
import { prefetchPlaylist } from '../util/playlistPrefetch'
import './ResumeLine.css'

const WINDOW_MS = 6 * 60 * 60 * 1000

/**
 * What was on when the app was opened, read once at module load: a cold start within six hours
 * of the last play. Later visits to Home in the same session never see it, and it never
 * autoplays; it is one line the viewer may act on or dismiss.
 */
const coldStart: LastWatch | null = (() => {
  const last = getLastWatch()
  return last && Date.now() - last.t < WINDOW_MS ? last : null
})()
let dismissed = false

export function ResumeLine({ channels }: { channels: EnrichedChannel[] }) {
  const navigate = useNavigate()
  const [, rerender] = useState(0)
  const channel = coldStart ? channels.find((c) => c.id === coldStart.id && c.stream) : undefined
  // Already watched something since this page loaded: the line is stale.
  const stale = coldStart !== null && getLastWatch()?.t !== coldStart.t
  const { program } = useNowPlaying(channel && !dismissed && !stale ? channel.id : null)

  if (!channel || dismissed || stale) return null
  return (
    <div className="resume-line" role="region" aria-label="Pick up where you left off">
      <button
        type="button"
        className="resume-line__go"
        onClick={() => {
          prefetchPlaylist(channel)
          navigate(`/watch/${encodeURIComponent(channel.id)}`, { state: { returnTo: '/' } })
        }}
      >
        <span className="resume-line__play" aria-hidden="true">▶</span>
        <span className="resume-line__text">
          Back to {channel.name}
          {program ? ` — now: ${program.title}` : ''}
        </span>
      </button>
      <button
        type="button"
        className="resume-line__x"
        aria-label="Dismiss"
        onClick={() => {
          dismissed = true
          rerender((n) => n + 1)
        }}
      >
        ✕
      </button>
    </div>
  )
}
