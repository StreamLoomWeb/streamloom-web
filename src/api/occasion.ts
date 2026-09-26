/**
 * Backend-driven seasonal accessory for FixerBotMascot — read-only, same
 * Upstash client as the rest of the catalogue (see redis.ts).
 *
 * The backend document (published separately, see the FixerBot plan) is
 * expected to look like `{"schema": 1, "active": "diwali" | ... | null}` at
 * key `catalogue:occasion`. The app only needs to know how to render a fixed,
 * small set of accessories — not which one is active today, so an occasion id
 * that doesn't exist yet in OCCASION_ACCESSORY degrades to "no accessory"
 * rather than blocking or crashing.
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
  'new-year': 'party-hat',
  'republic-day': 'rosette',
  'independence-day': 'rosette',
}

interface OccasionDoc {
  schema: number
  active: string | null
  region?: string
}

let lastGoodAccessory: AccessoryId | null = null
let lastFetchedAt = 0
let inflight: Promise<AccessoryId | null> | null = null
const listeners = new Set<(accessory: AccessoryId | null) => void>()

function notify(accessory: AccessoryId | null) {
  listeners.forEach((listener) => listener(accessory))
}

async function readOnce(): Promise<AccessoryId | null> {
  const raw = await redisGet(OCCASION_KEY)
  if (raw === null) return lastGoodAccessory

  try {
    const doc = JSON.parse(raw) as OccasionDoc
    if (doc.schema !== SUPPORTED_SCHEMA) return lastGoodAccessory

    const accessory = doc.active === null ? null : OCCASION_ACCESSORY[doc.active] ?? null
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
