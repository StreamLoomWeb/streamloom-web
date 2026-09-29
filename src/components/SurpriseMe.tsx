import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useChannels } from '../hooks/useChannels'
import { pickSurprise } from '../util/surprise'
import { prefersReducedMotion } from '../util/motion'
import { prefetchPlaylist } from '../util/playlistPrefetch'
import { FixerBotMascot } from './FixerBotMascot'
import './SurpriseMe.css'

const SPIN_MS = 1100
/** Reduced motion gets a still frame for just long enough to read the caption. */
const SPIN_REDUCED_MS = 450

/**
 * "Surprise me": picks a random live channel weighted to what this device has watched,
 * shows FixerBot's short spin, then opens it. Returns the trigger and the overlay to render.
 * Works from the nav button and the `*` key (where no text field has focus).
 */
export function useSurprise() {
  const { allChannels, channels } = useChannels()
  const navigate = useNavigate()
  const location = useLocation()
  const [spinning, setSpinning] = useState(false)
  const timer = useRef<number | null>(null)
  const busy = useRef(false)

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current)
    },
    [],
  )

  const surprise = useCallback(() => {
    if (busy.current) return
    const pick = pickSurprise(allChannels?.length ? allChannels : channels)
    if (!pick) return
    busy.current = true
    setSpinning(true)
    prefetchPlaylist(pick)
    timer.current = window.setTimeout(() => {
      busy.current = false
      setSpinning(false)
      navigate(`/watch/${encodeURIComponent(pick.id)}`, {
        state: { returnTo: location.pathname + location.search },
      })
    }, prefersReducedMotion() ? SPIN_REDUCED_MS : SPIN_MS)
  }, [allChannels, channels, navigate, location.pathname, location.search])

  const overlay = spinning ? (
    <div className="surprise" role="status" aria-live="polite">
      <div className="surprise__bot" aria-hidden="true">
        <FixerBotMascot />
      </div>
      <p className="surprise__caption">Finding something for you…</p>
    </div>
  ) : null

  return { surprise, overlay, spinning }
}

/** True for a keydown that should trigger Surprise me: `*` with no text field focused. */
export function isSurpriseKey(e: KeyboardEvent): boolean {
  if (e.key !== '*' || e.ctrlKey || e.metaKey || e.altKey) return false
  const tag = (e.target as HTMLElement | null)?.tagName
  return tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT'
}
