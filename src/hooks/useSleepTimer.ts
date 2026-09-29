import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
/** Choices cycled by the sleep button / `z` key, in minutes. */
export const SLEEP_STEPS = [30, 60, 90] as const
/** Audio fades and the picture dims over the final stretch. */
const FADE_MS = 60_000
const MAX_DIM = 0.78

export type SleepPhase = 'off' | 'running' | 'done'

export interface SleepTimer {
  phase: SleepPhase
  /** Whole minutes left while running (rounded up). */
  minutesLeft: number
  /** 0 to MAX_DIM, for the dimming veil. */
  dim: number
  /** off → 30 → 60 → 90 → off. */
  cycle: () => void
  /** Leaves the "Good night" card and resumes playback. */
  keepWatching: () => void
}

/**
 * Sleep timer for the player. In the last minute the picture dims and the audio fades; at
 * zero playback pauses and the caller shows one calm "Good night" card (no autoplay of anything
 * else, no upsell). Volume is always restored so waking the video is never silent.
 */
export function useSleepTimer(videoRef: RefObject<HTMLVideoElement | null>): SleepTimer {
  const [endsAt, setEndsAt] = useState<number | null>(null)
  const [phase, setPhase] = useState<SleepPhase>('off')
  const [now, setNow] = useState(() => Date.now())
  const baseVolume = useRef<number | null>(null)

  const restoreVolume = useCallback(() => {
    const v = videoRef.current
    if (v && baseVolume.current !== null) v.volume = baseVolume.current
    baseVolume.current = null
  }, [videoRef])

  const left = endsAt === null ? 0 : Math.max(0, endsAt - now)

  useEffect(() => {
    if (phase !== 'running' || endsAt === null) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [phase, endsAt])

  // Drive the fade and the end from the ticking clock.
  useEffect(() => {
    if (phase !== 'running') return
    const v = videoRef.current
    if (left > 0 && left <= FADE_MS && v) {
      if (baseVolume.current === null) baseVolume.current = v.volume
      v.volume = baseVolume.current * (left / FADE_MS)
    }
    if (left <= 0) {
      v?.pause()
      restoreVolume()
      // Deferred so the effect body does not set state synchronously.
      queueMicrotask(() => setPhase('done'))
    }
  }, [phase, left, videoRef, restoreVolume])

  useEffect(() => restoreVolume, [restoreVolume])

  const step = useRef(-1)
  const cycle = useCallback(() => {
    restoreVolume()
    step.current = phase === 'running' ? step.current + 1 : 0
    if (step.current >= SLEEP_STEPS.length) {
      step.current = -1
      setEndsAt(null)
      setPhase('off')
      return
    }
    const t = Date.now()
    setNow(t)
    setEndsAt(t + SLEEP_STEPS[step.current] * 60_000)
    setPhase('running')
  }, [phase, restoreVolume])

  const keepWatching = useCallback(() => {
    restoreVolume()
    step.current = -1
    setEndsAt(null)
    setPhase('off')
    void videoRef.current?.play().catch(() => {})
  }, [restoreVolume, videoRef])

  const dim = phase === 'running' && left <= FADE_MS ? MAX_DIM * (1 - left / FADE_MS) : phase === 'done' ? MAX_DIM : 0
  return { phase, minutesLeft: Math.ceil(left / 60_000), dim, cycle, keepWatching }
}

