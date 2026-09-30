/**
 * "On now" for a category row, from the guide summary (backend ADR-0046).
 *
 * The summary is one object per generation carrying every scheduled channel's
 * programmes as `[startOffsetMinutes, durationMinutes, title]`, offsets counted
 * from the generation (itself a timestamp). Pure, so it can be unit-tested and
 * recomputed on a minute tick without I/O.
 */
import type { SummaryProgramme } from '../api/r2Contract'
import { AFFINITY_REORDER_THRESHOLD, channelAffinity, compareAffinity } from './sessionAffinity'

const MS_PER_MIN = 60_000

export interface OnNowEntry<C> {
  channel: C
  title: string
  /** When the programme ends, ms since the epoch. */
  endsAt: number
}

/** The programme airing at `now` (start inclusive, end exclusive), or null. */
export function programmeOnAir(
  programmes: readonly SummaryProgramme[] | undefined,
  generation: number,
  now: number,
): { title: string; endsAt: number } | null {
  if (!programmes) return null
  for (const [startMin, durationMin, title] of programmes) {
    const start = generation + startMin * MS_PER_MIN
    const end = start + durationMin * MS_PER_MIN
    if (start <= now && now < end && title.trim() !== '') return { title, endsAt: end }
  }
  return null
}

/**
 * The channels of one row that have a programme on air, ranked for the row's
 * "live now" strip: this session's affinity for each channel's *other* categories
 * first (only once it clears the threshold), then the row's own order — which is
 * already the live-stream ranking, so with no affinity nothing moves.
 */
export function onNowForRow<C extends { id: string; categoryIds: readonly string[] }>(
  channels: readonly C[],
  rowCategoryId: string,
  summary: ReadonlyMap<string, readonly SummaryProgramme[]>,
  generation: number,
  now: number,
  affinity: ReadonlyMap<string, number>,
): OnNowEntry<C>[] {
  const live: { entry: OnNowEntry<C>; score: number; index: number }[] = []
  channels.forEach((channel, index) => {
    const onAir = programmeOnAir(summary.get(channel.id), generation, now)
    if (!onAir) return
    live.push({
      entry: { channel, ...onAir },
      score: channelAffinity(channel.categoryIds, affinity, rowCategoryId),
      index,
    })
  })
  // Already in row order; only sort when some score can outrank it (rare), since
  // this runs for every row on each minute tick and each play.
  if (live.some((l) => l.score >= AFFINITY_REORDER_THRESHOLD)) {
    live.sort((a, b) => compareAffinity(a.score, b.score) || a.index - b.index)
  }
  return live.map((l) => l.entry)
}
