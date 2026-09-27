import { useEffect, useState } from 'react'
import { useEpg } from './useChannels'
import { getCurrentProgram } from '../util/epgNow'
import type { EpgProgram } from '../api/types'

const TICK_MS = 60_000

/** Module-level, shared by every caller: one timer for the whole page, not one per card. */
let timer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<(now: number) => void>()

/** The current time, re-read once a minute from a single shared timer. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!timer) {
      timer = setInterval(() => {
        const t = Date.now()
        listeners.forEach((fn) => fn(t))
      }, TICK_MS)
    }
    listeners.add(setNow)
    return () => { listeners.delete(setNow) }
  }, [])
  return now
}

/**
 * The programme airing now on `channelId`, re-derived every minute so a card left
 * open across a programme boundary picks up the next one, plus the clock reading
 * it was derived from (for a caller that also needs to place "now" within it, e.g.
 * a progress bar). Pass `null` to skip the fetch entirely (a channel with no
 * schedule, or a card that isn't visible yet).
 */
export function useNowPlaying(channelId: string | null): { program: EpgProgram | undefined; now: number } {
  const now = useMinuteClock()
  const { programs } = useEpg(channelId)
  return { program: getCurrentProgram(programs, now), now }
}
