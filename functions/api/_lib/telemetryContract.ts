/**
 * The telemetry contract (ADR-0032, amended by ADR-0047): a TypeScript port of the backend's
 * `sync-worker/telemetry-contract.js`, which is the reference. This file is deliberately a
 * line-for-line port, not a rewrite: `e2e/telemetry-contract.spec.ts` checks every constant,
 * regex and function here against `e2e/support/telemetry-golden.json`, the fixture the backend
 * emits from its own copy, so a divergence fails the suite rather than opening a silent hole in
 * what `/api/t` accepts or refuses.
 *
 * Shared by the endpoint (`functions/api/t.ts`), the dashboard's data route
 * (`functions/api/stats.ts`) and the browser client (`src/telemetry/`), so there is exactly one
 * copy of the field lists, the limits, the point layout and the k-anonymity fold in this project.
 * Imports nothing, like the reference, so the same file bundles into a Pages Function and into
 * the client without a shim.
 *
 * What is never here, because it is never sent or stored: an IP, a user agent, a referrer, a
 * cookie, an install id, a session id, a hash of any of those, a search query, a client clock.
 */

/** The payload's `v`. Bump when a field changes meaning; add fields without bumping. */
export const TELEMETRY_VERSION = 1

/** The Workers Analytics Engine dataset. This project's `TELEMETRY` binding must point at it. */
export const WAE_DATASET = 'streamloom_telemetry'

export const PLATFORMS = ['web', 'android'] as const
export type Platform = (typeof PLATFORMS)[number]

/**
 * The events, and the fields each may carry beyond `e`. A field not listed for an event refuses
 * the whole batch: the endpoint is public, and "ignore what you do not know" is how a query
 * string or an identifier would one day ride along unnoticed.
 *
 *   c  channel id            s  stream key (first 16 hex of sha256 of the stream url)
 *   k  kind: an error class for play_fail, a metric name for perf
 *   d  a bucket index (watch time for play_end, latency or ratio for perf)
 *   f  period-first flags on app_open, a subset of "dwmn" in that order (ADR-0047)
 *   z  1 when a search returned nothing, else 0; the query text is never sent
 */
export const EVENT_FIELDS = Object.freeze({
  app_open: { required: ['f'], optional: [] },
  play: { required: ['c', 's'], optional: [] },
  play_end: { required: ['c', 's', 'd'], optional: [] },
  play_fail: { required: ['c', 's', 'k'], optional: [] },
  guide_open: { required: [], optional: [] },
  search: { required: ['z'], optional: [] },
  perf: { required: ['k', 'd'], optional: [] },
} as Record<string, { required: readonly string[]; optional: readonly string[] }>)
export const EVENTS: readonly string[] = Object.freeze(Object.keys(EVENT_FIELDS))
export type EventName = 'app_open' | 'play' | 'play_end' | 'play_fail' | 'guide_open' | 'search' | 'perf'

/** A batch: at most this many events, and at most this many bytes of JSON. */
export const MAX_BATCH_EVENTS = 20
export const MAX_BATCH_BYTES = 2048

/** `a`, the app version: a short token, never free text. */
export const APP_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/

/** The same alphabet `fast-track.js` accepts for an iptv-org id. */
export const CHANNEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/
export const CHANNEL_ID_MAX = 64

/**
 * A stream is named by the first 16 hex characters of the SHA-256 of its published `url`, computed
 * by the client. The url itself is public catalogue data, but it is long and it is not what a
 * counter needs; the worker can recompute the key for any stream it holds.
 */
export const STREAM_KEY_RE = /^[0-9a-f]{16}$/
export const STREAM_KEY_ALGORITHM = 'sha256(url), lower-case hex, first 16 characters'

/** Period-first flags: first open of the UTC day, the ISO week, the calendar month, and ever. */
export const APP_OPEN_FLAGS = ['d', 'w', 'm', 'n'] as const

/**
 * Error classes a client may report. Stream faults only (ADR-0032): a client's own network is
 * never a stream fault, so there is no class for no-connection, DNS, a timeout or the watchdog.
 */
export const ERROR_CLASSES = ['http_4xx', 'http_5xx', 'manifest', 'codec', 'drm', 'other'] as const
export type ErrorClass = (typeof ERROR_CLASSES)[number]

/**
 * Perf metrics, named after CTA-2066 (Streaming Quality of Experience) where it has a name:
 * `video_start_time` is its Video Start Time; `rebuffer_ratio` its Rebuffering Ratio. The other
 * two are ours (`performance-budgets.md`).
 */
export const PERF_METRICS = ['catalogue_load', 'guide_open', 'video_start_time', 'rebuffer_ratio'] as const
export type PerfMetric = (typeof PERF_METRICS)[number]
export type BucketKind = 'latency' | 'watch' | 'ratio'
/** Which edge table each metric's bucket `d` is read against. */
export const PERF_METRIC_KIND: Readonly<Record<PerfMetric, BucketKind>> = Object.freeze({
  catalogue_load: 'latency',
  guide_open: 'latency',
  video_start_time: 'latency',
  rebuffer_ratio: 'ratio',
})

/**
 * Bucket edges. Bucket i holds `edges[i-1] <= value < edges[i]`; bucket 0 is below the first edge
 * and bucket `edges.length` is at or above the last. A client sends the index, never the value.
 */
export const LATENCY_EDGES_MS: readonly number[] = [100, 250, 500, 1000, 2000, 4000, 8000, 15000]
/** Watch time in seconds; bucket 0 (under a second) is CTA-2066's Exit Before Video Start. */
export const WATCH_EDGES_S: readonly number[] = [1, 10, 60, 300, 900, 3600]
/** Rebuffering ratio (stalled time over watched time); bucket 0 is effectively none. */
export const RATIO_EDGES: readonly number[] = [0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2]
export const BUCKET_EDGES: Readonly<Record<BucketKind, readonly number[]>> = Object.freeze({
  latency: LATENCY_EDGES_MS,
  watch: WATCH_EDGES_S,
  ratio: RATIO_EDGES,
})

/**
 * Minutes a `play_end` in each watch bucket is estimated to have lasted, for the dashboard's
 * "watch time" figure: the bucket's midpoint, and the last bucket's floor. An estimate, labelled
 * as one wherever it is shown.
 */
export const WATCH_BUCKET_EST_MIN: readonly number[] = [0, 0.09, 0.58, 3, 10, 37.5, 60]

/**
 * A stream is listed for an extra probe when it has at least K `play_fail` in the trailing 24
 * hours spread over at least this many distinct hours (one client's retry storm in one hour
 * cannot trigger it), capped at N streams a day. The probe alone decides (ADR-0032).
 */
export const PLAY_FAIL_K = 10
export const PLAY_FAIL_MIN_HOURS = 2
export const REPORTS_N = 100
export const REPORTS_WINDOW_HOURS = 24
export const REPORTS_KEY = 'catalogue/health/reports.json'
export const REPORTS_SCHEMA = 1
export const REPORTS_CACHE_CONTROL = 'public, max-age=300'

/**
 * The k-anonymity floor for geography (ADR-0047). A (day, platform, country, region) row with
 * fewer app opens than this folds into region `*`; a country under it folds into `ZZ`. Applied
 * in the rollup and in the dashboard's live window alike.
 */
export const K_ANON = 20
export const FOLDED_REGION = '*'
export const FOLDED_COUNTRY = 'ZZ'
export const COUNTRY_RE = /^[A-Z]{2}$/
/** A subdivision code as Cloudflare reports it (`regionCode`), or the fold marker. */
export const REGION_RE = /^[A-Z0-9]{1,3}$|^\*$/

/** Channels kept per platform and day in `daily_channels`; the rest is in the 90-day hot store. */
export const TOP_CHANNELS_N = 500

/**
 * One Analytics Engine data point per event. Positions are append-only: a blob that changes
 * meaning is a new dataset, because the hot store keeps 90 days of the old one.
 */
export const WAE_LAYOUT = Object.freeze({
  index1: 'platform',
  blob1: 'platform',
  blob2: 'event',
  blob3: 'appVersion',
  blob4: 'country',
  blob5: 'region',
  blob6: 'channelId',
  blob7: 'streamKey',
  blob8: 'errorClass',
  blob9: 'perfMetric',
  blob10: 'flags',
  double1: 'bucket',
  double2: 'one',
  double3: 'zeroResults',
  double4: 'version',
})

export interface D1Table {
  name: string
  columns: readonly string[]
  types: readonly string[]
  pk: readonly string[]
}

/**
 * The D1 tables the daily rollup writes (ADR-0047). Day is `YYYY-MM-DD` in UTC. Nothing here is
 * ever deleted: a day is re-rolled by upsert, and the ledger says which days exist.
 */
export const D1_TABLES: readonly D1Table[] = Object.freeze([
  {
    name: 'daily_metrics',
    columns: ['day', 'platform', 'event', 'bucket', 'flag', 'count'],
    types: ['TEXT', 'TEXT', 'TEXT', 'INTEGER', 'TEXT', 'INTEGER'],
    pk: ['day', 'platform', 'event', 'bucket', 'flag'],
  },
  {
    name: 'daily_hours',
    columns: ['day', 'platform', 'hour', 'event', 'count'],
    types: ['TEXT', 'TEXT', 'INTEGER', 'TEXT', 'INTEGER'],
    pk: ['day', 'platform', 'hour', 'event'],
  },
  {
    name: 'daily_geo',
    columns: ['day', 'platform', 'country', 'region', 'app_opens', 'plays', 'play_fails'],
    types: ['TEXT', 'TEXT', 'TEXT', 'TEXT', 'INTEGER', 'INTEGER', 'INTEGER'],
    pk: ['day', 'platform', 'country', 'region'],
  },
  {
    name: 'daily_channels',
    columns: ['day', 'platform', 'channel_id', 'country', 'plays', 'play_fails', 'play_ends', 'watch_est_min'],
    types: ['TEXT', 'TEXT', 'TEXT', 'TEXT', 'INTEGER', 'INTEGER', 'INTEGER', 'REAL'],
    pk: ['day', 'platform', 'channel_id', 'country'],
  },
  {
    name: 'daily_perf',
    columns: ['day', 'platform', 'metric', 'bucket', 'count'],
    types: ['TEXT', 'TEXT', 'TEXT', 'INTEGER', 'INTEGER'],
    pk: ['day', 'platform', 'metric', 'bucket'],
  },
  {
    name: 'rollup_runs',
    columns: ['day', 'ran_at', 'contract', 'points', 'rows_written', 'reports_listed'],
    types: ['TEXT', 'TEXT', 'INTEGER', 'INTEGER', 'INTEGER', 'INTEGER'],
    pk: ['day'],
  },
])

export const D1_DDL: readonly string[] = D1_TABLES.map(
  (t) =>
    `CREATE TABLE IF NOT EXISTS ${t.name} (` +
    t.columns.map((c, i) => `${c} ${t.types[i]} NOT NULL`).join(', ') +
    `, PRIMARY KEY (${t.pk.join(', ')}))`,
)

// ---------------------------------------------------------------------------------------------
// Buckets and percentiles

/** The index of the first edge above `value`, or `edges.length` when none is. */
export function bucketOf(value: number, edges: readonly number[]): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`bucketOf: not a finite number: ${value}`)
  }
  const i = edges.findIndex((edge) => value < edge)
  return i === -1 ? edges.length : i
}
export const latencyBucket = (ms: number): number => bucketOf(ms, LATENCY_EDGES_MS)
export const watchBucket = (seconds: number): number => bucketOf(seconds, WATCH_EDGES_S)
export const ratioBucket = (fraction: number): number => bucketOf(fraction, RATIO_EDGES)

type Unit = [string, string]
const UNIT_OF: Record<BucketKind, (v: number) => Unit> = {
  latency: (v) => (v >= 1000 ? [String(v / 1000), 's'] : [String(v), 'ms']),
  watch: (v) => (v >= 60 ? [String(v / 60), 'min'] : [String(v), 's']),
  ratio: (v) => [String(Math.round(v * 1000) / 10), '%'],
}
const withUnit = ([n, u]: Unit): string => (u === '%' ? `${n}%` : `${n} ${u}`)

/** `"<100 ms"`, `"100-250 ms"`, `"1-2 s"`, `">=15 s"`: the label the dashboard prints for a bucket. */
export function bucketLabel(kind: BucketKind, i: number): string {
  const edges = BUCKET_EDGES[kind]
  if (!edges) throw new Error(`bucketLabel: unknown kind ${kind}`)
  const unit = UNIT_OF[kind]
  if (i <= 0) return `<${withUnit(unit(edges[0]))}`
  if (i >= edges.length) return `>=${withUnit(unit(edges[edges.length - 1]))}`
  const lo = unit(edges[i - 1])
  const hi = unit(edges[i])
  return lo[1] === hi[1] ? `${lo[0]}-${withUnit(hi)}` : `${withUnit(lo)}-${withUnit(hi)}`
}

/**
 * The p-th percentile from bucket counts: the upper edge of the bucket the cumulative share first
 * reaches `p` in, `Infinity` for the last bucket, `null` when there are no counts. Percentiles from
 * a histogram are bounds, not values, and are printed as such ("p95 < 2 s").
 */
export function percentileFromBuckets(counts: readonly number[], edges: readonly number[], p: number): number | null {
  const total = counts.reduce((a, b) => a + b, 0)
  if (total === 0) return null
  let cum = 0
  for (let i = 0; i < counts.length; i++) {
    cum += counts[i]
    if (cum / total >= p) return i < edges.length ? edges[i] : Infinity
  }
  return Infinity
}

// ---------------------------------------------------------------------------------------------
// Period-first flags (ADR-0047)

const pad2 = (n: number): string => String(n).padStart(2, '0')

type DateInput = Date | number | string

/** `YYYY-MM-DD` in UTC. */
export function dayKey(date: DateInput): string {
  const d = new Date(date)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

/** `YYYY-Www`, the ISO 8601 week (Monday first, week 1 holds the year's first Thursday), in UTC. */
export function isoWeekKey(date: DateInput): string {
  const d = new Date(
    Date.UTC(new Date(date).getUTCFullYear(), new Date(date).getUTCMonth(), new Date(date).getUTCDate()),
  )
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${pad2(week)}`
}

/** `YYYY-MM` in UTC. */
export function monthKey(date: DateInput): string {
  const d = new Date(date)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`
}

/** The last period a device reported in: no identifier, only three period keys. */
export interface PeriodMarker {
  day: string
  week: string
  month: string
}

/**
 * The flags an `app_open` carries, and what the client stores in place of `last` afterwards.
 * `last` is the previous marker `{day, week, month}` or `null` when nothing was ever stored: no
 * identifier, only the last period the device reported in. A marker that names periods in the
 * future (a clock set back) still reports the current ones as first, which over-counts by one
 * rather than under-counting for a year.
 */
export function appOpenFlags(last: PeriodMarker | null, now: DateInput): { flags: string; next: PeriodMarker } {
  const next: PeriodMarker = { day: dayKey(now), week: isoWeekKey(now), month: monthKey(now) }
  let flags = ''
  if (!last || last.day !== next.day) flags += 'd'
  if (!last || last.week !== next.week) flags += 'w'
  if (!last || last.month !== next.month) flags += 'm'
  if (!last) flags += 'n'
  return { flags, next }
}

const FLAGS_RE = /^(d?w?m?n?)$/

// ---------------------------------------------------------------------------------------------
// Validation: the reference the endpoint's port must match

/** One accepted event, with only the fields its spec allows. */
export interface TelemetryEvent {
  e: EventName
  c?: string
  s?: string
  k?: string
  d?: number
  f?: string
  z?: 0 | 1
}

export type ValidBatch = {
  ok: true
  platform: Platform
  appVersion: string
  events: TelemetryEvent[]
  dropped: number
}
export type RefusedBatch = { ok: false; reason: string }
export type BatchVerdict = ValidBatch | RefusedBatch

type EventVerdict = { reason: string } | { drop: string } | { event: TelemetryEvent }

const isInt = (v: unknown, min: number, max: number): v is number =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function validateEvent(ev: unknown, activeChannelIds: ReadonlySet<string> | null): EventVerdict {
  if (!isRecord(ev)) return { reason: 'an event is not an object' }
  const e = ev.e
  if (typeof e !== 'string' || !EVENTS.includes(e)) return { reason: `unknown event ${JSON.stringify(e)}` }
  const spec = EVENT_FIELDS[e]
  const allowed = new Set(['e', ...spec.required, ...spec.optional])
  for (const key of Object.keys(ev)) {
    if (!allowed.has(key)) return { reason: `${e} does not carry ${JSON.stringify(key)}` }
  }
  for (const key of spec.required) {
    if (!(key in ev)) return { reason: `${e} needs ${key}` }
  }
  const out: TelemetryEvent = { e: e as EventName }
  if ('c' in ev) {
    if (typeof ev.c !== 'string' || ev.c.length > CHANNEL_ID_MAX || !CHANNEL_ID_RE.test(ev.c)) {
      return { reason: `${e}: bad channel id` }
    }
    if (activeChannelIds && !activeChannelIds.has(ev.c)) return { drop: 'unknown channel id' }
    out.c = ev.c
  }
  if ('s' in ev) {
    if (typeof ev.s !== 'string' || !STREAM_KEY_RE.test(ev.s)) return { reason: `${e}: bad stream key` }
    out.s = ev.s
  }
  if ('k' in ev) {
    const list: readonly string[] = e === 'perf' ? PERF_METRICS : ERROR_CLASSES
    if (typeof ev.k !== 'string' || !list.includes(ev.k)) {
      return { reason: `${e}: unknown kind ${JSON.stringify(ev.k)}` }
    }
    out.k = ev.k
  }
  if ('d' in ev) {
    const edges = e === 'play_end' ? WATCH_EDGES_S : BUCKET_EDGES[PERF_METRIC_KIND[out.k as PerfMetric]]
    if (!isInt(ev.d, 0, edges.length)) return { reason: `${e}: bucket out of range` }
    out.d = ev.d
  }
  if ('f' in ev) {
    if (typeof ev.f !== 'string' || !FLAGS_RE.test(ev.f)) return { reason: 'app_open: bad flags' }
    out.f = ev.f
  }
  if ('z' in ev) {
    if (ev.z !== 0 && ev.z !== 1) return { reason: 'search: z must be 0 or 1' }
    out.z = ev.z
  }
  return { event: out }
}

/**
 * Accepts a batch or refuses it with a reason. A refused batch writes nothing. An event whose
 * channel is not in the live generation is dropped, not refused: a client on a stale catalogue is
 * not an attacker, and `dropped` says how many were.
 *
 * `batch` is the request body, raw or parsed; `activeChannelIds` the live generation's ids when
 * known (null: no channel filter).
 */
export function validateBatch(
  batch: string | unknown,
  { activeChannelIds = null }: { activeChannelIds?: ReadonlySet<string> | null } = {},
): BatchVerdict {
  let parsed: unknown = batch
  if (typeof batch === 'string') {
    if (byteLength(batch) > MAX_BATCH_BYTES) return { ok: false, reason: `over ${MAX_BATCH_BYTES} bytes` }
    try {
      parsed = JSON.parse(batch)
    } catch {
      return { ok: false, reason: 'not JSON' }
    }
  } else if (byteLength(JSON.stringify(batch)) > MAX_BATCH_BYTES) {
    return { ok: false, reason: `over ${MAX_BATCH_BYTES} bytes` }
  }
  if (!isRecord(parsed)) return { ok: false, reason: 'not an object' }
  for (const key of Object.keys(parsed)) {
    if (!['v', 'p', 'a', 'b'].includes(key)) return { ok: false, reason: `unknown field ${JSON.stringify(key)}` }
  }
  if (parsed.v !== TELEMETRY_VERSION) {
    return { ok: false, reason: `version ${JSON.stringify(parsed.v)} is not ${TELEMETRY_VERSION}` }
  }
  if (typeof parsed.p !== 'string' || !(PLATFORMS as readonly string[]).includes(parsed.p)) {
    return { ok: false, reason: 'unknown platform' }
  }
  if (typeof parsed.a !== 'string' || !APP_VERSION_RE.test(parsed.a)) return { ok: false, reason: 'bad app version' }
  if (!Array.isArray(parsed.b) || parsed.b.length === 0) return { ok: false, reason: 'no events' }
  if (parsed.b.length > MAX_BATCH_EVENTS) return { ok: false, reason: `over ${MAX_BATCH_EVENTS} events` }
  const events: TelemetryEvent[] = []
  let dropped = 0
  for (const ev of parsed.b) {
    const r = validateEvent(ev, activeChannelIds)
    if ('reason' in r) return { ok: false, reason: r.reason }
    if ('drop' in r) {
      dropped += 1
      continue
    }
    events.push(r.event)
  }
  return { ok: true, platform: parsed.p as Platform, appVersion: parsed.a, events, dropped }
}

/** UTF-8 length without Buffer or TextEncoder, so the file stays portable. */
export function byteLength(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

/** The point `writeDataPoint` takes, in `WAE_LAYOUT`'s order. */
export interface WaePoint {
  indexes: string[]
  blobs: string[]
  doubles: number[]
}

export interface PointContext {
  platform: string
  appVersion: string
  country: string | null | undefined
  region: string | null | undefined
}

/**
 * The data point the endpoint writes for one accepted event: `WAE_LAYOUT` made concrete. Country
 * and region are what the edge derived; the caller has already discarded the request they came
 * from. Empty strings stand for "not applicable", never null, so a query can group on them.
 */
export function waePoint(event: TelemetryEvent, { platform, appVersion, country, region }: PointContext): WaePoint {
  const c = COUNTRY_RE.test(country || '') ? (country as string) : FOLDED_COUNTRY
  const r = REGION_RE.test(region || '') ? (region as string) : FOLDED_REGION
  return {
    indexes: [platform],
    blobs: [
      platform,
      event.e,
      appVersion,
      c,
      r,
      event.c ?? '',
      event.s ?? '',
      event.e === 'play_fail' ? (event.k as string) : '',
      event.e === 'perf' ? (event.k as string) : '',
      event.f ?? '',
    ],
    doubles: [event.d ?? -1, 1, event.z ?? 0, TELEMETRY_VERSION],
  }
}

// ---------------------------------------------------------------------------------------------
// Aggregation rules shared by the rollup and the dashboard

export interface GeoRow {
  platform: string
  country: string
  region: string
  app_opens: number
  plays: number
  play_fails: number
}

/**
 * The k-anonymity fold. Rows are `{platform, country, region, app_opens, plays, play_fails}` for
 * one day. A region with fewer than `k` opens joins its country's `*` row; a country whose total
 * is under `k` joins `ZZ`/`*`. Output is sorted for a stable fixture.
 */
export function foldGeo(rows: readonly GeoRow[], k: number = K_ANON): GeoRow[] {
  const byKey = new Map<string, GeoRow>()
  const add = (platform: string, country: string, region: string, r: GeoRow) => {
    const key = `${platform}\t${country}\t${region}`
    const cur = byKey.get(key) || { platform, country, region, app_opens: 0, plays: 0, play_fails: 0 }
    cur.app_opens += r.app_opens
    cur.plays += r.plays
    cur.play_fails += r.play_fails
    byKey.set(key, cur)
  }
  const countryTotals = new Map<string, number>()
  for (const r of rows) {
    const key = `${r.platform}\t${r.country}`
    countryTotals.set(key, (countryTotals.get(key) || 0) + r.app_opens)
  }
  for (const r of rows) {
    const small = (countryTotals.get(`${r.platform}\t${r.country}`) as number) < k
    const country = small ? FOLDED_COUNTRY : r.country
    const region = small || r.app_opens < k ? FOLDED_REGION : r.region
    add(r.platform, country, region, r)
  }
  return [...byKey.values()].sort(
    (a, b) =>
      a.platform.localeCompare(b.platform) ||
      a.country.localeCompare(b.country) ||
      a.region.localeCompare(b.region),
  )
}

export interface HealthRow {
  streamKey: string
  channelId: string
  hour: string
  n: number
}

export interface HealthReports {
  schema: number
  generatedAt: string
  windowHours: number
  k: number
  minHours: number
  cap: number
  candidates: number
  streams: { streamKey: string; channelId: string; playFails: number; hours: number }[]
}

/**
 * The streams the sync worker may probe early: `{streamKey, channelId, hour, n}` rows from the
 * trailing window, one per stream and hour. A stream qualifies with at least `k` failures over at
 * least `minHours` distinct hours; a pinned channel never qualifies (ADR-0035); at most `n` are
 * listed, most failures first. The document says how many qualified before the cap, so a day the
 * cap bit is visible.
 */
export function healthReports(
  rows: readonly HealthRow[],
  {
    pinned = new Set<string>(),
    k = PLAY_FAIL_K,
    minHours = PLAY_FAIL_MIN_HOURS,
    n = REPORTS_N,
    now,
  }: { pinned?: ReadonlySet<string>; k?: number; minHours?: number; n?: number; now: DateInput },
): HealthReports {
  const byStream = new Map<string, { streamKey: string; channelId: string; playFails: number; hours: Set<string> }>()
  for (const r of rows) {
    if (!STREAM_KEY_RE.test(r.streamKey || '') || !CHANNEL_ID_RE.test(r.channelId || '')) continue
    const cur = byStream.get(r.streamKey) || {
      streamKey: r.streamKey,
      channelId: r.channelId,
      playFails: 0,
      hours: new Set<string>(),
    }
    cur.playFails += r.n
    cur.hours.add(r.hour)
    byStream.set(r.streamKey, cur)
  }
  const qualified = [...byStream.values()]
    .filter((s) => s.playFails >= k && s.hours.size >= minHours && !pinned.has(s.channelId))
    .map((s) => ({ streamKey: s.streamKey, channelId: s.channelId, playFails: s.playFails, hours: s.hours.size }))
    .sort((a, b) => b.playFails - a.playFails || a.streamKey.localeCompare(b.streamKey))
  return {
    schema: REPORTS_SCHEMA,
    generatedAt: new Date(now).toISOString(),
    windowHours: REPORTS_WINDOW_HOURS,
    k,
    minHours,
    cap: n,
    candidates: qualified.length,
    streams: qualified.slice(0, n),
  }
}
