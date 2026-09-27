/**
 * Schedule reads, in order of cost: memory (callers' own caches), IndexedDB, the network (R2, then Redis).
 *
 * Every Redis read is metered, so a schedule is fetched at most once per catalogue
 * generation and then served from IndexedDB, including after a reload. Stored
 * schedules are keyed by generation and channel id (see catalogueStore.ts), which
 * is what makes them safe to reuse: a generation is immutable.
 */

import { fetchEpg } from '../api/catalogueSource'
import type { EpgProgram } from '../api/types'
import { readStoredSchedules, writeStoredSchedules } from './catalogueStore'

/**
 * Schedules already stored for `channelIds`, for `generation`.
 * Best-effort: storage that is unavailable behaves like an empty store.
 */
export function readPersistedSchedules(
  generation: number,
  channelIds: string[],
): Promise<Map<string, EpgProgram[]>> {
  return readStoredSchedules(generation, channelIds).catch(() => new Map<string, EpgProgram[]>())
}

/** Persists schedules just read from the network. Best-effort and never throws. */
export function persistSchedules(
  generation: number,
  entries: Iterable<[string, EpgProgram[]]>,
): Promise<void> {
  return writeStoredSchedules(generation, entries).catch(() => {})
}

/**
 * One channel's schedule for `generation`: stored copy first, the network on a
 * miss (then stored). Resolves to an empty list when the schedule cannot be read.
 *
 * `generation` is the caller's own held generation, not re-resolved here: the
 * module-level catalogue pointer can move on between when a view loaded its
 * catalogue and when it asks for a schedule, and reading it fresh at that point
 * would fetch a schedule for a generation other than the one on screen.
 */
export async function loadSchedule(channelId: string, generation: number): Promise<EpgProgram[]> {
  const stored = await readPersistedSchedules(generation, [channelId])
  const hit = stored.get(channelId)
  if (hit) return hit

  const programs = await fetchEpg(channelId, generation)
  if (programs.length > 0) void persistSchedules(generation, [[channelId, programs]])
  return programs
}
