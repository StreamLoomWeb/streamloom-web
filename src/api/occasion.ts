/**
 * Backend-driven seasonal accessory for FixerBotMascot — read-only, same
 * Upstash client as the rest of the catalogue (see redis.ts).
 *
 * The backend document (published separately in streamloom-backend, tracked
 * there as ADR-0047 — not yet merged as of this writing, nothing is live
 * yet) is expected to look like
 * `{"schema": 1, "occasions": [{"id": "diwali", "region": "IN"}, {"id": "halloween"}]}`
 * at key `catalogue:occasion`, or `{"schema": 1, "occasions": []}` when
 * nothing is active anywhere. Multiple occasions can be active at once for
 * different regions (e.g. Diwali for India while Halloween is also active
 * globally), so resolveAccessory() below picks the entry for this device's
 * own region, falling back to a region-less (global) entry, else nothing.
 *
 * The app only needs to know how to render a fixed, small set of
 * accessories — not which ones are active today, so an occasion id that
 * doesn't exist yet in OCCASION_ACCESSORY degrades to "no accessory" rather
 * than blocking or crashing (same forward-compatibility contract as before).
 *
 * Fallback discipline mirrors fetchCatalogueMeta()'s generation caching: a
 * failed/malformed read keeps the last successfully-decoded value; a
 * successful read (even one that resolves to "no accessory") replaces it.
 * The very first read has nothing to fall back to, so it starts as null.
 */

import { useEffect, useState } from 'react'
import { redisGet } from './redis'

export type AccessoryId = 'santa-hat' | 'diya' | 'party-hat' | 'rosette' | 'witch-hat'

const OCCASION_KEY = 'catalogue:occasion'
const SUPPORTED_SCHEMA = 1
const REFETCH_INTERVAL_MS = 5 * 60 * 1000

const OCCASION_ACCESSORY: Record<string, AccessoryId> = {
  christmas: 'santa-hat',
  diwali: 'diya',
  halloween: 'witch-hat',
  new_year: 'party-hat',
  republic_day: 'rosette',
  independence_day: 'rosette',
}

interface OccasionEntry {
  id: string
  region?: string
}

interface OccasionDoc {
  schema: number
  occasions: OccasionEntry[]
}

let lastGoodAccessory: AccessoryId | null = null
let lastFetchedAt = 0
let inflight: Promise<AccessoryId | null> | null = null
const listeners = new Set<(accessory: AccessoryId | null) => void>()

function notify(accessory: AccessoryId | null) {
  listeners.forEach((listener) => listener(accessory))
}

/** This device's own region (e.g. "IN"), from its locale — null when unavailable. */
function getDeviceRegion(): string | null {
  try {
    const lang = navigator.language || navigator.languages?.[0]
    if (!lang) return null
    if (typeof Intl !== 'undefined' && 'Locale' in Intl) {
      return new Intl.Locale(lang).maximize().region ?? null
    }
    return /-([A-Z]{2})$/.exec(lang)?.[1] ?? null
  } catch {
    return null
  }
}

/** Prefers this device's own region, falls back to a region-less (global) entry, else none. */
function resolveAccessory(occasions: OccasionEntry[]): AccessoryId | null {
  const region = getDeviceRegion()
  const chosen = (region && occasions.find((o) => o.region === region)) || occasions.find((o) => !o.region)
  return chosen ? OCCASION_ACCESSORY[chosen.id] ?? null : null
}

async function readOnce(): Promise<AccessoryId | null> {
  const raw = await redisGet(OCCASION_KEY)
  if (raw === null) return lastGoodAccessory

  try {
    const doc = JSON.parse(raw) as OccasionDoc
    if (doc.schema !== SUPPORTED_SCHEMA || !Array.isArray(doc.occasions)) return lastGoodAccessory

    const accessory = resolveAccessory(doc.occasions)
    lastGoodAccessory = accessory
    return accessory
  } catch {
    return lastGoodAccessory
  }
}

/** Fetches the active accessory, deduping concurrent callers and throttling repeat reads. */
export function fetchActiveAccessory(): Promise<AccessoryId | null> {
  const now = Date.now()
  if (!inflight && lastFetchedAt !== 0 && now - lastFetchedAt < REFETCH_INTERVAL_MS) {
    return Promise.resolve(lastGoodAccessory)
  }
  if (inflight) return inflight

  lastFetchedAt = now
  inflight = readOnce()
    .then((accessory) => {
      notify(accessory)
      return accessory
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** The currently active accessory, refetched (throttled) on mount; never blocks or crashes on a bad read. */
export function useOccasionAccessory(): AccessoryId | null {
  const [accessory, setAccessory] = useState<AccessoryId | null>(lastGoodAccessory)

  useEffect(() => {
    listeners.add(setAccessory)
    fetchActiveAccessory().then(setAccessory)
    return () => {
      listeners.delete(setAccessory)
    }
  }, [])

  return accessory
}
