/**
 * The web telemetry client (ADR-0032, ADR-0047, WO-22): aggregate counts, no identifier, opt-out.
 *
 * What it sends is exactly `EVENT_FIELDS` in the shared contract and nothing else: no id, no
 * cookie, no hash, no timestamp, no query text, no URL. The only things it stores are the
 * period-first marker (`{day, week, month}`, the last periods this browser reported in) and the
 * opt-out flag. Everything here is fire-and-forget: a call never throws, never awaits anything a
 * user path waits on, and never blocks navigation (`sendBeacon`).
 *
 * Nothing is sent when:
 *   - the in-app opt-out is set (`sl_telemetry_optout`), checked first, before anything else;
 *   - the browser signals Global Privacy Control (`navigator.globalPrivacyControl`); the endpoint
 *     honours the header as well, but an opted-out browser should not have to round-trip;
 *   - `sendBeacon` and `fetch` are both unavailable.
 *
 * Batching: events queue in memory and flush as one `POST /api/t` on `pagehide`, on
 * `visibilitychange` to hidden, every five minutes while the tab is visible, and when the queue
 * reaches the contract's caps (`MAX_BATCH_EVENTS`, `MAX_BATCH_BYTES`) — never more than one
 * batch's worth per request.
 */

import {
  MAX_BATCH_BYTES,
  MAX_BATCH_EVENTS,
  TELEMETRY_VERSION,
  appOpenFlags,
  byteLength,
  latencyBucket,
  type PeriodMarker,
  type TelemetryEvent,
} from '../../functions/api/_lib/telemetryContract'

export const OPT_OUT_KEY = 'sl_telemetry_optout'
export const MARKER_KEY = 'sl_telemetry_marker_v1'
export const ENDPOINT = '/api/t'
/** ADR-0032's cadence: one flush per five minutes of activity, not one per minute. */
export const FLUSH_INTERVAL_MS = 5 * 60 * 1000

const PLATFORM = 'web'
const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'

const queue: TelemetryEvent[] = []
let started = false
let intervalId: number | null = null

// ---- Opt-out ----

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeLocal(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // A storage denial is not an error worth surfacing: the marker just is not kept.
  }
}

/** The in-app choice. Off by default (opt-out, ADR-0032), persisted locally, never sent anywhere. */
export function isOptedOut(): boolean {
  return readLocal(OPT_OUT_KEY) === 'true'
}

export function setOptedOut(optedOut: boolean): void {
  writeLocal(OPT_OUT_KEY, optedOut ? 'true' : null)
  if (optedOut) {
    // Once set, nothing already queued leaves either.
    queue.length = 0
    if (intervalId !== null) {
      clearInterval(intervalId)
      intervalId = null
    }
  } else if (started && intervalId === null) {
    intervalId = window.setInterval(flushIfVisible, FLUSH_INTERVAL_MS)
  }
}

/** Global Privacy Control, read from the browser; read only after the in-app choice. */
export function browserOptedOut(): boolean {
  try {
    return (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true
  } catch {
    return false
  }
}

/** True when an event may be queued at all: the in-app opt-out first, then GPC. */
export function enabled(): boolean {
  if (isOptedOut()) return false
  if (browserOptedOut()) return false
  return true
}

// ---- Queue and flush ----

function batchBody(events: TelemetryEvent[]): string {
  return JSON.stringify({ v: TELEMETRY_VERSION, p: PLATFORM, a: APP_VERSION, b: events })
}

/** Ships `events` as one request. Never throws; a failed send is simply lost, by design. */
function send(events: TelemetryEvent[]): void {
  if (events.length === 0) return
  const body = batchBody(events)
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      // A Blob with the JSON type, so the request arrives as `application/json` like a fetch would
      // and the endpoint can treat both the same.
      if (navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }))) return
    }
  } catch {
    // Fall through to fetch.
  }
  try {
    void fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
      credentials: 'omit',
      cache: 'no-store',
    }).catch(() => {})
  } catch {
    // Nothing else to try.
  }
}

/**
 * Takes one batch's worth off the queue: up to `MAX_BATCH_EVENTS` events and under
 * `MAX_BATCH_BYTES` of JSON. What does not fit stays for the next flush.
 */
function takeBatch(): TelemetryEvent[] {
  const batch: TelemetryEvent[] = []
  while (queue.length > 0 && batch.length < MAX_BATCH_EVENTS) {
    const next = queue[0]
    if (batch.length > 0 && byteLength(batchBody([...batch, next])) > MAX_BATCH_BYTES) break
    batch.push(next)
    queue.shift()
  }
  return batch
}

/** Sends everything queued, one request per batch. Safe to call at any time. */
export function flush(): void {
  if (!enabled()) {
    queue.length = 0
    return
  }
  let guard = 0
  while (queue.length > 0 && guard < 50) {
    send(takeBatch())
    guard += 1
  }
}

function flushIfVisible(): void {
  if (typeof document === 'undefined' || document.visibilityState === 'visible') flush()
}

/** Queues one event. Never throws. Sends at once when a batch is full. */
export function track(event: TelemetryEvent): void {
  try {
    if (!enabled()) return
    queue.push(event)
    if (queue.length >= MAX_BATCH_EVENTS) flush()
  } catch {
    // Telemetry must never reach a user path as an error.
  }
}

// ---- Events ----

function readMarker(): PeriodMarker | null {
  const raw = readLocal(MARKER_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as PeriodMarker).day === 'string' &&
      typeof (parsed as PeriodMarker).week === 'string' &&
      typeof (parsed as PeriodMarker).month === 'string'
    ) {
      const { day, week, month } = parsed as PeriodMarker
      return { day, week, month }
    }
  } catch {
    // A corrupt marker counts as no marker: one over-count, never an identifier.
  }
  return null
}

/** `app_open` with the period-first flags, and the marker moved on (`appOpenFlags`, the port). */
export function trackAppOpen(now: number = Date.now()): void {
  try {
    if (!enabled()) return
    const { flags, next } = appOpenFlags(readMarker(), now)
    writeLocal(MARKER_KEY, JSON.stringify(next))
    track({ e: 'app_open', f: flags })
  } catch {
    // Never on a user path.
  }
}

export function trackGuideOpen(): void {
  track({ e: 'guide_open' })
}

/** `search` carries only whether it returned nothing. The text is never sent. */
export function trackSearch(resultCount: number): void {
  track({ e: 'search', z: resultCount === 0 ? 1 : 0 })
}

/** A latency perf metric from a millisecond value: the bucket index is what travels. */
export function trackLatency(metric: 'catalogue_load' | 'guide_open' | 'video_start_time', ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return
  track({ e: 'perf', k: metric, d: latencyBucket(ms) })
}

// ---- Lifecycle ----

/**
 * Starts the client: one `app_open`, then the flush schedule. Idempotent; safe to call before
 * the catalogue is on screen because everything it does is a queue push or a listener.
 */
export function startTelemetry(): void {
  if (started || typeof window === 'undefined') return
  started = true
  try {
    trackAppOpen()
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush()
    })
    if (enabled()) intervalId = window.setInterval(flushIfVisible, FLUSH_INTERVAL_MS)
  } catch {
    // A listener that could not be attached only means fewer flushes.
  }
}

/** Test-only view of the queue; the deployed bundle has no reader of it. */
export function pendingCount(): number {
  return queue.length
}
