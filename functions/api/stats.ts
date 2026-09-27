/**
 * Cloudflare Pages Function: GET /api/stats — the owner's analytics read path (ADR-0047, WO-22).
 *
 * Behind the same Cloudflare Access application as `/admin` and `/api/picks`, and it verifies the
 * Access JWT itself (`_lib/accessJwt.ts`, the one copy) before anything else is looked at: an
 * unauthenticated request learns nothing, not even that the route exists as more than a 401.
 *
 * Two sources, read only, and each fails soft on its own:
 *   - **Workers Analytics Engine** through its SQL API, for the last 90 days (the hot store's
 *     retention). Counts are `SUM(_sample_interval)`, time is truncated with `toStartOfInterval`
 *     before grouping — to the hour where the panel needs hours, to the day where it needs days,
 *     never finer than an hour (ADR-0047, "kept to the hour, everywhere"). The API token is a
 *     Production-only secret scoped to *Account Analytics: Read*; nothing here can write.
 *   - **D1** (`TELEMETRY_DB`, the rollup's tables in `D1_TABLES`) for days older than 90.
 *
 * The k-anonymity fold (`foldGeo`) runs here, live, on every geography row before it leaves the
 * Function — per day and platform, exactly as the rollup does — so a quiet day's live window
 * never shows a region or country under `K_ANON`.
 *
 * Each answer is cached for ten minutes: in this isolate, and in the Cache API where it exists.
 * The cache is consulted only after the Access check passes, and its key carries no identity.
 * The SQL that was sent is returned in the answer (`queries`), so the owner can read the exact
 * dialect that worked against the live dataset — the backend's rollup depends on the same one.
 */

import { authoriseAccessRequest } from './_lib/accessJwt'
import { bindBucket } from './_lib/catalogueBucket'
import { json, readStoredJson, refuse } from './_lib/httpJson'
import { pinnedIds, type PicksDocument } from './_lib/picksSchema'
import {
  BUCKET_EDGES,
  K_ANON,
  PERF_METRICS,
  PERF_METRIC_KIND,
  PLAY_FAIL_K,
  REPORTS_N,
  TELEMETRY_VERSION,
  WAE_DATASET,
  WATCH_BUCKET_EST_MIN,
  WATCH_EDGES_S,
  foldGeo,
  healthReports,
  percentileFromBuckets,
  type BucketKind,
  type GeoRow,
  type HealthReports,
  type PerfMetric,
} from './_lib/telemetryContract'

export interface StatsContext {
  request: Request
  env: unknown
  waitUntil: (promise: Promise<unknown>) => void
}

/** Days the headline panels cover. */
export const HEADLINE_DAYS = 30
/** Days WAE can still answer for directly; older days come from D1. */
export const WAE_DAYS = 90
/** How far back the daily series reaches, WAE plus D1. */
export const SERIES_DAYS = 365
/** How long one answer is reused. */
export const CACHE_TTL_S = 600

/** The free-tier ceilings the budget panel measures against (ADR-0047, verified 2026-09). */
export const CAPS = Object.freeze({
  waePointsPerDay: 100_000,
  waeReadsPerDay: 10_000,
  d1RowsReadPerDay: 5_000_000,
  d1RowsWrittenPerDay: 100_000,
  workersRequestsPerDay: 100_000,
  /** The owner's rule: stay under this share of every cap. */
  rule: 0.8,
})

const WAE_ROW_LIMIT = 10_000

/**
 * The SQL sent to the Analytics Engine SQL API. Written in the dialect the backend's golden
 * fixture uses (`queries` in `telemetry-golden.json`), which could not be verified offline; the
 * live answer carries these back so the dialect that worked is on record.
 */
export function waeQueries(): Record<string, string> {
  const from = `FROM ${WAE_DATASET}`
  return {
    daily:
      `/* streamloom:stats:daily */\n` +
      `SELECT blob1 AS platform, blob2 AS event, blob10 AS flags, blob8 AS error_class, double1 AS bucket, double3 AS zero,\n` +
      `       toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, SUM(_sample_interval) AS n\n` +
      `${from}\nWHERE timestamp > NOW() - INTERVAL '${WAE_DAYS}' DAY\n` +
      `GROUP BY platform, event, flags, error_class, bucket, zero, day\nORDER BY day\nLIMIT ${WAE_ROW_LIMIT}`,
    hours:
      `/* streamloom:stats:hours */\n` +
      `SELECT blob1 AS platform, blob2 AS event, toStartOfInterval(timestamp, INTERVAL '1' HOUR) AS hour, SUM(_sample_interval) AS n\n` +
      `${from}\nWHERE timestamp > NOW() - INTERVAL '${HEADLINE_DAYS}' DAY AND blob2 IN ('app_open', 'play')\n` +
      `GROUP BY platform, event, hour\nORDER BY hour\nLIMIT ${WAE_ROW_LIMIT}`,
    geo:
      `/* streamloom:stats:geo */\n` +
      `SELECT blob1 AS platform, blob4 AS country, blob5 AS region, blob2 AS event,\n` +
      `       toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, SUM(_sample_interval) AS n\n` +
      `${from}\nWHERE timestamp > NOW() - INTERVAL '${HEADLINE_DAYS}' DAY AND blob2 IN ('app_open', 'play', 'play_fail')\n` +
      `GROUP BY platform, country, region, event, day\nORDER BY n DESC\nLIMIT ${WAE_ROW_LIMIT}`,
    channels:
      `/* streamloom:stats:channels */\n` +
      `SELECT blob1 AS platform, blob6 AS channel_id, blob2 AS event, double1 AS bucket, SUM(_sample_interval) AS n\n` +
      `${from}\nWHERE timestamp > NOW() - INTERVAL '${HEADLINE_DAYS}' DAY AND blob2 IN ('play', 'play_fail', 'play_end') AND blob6 != ''\n` +
      `GROUP BY platform, channel_id, event, bucket\nORDER BY n DESC\nLIMIT 9000`,
    perf:
      `/* streamloom:stats:perf */\n` +
      `SELECT blob1 AS platform, blob9 AS metric, double1 AS bucket, SUM(_sample_interval) AS n\n` +
      `${from}\nWHERE timestamp > NOW() - INTERVAL '${HEADLINE_DAYS}' DAY AND blob2 = 'perf'\n` +
      `GROUP BY platform, metric, bucket`,
    health:
      `/* streamloom:health */\n` +
      `SELECT blob7 AS stream_key, blob6 AS channel_id, toStartOfInterval(timestamp, INTERVAL '1' HOUR) AS hour, SUM(_sample_interval) AS n\n` +
      `${from}\nWHERE blob2 = 'play_fail' AND timestamp > NOW() - INTERVAL '24' HOUR\n` +
      `GROUP BY stream_key, channel_id, hour`,
  }
}

type Row = Record<string, unknown>

export interface WaeResults {
  ok: boolean
  error?: string
  rows: Record<string, Row[]>
  /** Names of queries whose answer hit the row limit and may be incomplete. */
  truncated: string[]
}

export interface D1Results {
  ok: boolean
  error?: string
  metrics: Row[]
  runs: Row[]
  rowsRead: number
}

// ---- Assembly (pure; tested directly) ----

export interface DailyRow {
  day: string
  platform: string
  appOpens: number
  dau: number
  wau: number
  mau: number
  installs: number
  plays: number
  playFails: number
  playEnds: number
  guideOpens: number
  searches: number
  zeroSearches: number
  points: number
  /** Where the row came from. */
  source: 'wae' | 'd1'
}

export interface ChannelRow {
  platform: string
  channelId: string
  plays: number
  playFails: number
  successRate: number | null
  playEnds: number
  watchBuckets: number[]
  watchEstMin: number
}

export interface PerfPanel {
  metric: PerfMetric
  kind: BucketKind
  edges: readonly number[]
  counts: number[]
  total: number
  p50: number | null
  p95: number | null
  p99: number | null
}

export interface StatsBody {
  generatedAt: string
  contract: number
  windows: { headlineDays: number; waeDays: number; seriesDays: number }
  sources: {
    wae: { ok: boolean; error?: string; queries: number; truncated: string[] }
    d1: { ok: boolean; error?: string; rowsRead: number }
  }
  today: { day: string; appOpens: number; dau: number; installs: number; plays: number; playFails: number; playEnds: number; guideOpens: number; searches: number; points: number }
  daily: DailyRow[]
  hours: { hour: number; appOpens: number; plays: number }[]
  geo: { rows: GeoRow[]; kAnon: number; days: number; truncated: boolean }
  channels: ChannelRow[]
  errorClasses: { errorClass: string; n: number }[]
  perf: PerfPanel[]
  vsf: { plays: number; playFails: number; rate: number | null }
  ebvs: { playEnds: number; exits: number; share: number | null }
  watch: { playEnds: number; estMinutes: number; buckets: number[]; edges: readonly number[] }
  search: { total: number; zero: number; zeroShare: number | null }
  health: HealthReports & { threshold: number; cap: number }
  budget: {
    waePointsToday: number
    waePointsPeakDay: number
    waeReadsPerUncachedLoad: number
    waeReadsPerDayIfUncached: number
    d1RowsReadPerLoad: number
    d1RowsWrittenLastRollup: number | null
    lastRollup: { day: string; ranAt: string; points: number; rowsWritten: number; reportsListed: number } | null
    caps: typeof CAPS
  }
  queries: Record<string, string>
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0)
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))
/** `2026-09-26 02:00:00`, `2026-09-26T02:00:00Z` or `2026-09-26` → `2026-09-26`. */
const dayOf = (v: unknown): string => str(v).slice(0, 10)
const hourOf = (v: unknown): number => {
  const s = str(v)
  const h = Number(s.slice(11, 13))
  return Number.isInteger(h) && h >= 0 && h < 24 ? h : -1
}

function emptyDaily(day: string, platform: string, source: 'wae' | 'd1'): DailyRow {
  return {
    day, platform, appOpens: 0, dau: 0, wau: 0, mau: 0, installs: 0, plays: 0, playFails: 0, playEnds: 0,
    guideOpens: 0, searches: 0, zeroSearches: 0, points: 0, source,
  }
}

function addEvent(row: DailyRow, event: string, flags: string, zero: number, n: number): void {
  row.points += n
  switch (event) {
    case 'app_open':
      row.appOpens += n
      if (flags.includes('d')) row.dau += n
      if (flags.includes('w')) row.wau += n
      if (flags.includes('m')) row.mau += n
      if (flags.includes('n')) row.installs += n
      break
    case 'play': row.plays += n; break
    case 'play_fail': row.playFails += n; break
    case 'play_end': row.playEnds += n; break
    case 'guide_open': row.guideOpens += n; break
    case 'search':
      row.searches += n
      if (zero === 1) row.zeroSearches += n
      break
    default:
      break
  }
}

function emptyPerf(metric: PerfMetric): PerfPanel {
  const kind = PERF_METRIC_KIND[metric]
  const edges = BUCKET_EDGES[kind]
  return { metric, kind, edges, counts: new Array(edges.length + 1).fill(0), total: 0, p50: null, p95: null, p99: null }
}

export function assembleStats(
  wae: WaeResults,
  d1: D1Results,
  { now, pinned = new Set<string>(), queries = waeQueries() }: { now: number; pinned?: ReadonlySet<string>; queries?: Record<string, string> },
): StatsBody {
  const today = new Date(now).toISOString().slice(0, 10)
  const waeCutoff = new Date(now - WAE_DAYS * 86400000).toISOString().slice(0, 10)
  const seriesStart = new Date(now - SERIES_DAYS * 86400000).toISOString().slice(0, 10)
  const headlineStart = new Date(now - HEADLINE_DAYS * 86400000).toISOString().slice(0, 10)

  // Daily series: WAE for the hot window, D1 for what is older.
  const daily = new Map<string, DailyRow>()
  const dailyRow = (day: string, platform: string, source: 'wae' | 'd1') => {
    const key = `${day}\t${platform}`
    let row = daily.get(key)
    if (!row) {
      row = emptyDaily(day, platform, source)
      daily.set(key, row)
    }
    return row
  }
  const errorClasses = new Map<string, number>()
  for (const r of wae.rows.daily ?? []) {
    const day = dayOf(r.day)
    if (day < waeCutoff) continue
    const platform = str(r.platform)
    const event = str(r.event)
    const n = num(r.n)
    addEvent(dailyRow(day, platform, 'wae'), event, str(r.flags), num(r.zero), n)
    if (event === 'play_fail' && day >= headlineStart) {
      const k = str(r.error_class) || 'other'
      errorClasses.set(k, (errorClasses.get(k) ?? 0) + n)
    }
  }
  for (const r of d1.metrics) {
    const day = dayOf(r.day)
    if (day >= waeCutoff || day < seriesStart) continue
    const platform = str(r.platform)
    const event = str(r.event)
    const flag = str(r.flag)
    const n = num(r.count)
    const row = dailyRow(day, platform, 'd1')
    // daily_metrics keeps the plain count under flag '' and a breakdown under a named flag: the
    // period-first letters for app_open, `zero` for search, the error class for play_fail. Only
    // the plain row is a count of events; the named rows are read where the series needs them.
    if (event === 'app_open') {
      if (flag === '') { row.appOpens += n; row.points += n }
      else if (flag === 'd') row.dau += n
      else if (flag === 'w') row.wau += n
      else if (flag === 'm') row.mau += n
      else if (flag === 'n') row.installs += n
    } else if (event === 'search' && flag === 'zero') {
      row.zeroSearches += n
    } else if (flag === '') {
      addEvent(row, event, '', 0, n)
    }
  }
  const dailyRows = [...daily.values()].sort((a, b) => a.day.localeCompare(b.day) || a.platform.localeCompare(b.platform))

  const todayTotals = { day: today, appOpens: 0, dau: 0, installs: 0, plays: 0, playFails: 0, playEnds: 0, guideOpens: 0, searches: 0, points: 0 }
  const pointsByDay = new Map<string, number>()
  for (const r of dailyRows) {
    pointsByDay.set(r.day, (pointsByDay.get(r.day) ?? 0) + r.points)
    if (r.day !== today) continue
    todayTotals.appOpens += r.appOpens
    todayTotals.dau += r.dau
    todayTotals.installs += r.installs
    todayTotals.plays += r.plays
    todayTotals.playFails += r.playFails
    todayTotals.playEnds += r.playEnds
    todayTotals.guideOpens += r.guideOpens
    todayTotals.searches += r.searches
    todayTotals.points += r.points
  }

  // Hour of day, over the headline window.
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, appOpens: 0, plays: 0 }))
  for (const r of wae.rows.hours ?? []) {
    const h = hourOf(r.hour)
    if (h < 0) continue
    const n = num(r.n)
    if (str(r.event) === 'app_open') hours[h].appOpens += n
    else if (str(r.event) === 'play') hours[h].plays += n
  }

  // Geography: fold per day and platform (the rollup's unit), then sum the folded rows.
  const perDay = new Map<string, Map<string, GeoRow>>()
  for (const r of wae.rows.geo ?? []) {
    const day = dayOf(r.day)
    const platform = str(r.platform)
    const country = str(r.country)
    const region = str(r.region)
    const key = `${platform}\t${country}\t${region}`
    let rows = perDay.get(day)
    if (!rows) {
      rows = new Map()
      perDay.set(day, rows)
    }
    const cur = rows.get(key) ?? { platform, country, region, app_opens: 0, plays: 0, play_fails: 0 }
    const n = num(r.n)
    if (str(r.event) === 'app_open') cur.app_opens += n
    else if (str(r.event) === 'play') cur.plays += n
    else if (str(r.event) === 'play_fail') cur.play_fails += n
    rows.set(key, cur)
  }
  const geoTotals = new Map<string, GeoRow>()
  for (const rows of perDay.values()) {
    for (const folded of foldGeo([...rows.values()])) {
      const key = `${folded.platform}\t${folded.country}\t${folded.region}`
      const cur = geoTotals.get(key) ?? { ...folded, app_opens: 0, plays: 0, play_fails: 0 }
      cur.app_opens += folded.app_opens
      cur.plays += folded.plays
      cur.play_fails += folded.play_fails
      geoTotals.set(key, cur)
    }
  }
  // A second fold over the summed rows: a region that was folded on every quiet day but not on
  // one busy day stays visible only if its visible total still clears the floor.
  const geo = foldGeo([...geoTotals.values()]).sort((a, b) => b.app_opens - a.app_opens || a.country.localeCompare(b.country))

  // Channels.
  const channels = new Map<string, ChannelRow>()
  for (const r of wae.rows.channels ?? []) {
    const platform = str(r.platform)
    const channelId = str(r.channel_id)
    if (!channelId) continue
    const key = `${platform}\t${channelId}`
    const cur = channels.get(key) ?? {
      platform, channelId, plays: 0, playFails: 0, successRate: null, playEnds: 0,
      watchBuckets: new Array(WATCH_EDGES_S.length + 1).fill(0), watchEstMin: 0,
    }
    const n = num(r.n)
    const event = str(r.event)
    if (event === 'play') cur.plays += n
    else if (event === 'play_fail') cur.playFails += n
    else if (event === 'play_end') {
      cur.playEnds += n
      const b = num(r.bucket)
      if (Number.isInteger(b) && b >= 0 && b < cur.watchBuckets.length) {
        cur.watchBuckets[b] += n
        cur.watchEstMin += n * WATCH_BUCKET_EST_MIN[b]
      }
    }
    channels.set(key, cur)
  }
  const channelRows = [...channels.values()]
    .map((c) => ({ ...c, successRate: c.plays > 0 ? Math.max(0, 1 - c.playFails / c.plays) : null, watchEstMin: Math.round(c.watchEstMin * 10) / 10 }))
    .sort((a, b) => b.plays - a.plays || a.channelId.localeCompare(b.channelId))
    .slice(0, 50)

  // Perf: one panel per metric, summed across platforms.
  const perf = new Map<PerfMetric, PerfPanel>(PERF_METRICS.map((m) => [m, emptyPerf(m)]))
  for (const r of wae.rows.perf ?? []) {
    const metric = str(r.metric) as PerfMetric
    const panel = perf.get(metric)
    if (!panel) continue
    const b = num(r.bucket)
    if (!Number.isInteger(b) || b < 0 || b >= panel.counts.length) continue
    panel.counts[b] += num(r.n)
  }
  const perfPanels = [...perf.values()].map((panel) => {
    const total = panel.counts.reduce((a, b) => a + b, 0)
    const pct = (p: number) => percentileFromBuckets(panel.counts, panel.edges, p)
    return { ...panel, total, p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) }
  })

  // Headline ratios over the headline window.
  let plays = 0, playFails = 0, playEnds = 0, searches = 0, zeroSearches = 0
  const watchBuckets = new Array(WATCH_EDGES_S.length + 1).fill(0)
  for (const r of dailyRows) {
    if (r.day < headlineStart || r.source !== 'wae') continue
    plays += r.plays
    playFails += r.playFails
    playEnds += r.playEnds
    searches += r.searches
    zeroSearches += r.zeroSearches
  }
  for (const r of wae.rows.daily ?? []) {
    if (str(r.event) !== 'play_end' || dayOf(r.day) < headlineStart) continue
    const b = num(r.bucket)
    if (Number.isInteger(b) && b >= 0 && b < watchBuckets.length) watchBuckets[b] += num(r.n)
  }
  const watchEstMin = watchBuckets.reduce((sum, n, i) => sum + n * WATCH_BUCKET_EST_MIN[i], 0)

  // Health: the live 24-hour window, the way the rollup lists it.
  const healthRows = (wae.rows.health ?? []).map((r) => ({
    streamKey: str(r.stream_key), channelId: str(r.channel_id), hour: str(r.hour), n: num(r.n),
  }))
  const health = healthReports(healthRows, { pinned, now })

  const runs = d1.runs
    .map((r) => ({ day: str(r.day), ranAt: str(r.ran_at), points: num(r.points), rowsWritten: num(r.rows_written), reportsListed: num(r.reports_listed) }))
    .sort((a, b) => b.day.localeCompare(a.day))
  const lastRollup = runs[0] ?? null

  const queryCount = Object.keys(queries).length
  return {
    generatedAt: new Date(now).toISOString(),
    contract: TELEMETRY_VERSION,
    windows: { headlineDays: HEADLINE_DAYS, waeDays: WAE_DAYS, seriesDays: SERIES_DAYS },
    sources: {
      wae: { ok: wae.ok, ...(wae.error ? { error: wae.error } : {}), queries: queryCount, truncated: wae.truncated },
      d1: { ok: d1.ok, ...(d1.error ? { error: d1.error } : {}), rowsRead: d1.rowsRead },
    },
    today: todayTotals,
    daily: dailyRows,
    hours,
    geo: { rows: geo, kAnon: K_ANON, days: HEADLINE_DAYS, truncated: wae.truncated.includes('geo') },
    channels: channelRows,
    errorClasses: [...errorClasses.entries()].map(([errorClass, n]) => ({ errorClass, n })).sort((a, b) => b.n - a.n),
    perf: perfPanels,
    vsf: { plays, playFails, rate: plays > 0 ? playFails / plays : null },
    ebvs: { playEnds, exits: watchBuckets[0], share: playEnds > 0 ? watchBuckets[0] / playEnds : null },
    watch: { playEnds, estMinutes: Math.round(watchEstMin), buckets: watchBuckets, edges: WATCH_EDGES_S },
    search: { total: searches, zero: zeroSearches, zeroShare: searches > 0 ? zeroSearches / searches : null },
    health: { ...health, threshold: PLAY_FAIL_K, cap: REPORTS_N },
    budget: {
      waePointsToday: pointsByDay.get(today) ?? 0,
      waePointsPeakDay: Math.max(0, ...pointsByDay.values()),
      waeReadsPerUncachedLoad: queryCount,
      waeReadsPerDayIfUncached: queryCount * Math.ceil(86400 / CACHE_TTL_S),
      d1RowsReadPerLoad: d1.rowsRead,
      d1RowsWrittenLastRollup: lastRollup ? lastRollup.rowsWritten : null,
      lastRollup,
      caps: CAPS,
    },
    queries,
  }
}

// ---- Sources ----

interface WaeConfig {
  accountId: string
  token: string
}

function readWaeConfig(env: unknown): WaeConfig | null {
  const e = (typeof env === 'object' && env !== null ? env : {}) as Record<string, unknown>
  const accountId = typeof e.CF_ACCOUNT_ID === 'string' ? e.CF_ACCOUNT_ID.trim() : ''
  const token = typeof e.CF_ANALYTICS_READ_TOKEN === 'string' ? e.CF_ANALYTICS_READ_TOKEN.trim() : ''
  if (!/^[0-9a-f]{32}$/.test(accountId) || token.length === 0 || token.length > 512) return null
  return { accountId, token }
}

const WAE_TIMEOUT_MS = 20_000

/** The SQL API endpoint; overridable for the local smoke test only, never from a request. */
function waeSqlUrl(env: unknown, accountId: string): string {
  const e = (typeof env === 'object' && env !== null ? env : {}) as Record<string, unknown>
  const override = typeof e.WAE_SQL_URL_OVERRIDE === 'string' ? e.WAE_SQL_URL_OVERRIDE : ''
  if (override && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(override)) return override
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`
}

async function runWae(env: unknown, queries: Record<string, string>): Promise<WaeResults> {
  const config = readWaeConfig(env)
  if (!config) {
    return { ok: false, error: 'CF_ACCOUNT_ID or CF_ANALYTICS_READ_TOKEN is not set (Production-only secret)', rows: {}, truncated: [] }
  }
  const url = waeSqlUrl(env, config.accountId)
  const rows: Record<string, Row[]> = {}
  const truncated: string[] = []
  const errors: string[] = []
  await Promise.all(
    Object.entries(queries).map(async ([name, sql]) => {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), WAE_TIMEOUT_MS)
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${config.token}`, 'content-type': 'text/plain; charset=utf-8' },
          body: sql,
          signal: ctl.signal,
        })
        if (!res.ok) {
          // The status alone: an error body could echo the query or the account, never the token,
          // but nothing from it is needed to say the read failed.
          errors.push(`${name}: HTTP ${res.status}`)
          return
        }
        const body = (await res.json()) as { data?: unknown; rows?: unknown }
        const data = Array.isArray(body.data) ? (body.data as Row[]) : []
        rows[name] = data
        if (data.length >= WAE_ROW_LIMIT || (name === 'channels' && data.length >= 9000)) truncated.push(name)
      } catch (err) {
        errors.push(`${name}: ${err instanceof Error ? err.name : 'failed'}`)
      } finally {
        clearTimeout(timer)
      }
    }),
  )
  return { ok: errors.length === 0, ...(errors.length ? { error: errors.join('; ') } : {}), rows, truncated }
}

interface D1Statement {
  bind: (...values: unknown[]) => D1Statement
  all: <T = Row>() => Promise<{ results?: T[]; meta?: { rows_read?: number } }>
}
interface D1Binding {
  prepare: (sql: string) => D1Statement
}

function bindD1(env: unknown): D1Binding | null {
  const raw = (env as { TELEMETRY_DB?: unknown } | undefined)?.TELEMETRY_DB
  if (typeof raw !== 'object' || raw === null) return null
  const prepare = (raw as Record<string, unknown>).prepare
  if (typeof prepare !== 'function') return null
  return { prepare: (sql) => (prepare as (s: string) => D1Statement).call(raw, sql) }
}

async function runD1(env: unknown, now: number): Promise<D1Results> {
  const db = bindD1(env)
  if (!db) return { ok: false, error: 'TELEMETRY_DB is not a D1 binding on this project', metrics: [], runs: [], rowsRead: 0 }
  const waeCutoff = new Date(now - WAE_DAYS * 86400000).toISOString().slice(0, 10)
  const seriesStart = new Date(now - SERIES_DAYS * 86400000).toISOString().slice(0, 10)
  let rowsRead = 0
  try {
    const metrics = await db
      .prepare('SELECT day, platform, event, bucket, flag, count FROM daily_metrics WHERE day >= ?1 AND day < ?2 ORDER BY day')
      .bind(seriesStart, waeCutoff)
      .all()
    rowsRead += metrics.meta?.rows_read ?? 0
    const runs = await db.prepare('SELECT day, ran_at, contract, points, rows_written, reports_listed FROM rollup_runs ORDER BY day DESC LIMIT 14').all()
    rowsRead += runs.meta?.rows_read ?? 0
    return { ok: true, metrics: metrics.results ?? [], runs: runs.results ?? [], rowsRead }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : 'D1 read failed', metrics: [], runs: [], rowsRead }
  }
}

async function readPinned(env: unknown): Promise<Set<string>> {
  try {
    const bucket = bindBucket(env)
    if (!bucket) return new Set()
    const object = await bucket.get('catalogue/picks.json')
    if (!object) return new Set()
    const document = await readStoredJson<PicksDocument>(object)
    return document ? new Set(pinnedIds(document)) : new Set()
  } catch {
    return new Set()
  }
}

// ---- Cache ----

interface Memo {
  body: string
  at: number
}
let memo: Memo | null = null

{
  const seams = (globalThis as { __streamloomTestSeams?: Record<string, unknown> }).__streamloomTestSeams
  if (seams) seams.resetStatsCache = () => { memo = null }
}

const CACHE_KEY_PATH = `/api/stats/cache/v${TELEMETRY_VERSION}`

function cacheStore(): { match: (key: Request) => Promise<Response | undefined>; put: (key: Request, res: Response) => Promise<void> } | null {
  const caches = (globalThis as { caches?: { default?: unknown } }).caches
  const store = caches?.default as { match?: unknown; put?: unknown } | undefined
  if (!store || typeof store.match !== 'function' || typeof store.put !== 'function') return null
  return store as { match: (key: Request) => Promise<Response | undefined>; put: (key: Request, res: Response) => Promise<void> }
}

const answer = (body: string, hit: 'memo' | 'edge' | 'fresh'): Response =>
  new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Per-identity, behind Access: nothing between the Function and the browser may keep it.
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Stats-Cache': hit,
    },
  })

export async function handleStats(context: StatsContext, now: number = Date.now()): Promise<Response> {
  const { request, env, waitUntil } = context

  const auth = await authoriseAccessRequest(request, env, now)
  if (!auth.ok) return refuse('stats', auth)

  if (request.method.toUpperCase() !== 'GET') return json({ error: 'method-not-allowed' }, 405, { Allow: 'GET' })

  if (memo && now - memo.at < CACHE_TTL_S * 1000) return answer(memo.body, 'memo')

  const cacheKey = new Request(new URL(CACHE_KEY_PATH, request.url).toString(), { method: 'GET' })
  const store = cacheStore()
  if (store) {
    try {
      const cached = await store.match(cacheKey)
      if (cached) {
        const body = await cached.text()
        memo = { body, at: now }
        return answer(body, 'edge')
      }
    } catch {
      // The edge cache is an optimisation; a miss or an error just means a fresh read.
    }
  }

  const queries = waeQueries()
  const [wae, d1, pinned] = await Promise.all([runWae(env, queries), runD1(env, now), readPinned(env)])
  const body = JSON.stringify(assembleStats(wae, d1, { now, pinned, queries }))
  memo = { body, at: now }
  if (store) {
    const copy = new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${CACHE_TTL_S}` },
    })
    waitUntil(store.put(cacheKey, copy).catch(() => {}))
  }
  return answer(body, 'fresh')
}

export const onRequest = (context: StatsContext): Promise<Response> => handleStats(context)
