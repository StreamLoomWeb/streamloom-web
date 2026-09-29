/**
 * Local "starting soon" reminders. Stored on this device only and fired as an in-app toast
 * while the app is open: no Notification API, no push, no server, no identifier.
 */
import { useSyncExternalStore } from 'react'

const KEY = 'sl_reminders_v1'
const EVENT = 'sl-reminders-changed'
/** A reminder this long after its start is stale and dropped. */
const STALE_MS = 60 * 60 * 1000
const MAX_REMINDERS = 20

export interface Reminder {
  /** Channel id. */
  c: string
  /** Channel name, so the toast needs no catalogue lookup. */
  n: string
  /** Programme title. */
  p: string
  /** Programme start, epoch ms. */
  s: number
}

let cache: { raw: string | null; list: Reminder[] } | null = null

function read(): Reminder[] {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    return []
  }
  if (cache && cache.raw === raw) return cache.list
  let list: Reminder[] = []
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    if (Array.isArray(parsed)) {
      list = parsed.filter(
        (r): r is Reminder =>
          !!r && typeof r.c === 'string' && typeof r.n === 'string' && typeof r.p === 'string' && typeof r.s === 'number',
      )
    }
  } catch {
    list = []
  }
  cache = { raw, list }
  return list
}

function write(list: Reminder[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX_REMINDERS)))
  } catch {
    // storage full or blocked: the reminder is simply not kept
  }
  window.dispatchEvent(new Event(EVENT))
}

export function getReminders(): Reminder[] {
  return read()
}

export const sameReminder = (a: Reminder, b: Pick<Reminder, 'c' | 's'>) => a.c === b.c && a.s === b.s

export function hasReminder(r: Pick<Reminder, 'c' | 's'>): boolean {
  return read().some((x) => sameReminder(x, r))
}

export function toggleReminder(r: Reminder) {
  const list = read()
  write(list.some((x) => sameReminder(x, r)) ? list.filter((x) => !sameReminder(x, r)) : [...list, r])
}

export function removeReminder(r: Pick<Reminder, 'c' | 's'>) {
  write(read().filter((x) => !sameReminder(x, r)))
}

/** Reminders whose programme starts within `leadMs` (or has just started); stale ones are pruned. */
export function dueReminders(now: number, leadMs: number): Reminder[] {
  const list = read()
  const fresh = list.filter((r) => now - r.s < STALE_MS)
  if (fresh.length !== list.length) write(fresh)
  return fresh.filter((r) => r.s - now <= leadMs)
}

function subscribe(fn: () => void) {
  window.addEventListener(EVENT, fn)
  window.addEventListener('storage', fn)
  return () => {
    window.removeEventListener(EVENT, fn)
    window.removeEventListener('storage', fn)
  }
}

/** Live list of reminders, re-rendering on any change (this tab or another). */
export function useReminders(): Reminder[] {
  return useSyncExternalStore(subscribe, read, () => [])
}
