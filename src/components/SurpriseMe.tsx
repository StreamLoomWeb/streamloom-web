import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useChannels } from '../hooks/useChannels'
import { bestCachedWorking, pickSurprise } from '../util/surprise'
import { fetchEdgeVerifiedStreams, getWorkingMapSnapshot } from '../util/stream'
import type { EnrichedChannel } from '../hooks/useChannels'
import { prefersReducedMotion } from '../util/motion'
import { prefetchPlaylist } from '../util/playlistPrefetch'
import { FixerBotMascot } from './FixerBotMascot'
import './SurpriseMe.css'

const SPIN_MS = 1100
/** Reduced motion gets a still frame for just long enough to read the caption. */
const SPIN_REDUCED_MS = 450
const VERIFY_BUDGET_MS = 900
const MAX_REPICKS = 3

/** True unless the edge positively says every candidate is dead; no answer means "go with it". */
async function looksAlive(c: EnrichedChannel): Promise<boolean> {
  if (getWorkingMapSnapshot()[c.id]) return true
  const urls = c.streams.map((s) => s.url)
  if (!urls.length) return true
  const res = await fetchEdgeVerifiedStreams(c.id, urls, c.streams.map((s) => s.quality), VERIFY_BUDGET_MS)
  if (!res) return true
  return !(res.workingStream === null && res.workingCandidates.length === 0 && res.deadCandidates.length >= urls.length)
}

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
    const list = allChannels?.length ? allChannels : channels
    const currentId = location.pathname.startsWith('/watch/')
      ? decodeURIComponent(location.pathname.slice('/watch/'.length).split('/')[0])
      : undefined
    const first = pickSurprise(list, currentId)
    if (!first) return
    busy.current = true
    setSpinning(true)
    prefetchPlaylist(first)
    let chosen = first
    let done = false
    const finish = () => {
      if (done) return
      done = true
      busy.current = false
      setSpinning(false)
      navigate(`/watch/${encodeURIComponent(chosen.id)}`, {
        state: { returnTo: location.pathname + location.search },
      })
    }
    // Verify while the bot spins; never delay past the spin. Dead picks are silently replaced.
    void (async () => {
      const rejected = new Set<string>()
      for (let i = 0; i <= MAX_REPICKS && !done; i++) {
        if (await looksAlive(chosen)) return
        if (done) return
        rejected.add(chosen.id)
        const next = i < MAX_REPICKS ? pickSurprise(list, currentId, Math.random, rejected) : bestCachedWorking(list, currentId, rejected)
        if (!next) return
        chosen = next
        prefetchPlaylist(next)
      }
    })()
    timer.current = window.setTimeout(finish, prefersReducedMotion() ? SPIN_REDUCED_MS : SPIN_MS)
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
