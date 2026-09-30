import { useEffect, useSyncExternalStore } from 'react'
import { fetchEpgSummary, resolveGeneration } from '../api/catalogueSource'
import type { SummaryProgramme } from '../api/r2Contract'

/**
 * The guide summary (backend ADR-0046) for the catalogue's generation, read once
 * per generation per page load and held in memory: one request in place of one
 * schedule read per channel for a question ("what is on now in Sports?") that
 * spans a whole row. Not persisted — it is ~100 KB and only decorates Home, and
 * the per-card now-playing (useNowPlaying) still works without it.
 *
 * The read waits for the browser to be idle, so it never competes with the
 * catalogue or the first card images, and only for the live generation. A failure is remembered for the generation
 * (null), so a missing object costs one request, not one per Home mount.
 */
type Summary = ReadonlyMap<string, readonly SummaryProgramme[]>

let _held: { generation: number; summary: Summary | null } | null = null
let _loading: number | null = null
const _listeners = new Set<() => void>()

const subscribe = (fn: () => void) => {
  _listeners.add(fn)
  return () => { _listeners.delete(fn) }
}
const snapshot = () => _held

function load(generation: number) {
  if (_held?.generation === generation || _loading === generation) return
  _loading = generation
  // A return visit renders the stored catalogue first, then replaces it when the
  // pointer names a newer generation. Checking the pointer (the same shared read
  // the catalogue load makes, or its pinned result) keeps a summary of a
  // generation about to be replaced from being downloaded at all.
  resolveGeneration()
    .then((live) => (live === generation ? fetchEpgSummary(generation) : undefined))
    .catch(() => null)
    .then((summary) => {
      if (_loading !== generation) return
      _loading = null
      // Not the live generation: hold nothing, so the next generation loads its own.
      if (summary === undefined) return
      _held = { generation, summary }
      _listeners.forEach((fn) => fn())
    })
}

/** The summary for `generation`, or null while loading, when unavailable, or with no generation. */
export function useEpgSummary(generation: number | null): Summary | null {
  const held = useSyncExternalStore(subscribe, snapshot, snapshot)

  useEffect(() => {
    if (generation === null || held?.generation === generation) return
    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(() => load(generation), { timeout: 3000 })
      return () => cancelIdleCallback(id)
    }
    const id = window.setTimeout(() => load(generation), 1000)
    return () => window.clearTimeout(id)
  }, [generation, held])

  return held && held.generation === generation ? held.summary : null
}
