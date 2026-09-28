/**
 * Cloudflare Pages Function: POST /api/t — the telemetry endpoint (ADR-0032, ADR-0047, WO-22).
 *
 * Same-origin, public, write-only. It accepts a small batch of aggregate events and writes one
 * Workers Analytics Engine data point per accepted event. It is built so that nothing about the
 * person sending it can ever be stored:
 *
 *   1. **Opt-out signals win before the body is touched.** `Sec-GPC: 1` or `DNT: 1` answers 204
 *      and reads nothing else from the request: no body, no `cf`, no write anywhere.
 *   2. **The IP is never read, logged or stored.** Country and region come from `request.cf`,
 *      which Cloudflare derived at the edge; the request is then discarded. Nothing in this file
 *      logs a header, a body or an address, and there is no debug path that does.
 *   3. **Validation is the contract's, not a reimplementation of it.** `validateBatch` in
 *      `_lib/telemetryContract.ts` is a line-for-line port of the backend's reference and is
 *      tested against its golden fixture. A refused batch writes nothing; an event naming a
 *      channel that is not in the live generation is dropped, not refused.
 *   4. **The point shape is `waePoint()`'s**, in `WAE_LAYOUT`'s order, built once in the contract.
 *   5. **No CORS headers.** A cross-origin page cannot read a response and its preflight is
 *      refused (405 on OPTIONS); `Sec-Fetch-Site: cross-site` is refused outright.
 *   6. **A China-resolved origin is dropped, silently, before the body is touched.** PIPL's
 *      cross-border transfer rules are understood to trigger on a China-origin request reaching
 *      this non-China edge at all, before payload content or opt-out state become relevant (see
 *      README.md's "Telemetry and the region-tiered opt-out" section, and the cross-repo design
 *      records it cites: streamloom-android's `docs/adr/0035-*.md` and streamloom-backend's
 *      `docs/adr/0049-*.md`). The Android client, and this repo's own web client once/if it
 *      adopts the same tiering, already decide this before the request is ever sent — this is
 *      the defense-in-depth backstop for any other caller (a browser hitting the API directly, a
 *      future client, an older build). Nothing about a dropped request is logged: writing its
 *      country or IP to a log would itself be the cross-border processing this exists to avoid.
 *
 * No credential lives here: the only capabilities are the `TELEMETRY` (Analytics Engine) and
 * `CATALOGUE_BUCKET` (R2, read) bindings. The Workers Free rate-limit rule on this path is edge
 * configuration the owner adds (WO-22, owner step 4); it is not something this code can enforce.
 */

import { loadActiveChannelIds } from './_lib/activeChannelIds'
import { bindBucket, type CatalogueBucket } from './_lib/catalogueBucket'
import { MAX_BATCH_BYTES, validateBatch, waePoint, type WaePoint } from './_lib/telemetryContract'

/** The Analytics Engine binding, as far as this route needs it. */
export interface TelemetryDataset {
  writeDataPoint: (point: WaePoint) => void
}

/** What Pages hands a Function. Typed locally so the route is checkable without the Workers types. */
export interface TelemetryContext {
  request: Request
  env: unknown
  waitUntil: (promise: Promise<unknown>) => void
}

/**
 * How long the live channel-id set is reused before it is re-read from the bucket. The sync
 * publishes a new generation at most a few times a day, and a stale set only means a channel
 * that went live in the last minute is dropped for a minute — never that an unknown id lands.
 */
export const ACTIVE_IDS_TTL_MS = 60 * 1000

/** Floor between two attempts after a failed read, so an R2 hiccup is not retried per request. */
const ACTIVE_IDS_RETRY_MS = 10 * 1000

interface ActiveIdsCache {
  ids: ReadonlySet<string> | null
  fetchedAt: number
  lastAttempt: number
}

let activeIdsCache: ActiveIdsCache | null = null
let activeIdsInFlight: Promise<ReadonlySet<string> | null> | null = null

/*
 * Test seam, absent in production (see e2e/support/testSeams.ts): only a process that created
 * the registry before this module was evaluated can reach it, which no request can.
 */
{
  const seams = (globalThis as { __streamloomTestSeams?: Record<string, unknown> }).__streamloomTestSeams
  if (seams) {
    seams.resetActiveIdsCache = () => {
      activeIdsCache = null
      activeIdsInFlight = null
    }
  }
}

/**
 * The live generation's channel ids, memoised briefly. When they cannot be read at all the
 * result is an **empty** set, not "no filter": an event naming a channel then drops for the
 * duration of the outage rather than an unverified id ever reaching the dataset. Events that
 * carry no channel (`app_open`, `guide_open`, `search`, `perf`) still land.
 */
async function activeChannelIds(bucket: CatalogueBucket | null, now: number): Promise<ReadonlySet<string>> {
  const cached = activeIdsCache
  if (cached && cached.ids && now - cached.fetchedAt < ACTIVE_IDS_TTL_MS) return cached.ids
  if (cached && !cached.ids && now - cached.lastAttempt < ACTIVE_IDS_RETRY_MS) return new Set()
  if (!bucket) return new Set()

  if (!activeIdsInFlight) {
    activeIdsInFlight = loadActiveChannelIds(bucket)
      .then((ids) => {
        activeIdsCache = ids ? { ids, fetchedAt: now, lastAttempt: now } : { ids: null, fetchedAt: 0, lastAttempt: now }
        return ids
      })
      .catch(() => {
        activeIdsCache = { ids: null, fetchedAt: 0, lastAttempt: now }
        return null
      })
      .finally(() => {
        activeIdsInFlight = null
      })
  }
  const ids = await activeIdsInFlight
  // A read that failed while a stale copy is still held keeps answering from the stale copy.
  return ids ?? cached?.ids ?? new Set()
}

const bindTelemetry = (env: unknown): TelemetryDataset | null => {
  const raw = (env as { TELEMETRY?: unknown } | undefined)?.TELEMETRY
  if (typeof raw !== 'object' || raw === null) return null
  const write = (raw as Record<string, unknown>).writeDataPoint
  if (typeof write !== 'function') return null
  return { writeDataPoint: (point) => (write as (p: WaePoint) => void).call(raw, point) }
}

const empty = (status: number, headers: Record<string, string> = {}): Response =>
  new Response(null, { status, headers: { 'Cache-Control': 'no-store', ...headers } })

const refused = (reason: string): Response =>
  new Response(JSON.stringify({ error: 'refused', reason }), {
    status: 400,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })

/** A GPC or DNT header value that means "do not track", as the specifications spell it. */
const optedOut = (value: string | null): boolean => value !== null && value.trim() === '1'

/**
 * Reads at most `limit` bytes of the body. A body that is longer is cut at the limit, which is
 * enough for `validateBatch` to refuse it as over-size without this route ever buffering a large
 * upload just to say no.
 */
async function readBodyCapped(request: Request, limit: number): Promise<string> {
  const body = request.body
  if (!body) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total <= limit) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        total += value.byteLength
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // The stream is dropped either way.
    }
  }
  const joined = new Uint8Array(Math.min(total, limit + 1))
  let offset = 0
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, joined.byteLength - offset)
    if (take <= 0) break
    joined.set(chunk.subarray(0, take), offset)
    offset += take
  }
  return new TextDecoder().decode(joined)
}

export async function handleTelemetry(context: TelemetryContext, now: number = Date.now()): Promise<Response> {
  const { request, env } = context

  // Opt-out first: before the method, the body, `cf`, or anything else is looked at.
  if (optedOut(request.headers.get('sec-gpc')) || optedOut(request.headers.get('dnt'))) {
    return empty(204)
  }

  // China-origin backstop, next: also before the method or body are looked at. Cloudflare's
  // edge-derived `cf.country` is read once here and reused below for the accepted path; nothing
  // else about the request (its IP, headers, or the fact that it was dropped) is ever logged.
  const cf = (request as Request & { cf?: { country?: unknown; regionCode?: unknown } }).cf
  if (cf?.country === 'CN') {
    return empty(204)
  }

  const method = request.method.toUpperCase()
  if (method !== 'POST') return empty(405, { Allow: 'POST' })

  const fetchSite = request.headers.get('sec-fetch-site')
  if (fetchSite !== null && fetchSite !== 'same-origin' && fetchSite !== 'none') return empty(403)

  const dataset = bindTelemetry(env)
  if (!dataset) {
    // Named without any request detail: the owner needs to know the binding is missing, and
    // nothing about who asked belongs in a log.
    console.warn('[t] TELEMETRY is not an Analytics Engine binding on this project; nothing written')
    return empty(503)
  }

  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_BATCH_BYTES) return refused(`over ${MAX_BATCH_BYTES} bytes`)

  const text = await readBodyCapped(request, MAX_BATCH_BYTES)
  // A fast, cheap pass first so a malformed body never costs a bucket read.
  const shape = validateBatch(text)
  if (!shape.ok) return refused(shape.reason)

  const ids = await activeChannelIds(bindBucket(env), now)
  const verdict = validateBatch(text, { activeChannelIds: ids })
  if (!verdict.ok) return refused(verdict.reason)

  // Country and region are what the edge derived, already read above; the request is not
  // consulted again.
  const country = typeof cf?.country === 'string' ? cf.country : null
  const region = typeof cf?.regionCode === 'string' ? cf.regionCode : null

  const ctx = { platform: verdict.platform, appVersion: verdict.appVersion, country, region }
  for (const event of verdict.events) {
    dataset.writeDataPoint(waePoint(event, ctx))
  }

  return empty(202, { 'X-Telemetry-Dropped': String(verdict.dropped) })
}

export const onRequest = (context: TelemetryContext): Promise<Response> => handleTelemetry(context)
