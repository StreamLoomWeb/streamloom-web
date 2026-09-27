import { test, expect } from '@playwright/test'
// FIRST: creates the seam registry the Function modules look for as they are evaluated.
import { resetJwksCache, resetStatsCache } from './support/testSeams'
import { handleStats, assembleStats, waeQueries, CACHE_TTL_S } from '../functions/api/stats'
import { K_ANON, FOLDED_COUNTRY, FOLDED_REGION } from '../functions/api/_lib/telemetryContract'
import { jwks, makeTestKey, mintToken, validPayload, type TestKey } from './support/accessTokens'
import golden from './support/telemetry-golden.json' with { type: 'json' }

/**
 * `GET /api/stats`: behind Access, folded, cached.
 *
 * The handler is called directly with a generated keypair for the Access gate (the same
 * harness `picks-endpoint.spec.ts` uses), a stubbed `fetch` standing in for the team's certs
 * endpoint and for the Analytics Engine SQL API, and a D1 double. The rule every case checks:
 * an unauthenticated request learns nothing and causes no upstream read, and no geography row
 * ever leaves the Function under `K_ANON`.
 */

const ORIGIN = 'https://streamloom.example'
const TEAM = 'https://streamloom.cloudflareaccess.com'
const CERTS = `${TEAM}/cdn-cgi/access/certs`
const AUD = 'b'.repeat(64)
const ACCOUNT = 'a'.repeat(32)
const WAE_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/analytics_engine/sql`

const ENV = {
  CF_ACCESS_TEAM_DOMAIN: TEAM,
  CF_ACCESS_AUD: AUD,
  CF_ACCOUNT_ID: ACCOUNT,
  CF_ANALYTICS_READ_TOKEN: 'read-only-token',
}

type Row = Record<string, unknown>

interface Stub {
  waeCalls: string[]
  certsCalls: number
  rows: (name: string) => Row[]
  restore: () => void
}

function stubFetch(keys: TestKey[], rows: (name: string) => Row[]): Stub {
  const original = globalThis.fetch
  const stub: Stub = { waeCalls: [], certsCalls: 0, rows, restore: () => { globalThis.fetch = original } }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url === CERTS) {
      stub.certsCalls += 1
      return new Response(jwks(...keys), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url === WAE_URL) {
      const sql = String(init?.body ?? '')
      stub.waeCalls.push(sql)
      expect(init?.headers).toMatchObject({ authorization: 'Bearer read-only-token' })
      const name = /streamloom:(?:stats:)?(\w+)/.exec(sql)?.[1] ?? ''
      const data = stub.rows(name)
      return new Response(JSON.stringify({ meta: [], data, rows: data.length }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as typeof fetch
  return stub
}

/** A minimal picks.json bucket, so `readPinned` can exclude a pinned channel from health. */
function makePicksBucket(pinnedChannelIds: string[]) {
  const body = JSON.stringify({
    schema: 1,
    updatedAt: '2026-09-01T00:00:00.000Z',
    groups: pinnedChannelIds.length
      ? [{ title: 'Pinned', items: pinnedChannelIds.map((channelId) => ({ channelId })) }]
      : [],
  })
  return {
    async get(key: string) {
      if (key !== 'catalogue/picks.json') return null
      return { httpEtag: '"x"', json: async <T,>() => JSON.parse(body) as T, text: async () => body }
    },
    async head() { return null },
    async put() { return null },
  }
}

function makeD1(metrics: Row[] = [], runs: Row[] = []) {
  const queries: string[] = []
  const binding = {
    prepare(sql: string) {
      queries.push(sql)
      const statement = {
        bind: () => statement,
        all: async () => ({ results: sql.includes('rollup_runs') ? runs : metrics, meta: { rows_read: sql.includes('rollup_runs') ? runs.length : metrics.length } }),
      }
      return statement
    },
  }
  return { binding, queries }
}

async function call(token: string | null, env: Record<string, unknown>, now = Date.now()) {
  const deferred: Promise<unknown>[] = []
  const headers: Record<string, string> = {}
  if (token) headers['Cf-Access-Jwt-Assertion'] = token
  const request = new Request(`${ORIGIN}/api/stats`, { method: 'GET', headers })
  const res = await handleStats({ request, env, waitUntil: (p) => deferred.push(p) }, now)
  await Promise.allSettled(deferred)
  return res
}

const TODAY = '2026-09-26'
const NOW = Date.parse(`${TODAY}T23:30:00Z`)

/** A payload Access would produce at the fixture's clock, so `now` can be injected. */
const payloadAt = (aud: string) =>
  validPayload(TEAM, aud, { iat: Math.floor(NOW / 1000) - 10, nbf: Math.floor(NOW / 1000) - 10, exp: Math.floor(NOW / 1000) + 3600 })

/** Geography rows the fixture's rollup folded, re-keyed the way the SQL API answers. */
function fixtureRows(name: string): Row[] {
  if (name === 'geo') return golden.rollup.results.geo.map((r) => ({ ...r, day: `${TODAY} 00:00:00` }))
  if (name === 'health') return golden.rollup.results.health
  if (name === 'perf') return golden.rollup.results.perf
  if (name === 'channels') return golden.rollup.results.channels
  if (name === 'hours') return golden.rollup.results.hours
  if (name === 'daily') return golden.rollup.results.metrics.map((r) => ({ ...r, day: `${TODAY} 00:00:00` }))
  return []
}

let key: TestKey
test.beforeAll(async () => {
  key = await makeTestKey('kid-1')
})
test.beforeEach(() => {
  resetJwksCache()
  resetStatsCache()
})

test.describe('the Access gate', () => {
  test('no token: 401, no upstream read of any kind', async () => {
    const stub = stubFetch([key], fixtureRows)
    try {
      const res = await call(null, { ...ENV, TELEMETRY_DB: makeD1().binding })
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'unauthorised' })
      expect(stub.waeCalls).toEqual([])
      expect(stub.certsCalls).toBe(0)
      expect(res.headers.get('cache-control')).toBe('no-store')
    } finally {
      stub.restore()
    }
  })

  test('a token for another audience: 403, no upstream read', async () => {
    const stub = stubFetch([key], fixtureRows)
    try {
      const token = await mintToken({ key, payload: payloadAt('c'.repeat(64)) })
      const res = await call(token, { ...ENV, TELEMETRY_DB: makeD1().binding }, NOW)
      expect(res.status).toBe(403)
      expect(stub.waeCalls).toEqual([])
    } finally {
      stub.restore()
    }
  })

  test('an unsigned (alg: none) token: 401', async () => {
    const stub = stubFetch([key], fixtureRows)
    try {
      const token = await mintToken({ key, payload: payloadAt(AUD), header: { alg: 'none', kid: key.kid }, rawSignature: '' })
      const res = await call(token, ENV, NOW)
      expect(res.status).toBe(401)
      expect(stub.waeCalls).toEqual([])
    } finally {
      stub.restore()
    }
  })

  test('no Access configuration at all: 503, no upstream read', async () => {
    const stub = stubFetch([key], fixtureRows)
    try {
      const token = await mintToken({ key, payload: payloadAt(AUD) })
      const res = await call(token, { CF_ACCOUNT_ID: ACCOUNT, CF_ANALYTICS_READ_TOKEN: 'x' }, NOW)
      expect(res.status).toBe(503)
      expect(stub.waeCalls).toEqual([])
    } finally {
      stub.restore()
    }
  })

  test('a valid token: 200 with every panel, and never the token in the answer', async () => {
    const stub = stubFetch([key], fixtureRows)
    try {
      const token = await mintToken({ key, payload: payloadAt(AUD) })
      const res = await call(token, { ...ENV, TELEMETRY_DB: makeD1().binding, CATALOGUE_BUCKET: makePicksBucket(['PinnedOne.in']) }, NOW)
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(text).not.toContain('read-only-token')
      const body = JSON.parse(text)
      expect(body.sources.wae.ok).toBe(true)
      expect(body.sources.d1.ok).toBe(true)
      expect(Object.keys(body.queries)).toEqual(Object.keys(waeQueries()))
      expect(stub.waeCalls).toHaveLength(Object.keys(waeQueries()).length)
      for (const sql of stub.waeCalls) {
        expect(sql).toContain('SUM(_sample_interval)')
        // Time is never grouped finer than the hour: every time grouping is toStartOfInterval by
        // hour or day, and a query with no time grouping sums a whole window.
        expect(sql).not.toMatch(/INTERVAL '\d+' (MINUTE|SECOND)/)
        if (/AS (hour|day)\b/.test(sql)) expect(sql).toMatch(/toStartOfInterval\(timestamp, INTERVAL '1' (HOUR|DAY)\)/)
      }
      expect(body.today.day).toBe(TODAY)
      expect(body.health.streams).toEqual(golden.rollup.reports.streams)
      expect(res.headers.get('cache-control')).toBe('private, no-store')
    } finally {
      stub.restore()
    }
  })
})

test.describe('the k-anonymity fold, live', () => {
  test('a geography answer never shows a region or country under K_ANON', async () => {
    const stub = stubFetch([key], (name) =>
      name === 'geo'
        ? [
            { platform: 'web', country: 'IN', region: 'MH', event: 'app_open', day: `${TODAY} 00:00:00`, n: 60 },
            { platform: 'web', country: 'IN', region: 'GA', event: 'app_open', day: `${TODAY} 00:00:00`, n: 4 },
            { platform: 'web', country: 'IN', region: 'GA', event: 'play', day: `${TODAY} 00:00:00`, n: 9 },
            { platform: 'web', country: 'NP', region: 'BA', event: 'app_open', day: `${TODAY} 00:00:00`, n: 3 },
            { platform: 'android', country: 'US', region: 'CA', event: 'app_open', day: `${TODAY} 00:00:00`, n: 22 },
            // A region that clears the floor on one day but not another folds on the quiet day only.
            { platform: 'android', country: 'US', region: 'CA', event: 'app_open', day: `2026-09-25 00:00:00`, n: 5 },
          ]
        : [],
    )
    try {
      const token = await mintToken({ key, payload: payloadAt(AUD) })
      const res = await call(token, { ...ENV, TELEMETRY_DB: makeD1().binding }, NOW)
      expect(res.status).toBe(200)
      const body = await res.json()
      const rows: { platform: string; country: string; region: string; app_opens: number; plays: number }[] = body.geo.rows
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) {
        const folded = row.country === FOLDED_COUNTRY || row.region === FOLDED_REGION
        if (!folded) expect(row.app_opens).toBeGreaterThanOrEqual(K_ANON)
      }
      expect(rows.some((r) => r.region === 'GA')).toBe(false)
      expect(rows.some((r) => r.country === 'NP')).toBe(false)
      // The quiet day (5 opens in the whole country) folded to ZZ/* on that day; the busy day's 22 stayed.
      expect(rows.find((r) => r.platform === 'android' && r.country === 'US' && r.region === 'CA')?.app_opens).toBe(22)
      expect(rows.find((r) => r.platform === 'android' && r.country === 'ZZ' && r.region === '*')?.app_opens).toBe(5)
      expect(rows.some((r) => r.platform === 'android' && r.country === 'US' && r.region === '*')).toBe(false)
      expect(rows.find((r) => r.platform === 'web' && r.country === 'IN' && r.region === '*')).toMatchObject({ app_opens: 4, plays: 9 })
      expect(rows.find((r) => r.platform === 'web' && r.country === 'ZZ' && r.region === '*')?.app_opens).toBe(3)
      expect(body.geo.kAnon).toBe(K_ANON)
    } finally {
      stub.restore()
    }
  })
})

test.describe('caching', () => {
  test('a second call within ten minutes answers from the cache without reading upstream', async () => {
    const stub = stubFetch([key], fixtureRows)
    try {
      const token = await mintToken({ key, payload: payloadAt(AUD) })
      const env = { ...ENV, TELEMETRY_DB: makeD1().binding }
      const first = await call(token, env, NOW)
      expect(first.status).toBe(200)
      expect(first.headers.get('x-stats-cache')).toBe('fresh')
      const reads = stub.waeCalls.length
      const second = await call(token, env, NOW + 60_000)
      expect(second.status).toBe(200)
      expect(second.headers.get('x-stats-cache')).toBe('memo')
      expect(stub.waeCalls.length).toBe(reads)
      expect(await second.text()).toBe(await first.text())

      const third = await call(token, env, NOW + CACHE_TTL_S * 1000 + 1)
      expect(third.headers.get('x-stats-cache')).toBe('fresh')
      expect(stub.waeCalls.length).toBe(reads * 2)

      // The cache does not bypass the gate.
      const anon = await call(null, env, NOW + 120_000)
      expect(anon.status).toBe(401)
    } finally {
      stub.restore()
    }
  })
})

test.describe('sources fail soft', () => {
  test('without the WAE secret or the D1 binding the answer still comes, with both marked', async () => {
    const stub = stubFetch([key], fixtureRows)
    try {
      const token = await mintToken({ key, payload: payloadAt(AUD) })
      const res = await call(token, { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD }, NOW)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.sources.wae.ok).toBe(false)
      expect(body.sources.d1.ok).toBe(false)
      expect(stub.waeCalls).toEqual([])
      expect(body.geo.rows).toEqual([])
    } finally {
      stub.restore()
    }
  })
})

test.describe('assembleStats', () => {
  test('reads DAU/WAU/MAU/installs from the flags, and D1 days only beyond the WAE window', () => {
    const body = assembleStats(
      {
        ok: true,
        truncated: [],
        rows: {
          daily: [
            { platform: 'web', event: 'app_open', flags: 'dwmn', error_class: '', bucket: -1, zero: 0, day: `${TODAY} 00:00:00`, n: 2 },
            { platform: 'web', event: 'app_open', flags: 'd', error_class: '', bucket: -1, zero: 0, day: `${TODAY} 00:00:00`, n: 5 },
            { platform: 'web', event: 'app_open', flags: '', error_class: '', bucket: -1, zero: 0, day: `${TODAY} 00:00:00`, n: 3 },
            { platform: 'web', event: 'search', flags: '', error_class: '', bucket: -1, zero: 1, day: `${TODAY} 00:00:00`, n: 4 },
            { platform: 'web', event: 'search', flags: '', error_class: '', bucket: -1, zero: 0, day: `${TODAY} 00:00:00`, n: 6 },
            { platform: 'web', event: 'play_end', flags: '', error_class: '', bucket: 0, zero: 0, day: `${TODAY} 00:00:00`, n: 1 },
            { platform: 'web', event: 'play_end', flags: '', error_class: '', bucket: 3, zero: 0, day: `${TODAY} 00:00:00`, n: 3 },
            { platform: 'web', event: 'play', flags: '', error_class: '', bucket: -1, zero: 0, day: `${TODAY} 00:00:00`, n: 10 },
            { platform: 'web', event: 'play_fail', flags: '', error_class: 'http_5xx', bucket: -1, zero: 0, day: `${TODAY} 00:00:00`, n: 2 },
          ],
        },
      },
      {
        ok: true,
        rowsRead: 3,
        metrics: [
          { day: '2026-01-01', platform: 'web', event: 'app_open', bucket: -1, flag: '', count: 40 },
          { day: '2026-01-01', platform: 'web', event: 'app_open', bucket: -1, flag: 'd', count: 40 },
          { day: '2026-01-01', platform: 'web', event: 'app_open', bucket: -1, flag: 'n', count: 7 },
          // Inside the WAE window: ignored, WAE is authoritative there.
          { day: TODAY, platform: 'web', event: 'app_open', bucket: -1, flag: 'd', count: 999 },
        ],
        runs: [{ day: '2026-09-25', ran_at: '2026-09-26T00:07:00Z', contract: 1, points: 593, rows_written: 120, reports_listed: 1 }],
      },
      { now: NOW },
    )
    const today = body.daily.find((r) => r.day === TODAY)
    expect(today).toMatchObject({ appOpens: 10, dau: 7, wau: 2, mau: 2, installs: 2, plays: 10, playFails: 2, playEnds: 4, searches: 10, zeroSearches: 4, source: 'wae' })
    expect(body.daily.find((r) => r.day === '2026-01-01')).toMatchObject({ appOpens: 40, dau: 40, installs: 7, source: 'd1' })
    expect(body.today.dau).toBe(7)
    expect(body.vsf).toEqual({ plays: 10, playFails: 2, rate: 0.2 })
    expect(body.ebvs).toEqual({ playEnds: 4, exits: 1, share: 0.25 })
    expect(body.watch.estMinutes).toBe(9)
    expect(body.search).toEqual({ total: 10, zero: 4, zeroShare: 0.4 })
    expect(body.errorClasses).toEqual([{ errorClass: 'http_5xx', n: 2 }])
    expect(body.budget.lastRollup?.rowsWritten).toBe(120)
    expect(body.budget.d1RowsReadPerLoad).toBe(3)
  })
})
