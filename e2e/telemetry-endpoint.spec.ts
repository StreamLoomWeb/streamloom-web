import { test, expect } from '@playwright/test'
// FIRST: creates the seam registry the Function modules look for as they are evaluated.
import { resetActiveIdsCache } from './support/testSeams'
import { handleTelemetry, ACTIVE_IDS_TTL_MS } from '../functions/api/t'
import { MAX_BATCH_BYTES, waePoint, validateBatch, type WaePoint } from '../functions/api/_lib/telemetryContract'
import golden from './support/telemetry-golden.json' with { type: 'json' }

/**
 * `POST /api/t`, attacked and opted out of.
 *
 * The handler is called directly with an in-memory Analytics Engine double that records every
 * point, and an R2 double serving `catalogue/active-channel-ids.json`. What every case checks:
 * a refused or opted-out request writes **nothing**, an accepted one writes exactly `waePoint()`
 * for each accepted event, and nothing about the request itself is ever kept.
 */

const ORIGIN = 'https://streamloom.example'
const LIVE_IDS = ['AlphaNews.in', 'Gamma.us', 'ch1.xx']

function makeDataset() {
  const points: WaePoint[] = []
  return { binding: { writeDataPoint: (p: WaePoint) => void points.push(p) }, points }
}

function makeBucket(ids: string[] | null, fault: 'none' | 'throw' | 'garbage' = 'none') {
  let reads = 0
  const bucket = {
    async get(key: string) {
      reads += 1
      if (fault === 'throw') throw new Error('r2 down')
      if (key !== 'catalogue/active-channel-ids.json' || ids === null) return null
      const body = fault === 'garbage' ? '{"nope":' : JSON.stringify({ ids })
      return {
        httpEtag: '"x"',
        json: async <T,>() => JSON.parse(body) as T,
        text: async () => body,
      }
    },
    async head() {
      return null
    },
    async put() {
      return null
    },
  }
  return { bucket, reads: () => reads }
}

interface Options {
  headers?: Record<string, string>
  method?: string
  cf?: Record<string, unknown>
  bodyRead?: { value: boolean }
}

function makeRequest(body: string | null, { headers = {}, method = 'POST', cf, bodyRead }: Options = {}): Request {
  let init: RequestInit = {
    method,
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
  }
  if (body !== null && method !== 'GET') {
    // A stream so a test can prove the body was never pulled.
    const bytes = new TextEncoder().encode(body)
    // highWaterMark 0: `pull` runs only when the body is actually read, not at construction,
    // so `bodyRead` is a true record of whether the handler consumed it.
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (bodyRead) bodyRead.value = true
          controller.enqueue(bytes)
          controller.close()
        },
      },
      { highWaterMark: 0 },
    )
    init = { ...init, body: stream, duplex: 'half' } as RequestInit
  }
  const request = new Request(`${ORIGIN}/api/t`, init)
  if (cf) Object.defineProperty(request, 'cf', { value: cf })
  return request
}

async function call(request: Request, env: Record<string, unknown>) {
  const deferred: Promise<unknown>[] = []
  const res = await handleTelemetry({ request, env, waitUntil: (p) => deferred.push(p) })
  await Promise.allSettled(deferred)
  return res
}

const VALID = golden.examples.validBatch.batch
const CF = { country: 'IN', regionCode: 'MH', colo: 'BOM' }

test.beforeEach(() => resetActiveIdsCache())

test.describe('opt-out signals', () => {
  for (const header of ['sec-gpc', 'dnt']) {
    test(`${header}: 1 answers 204 without reading the body or writing a point`, async () => {
      const { binding, points } = makeDataset()
      const { bucket, reads } = makeBucket(LIVE_IDS)
      const bodyRead = { value: false }
      const res = await call(makeRequest(JSON.stringify(VALID), { headers: { [header]: '1' }, cf: CF, bodyRead }), {
        TELEMETRY: binding,
        CATALOGUE_BUCKET: bucket,
      })
      expect(res.status).toBe(204)
      expect(await res.text()).toBe('')
      expect(points).toEqual([])
      expect(bodyRead.value).toBe(false)
      expect(reads()).toBe(0)
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    })
  }

  test('a GPC value other than 1 is not an opt-out', async () => {
    const { binding, points } = makeDataset()
    const res = await call(makeRequest(JSON.stringify(VALID), { headers: { 'sec-gpc': '0' }, cf: CF }), {
      TELEMETRY: binding,
      CATALOGUE_BUCKET: makeBucket(LIVE_IDS).bucket,
    })
    expect(res.status).toBe(202)
    expect(points.length).toBeGreaterThan(0)
  })
})

test.describe('an accepted batch', () => {
  test('writes exactly waePoint() per accepted event with the edge-derived geography', async () => {
    const { binding, points } = makeDataset()
    const res = await call(makeRequest(JSON.stringify(VALID), { cf: CF }), {
      TELEMETRY: binding,
      CATALOGUE_BUCKET: makeBucket(LIVE_IDS).bucket,
    })
    expect(res.status).toBe(202)
    expect(res.headers.get('x-telemetry-dropped')).toBe('0')
    expect(await res.text()).toBe('')
    expect(points).toEqual(golden.examples.waePoints)
    // Nothing that could name the sender is in any blob or double.
    for (const point of points) {
      for (const blob of point.blobs) expect(blob).not.toMatch(/\d+\.\d+\.\d+\.\d+|Mozilla|BOM/)
      expect(point.blobs).toHaveLength(10)
      expect(point.doubles).toHaveLength(4)
    }
  })

  test('folds a missing or unusable cf geography into ZZ/* rather than refusing', async () => {
    const { binding, points } = makeDataset()
    const res = await call(makeRequest(JSON.stringify({ v: 1, p: 'web', a: '1.0', b: [{ e: 'guide_open' }] })), {
      TELEMETRY: binding,
      CATALOGUE_BUCKET: makeBucket(LIVE_IDS).bucket,
    })
    expect(res.status).toBe(202)
    expect(points).toEqual([waePoint({ e: 'guide_open' }, { platform: 'web', appVersion: '1.0', country: null, region: null })])
    expect(points[0].blobs[3]).toBe('ZZ')
    expect(points[0].blobs[4]).toBe('*')
  })

  test('emits no CORS header, and refuses a cross-site post and a preflight', async () => {
    const { binding, points } = makeDataset()
    const env = { TELEMETRY: binding, CATALOGUE_BUCKET: makeBucket(LIVE_IDS).bucket }
    const ok = await call(makeRequest(JSON.stringify(VALID), { cf: CF }), env)
    expect(ok.headers.get('access-control-allow-origin')).toBeNull()

    const cross = await call(makeRequest(JSON.stringify(VALID), { headers: { 'sec-fetch-site': 'cross-site' } }), env)
    expect(cross.status).toBe(403)
    const preflight = await call(makeRequest(null, { method: 'OPTIONS' }), env)
    expect(preflight.status).toBe(405)
    const get = await call(makeRequest(null, { method: 'GET' }), env)
    expect(get.status).toBe(405)
    expect(points).toHaveLength(golden.examples.waePoints.length)
  })
})

test.describe('a refused batch writes nothing and carries validateBatch\'s reason', () => {
  for (const { why, batch, result } of golden.examples.refusedBatches) {
    test(why, async () => {
      const { binding, points } = makeDataset()
      const res = await call(makeRequest(JSON.stringify(batch), { cf: CF }), {
        TELEMETRY: binding,
        CATALOGUE_BUCKET: makeBucket(LIVE_IDS).bucket,
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'refused', reason: result.reason })
      expect(points).toEqual([])
    })
  }

  test('a body that is not JSON', async () => {
    const { binding, points } = makeDataset()
    const res = await call(makeRequest('{"v":1,', { cf: CF }), {
      TELEMETRY: binding,
      CATALOGUE_BUCKET: makeBucket(LIVE_IDS).bucket,
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'refused', reason: 'not JSON' })
    expect(points).toEqual([])
  })

  test('an over-size body is refused by its declared length before it is read, and by its real length after', async () => {
    const { binding, points } = makeDataset()
    const env = { TELEMETRY: binding, CATALOGUE_BUCKET: makeBucket(LIVE_IDS).bucket }
    const bodyRead = { value: false }
    const declared = await call(
      makeRequest('{}', { headers: { 'content-length': String(MAX_BATCH_BYTES + 1) }, bodyRead }),
      env,
    )
    expect(declared.status).toBe(400)
    expect(await declared.json()).toEqual({ error: 'refused', reason: `over ${MAX_BATCH_BYTES} bytes` })
    expect(bodyRead.value).toBe(false)

    const big = JSON.stringify({ v: 1, p: 'web', a: '1.0', b: Array.from({ length: 20 }, () => ({ e: 'guide_open' })) }) + ' '.repeat(3000)
    const chunked = await call(makeRequest(big), env)
    expect(chunked.status).toBe(400)
    expect(await chunked.json()).toEqual({ error: 'refused', reason: `over ${MAX_BATCH_BYTES} bytes` })
    expect(points).toEqual([])
  })
})

test.describe('the live channel-id check', () => {
  test('drops an event naming an unknown channel and still lands the rest', async () => {
    const { batch, activeChannelIds, result } = golden.examples.droppedChannel
    const { binding, points } = makeDataset()
    const res = await call(makeRequest(JSON.stringify(batch), { cf: CF }), {
      TELEMETRY: binding,
      CATALOGUE_BUCKET: makeBucket(activeChannelIds).bucket,
    })
    expect(res.status).toBe(202)
    expect(res.headers.get('x-telemetry-dropped')).toBe(String(result.dropped))
    expect(points.map((p) => p.blobs[1])).toEqual(result.events.map((e) => e.e))
    expect(points.some((p) => p.blobs[5] === 'Unknown.xx')).toBe(false)
  })

  test('reads the list through the bucket once and reuses it within the TTL', async () => {
    const { binding } = makeDataset()
    const { bucket, reads } = makeBucket(LIVE_IDS)
    const env = { TELEMETRY: binding, CATALOGUE_BUCKET: bucket }
    const now = Date.now()
    for (let i = 0; i < 5; i += 1) {
      const res = await handleTelemetry({ request: makeRequest(JSON.stringify(VALID), { cf: CF }), env, waitUntil: () => {} }, now + i)
      expect(res.status).toBe(202)
    }
    expect(reads()).toBe(1)
    const later = await handleTelemetry(
      { request: makeRequest(JSON.stringify(VALID), { cf: CF }), env, waitUntil: () => {} },
      now + ACTIVE_IDS_TTL_MS + 1,
    )
    expect(later.status).toBe(202)
    expect(reads()).toBe(2)
  })

  for (const [label, make] of [
    ['the object is absent', () => makeBucket(null)],
    ['the object is malformed', () => makeBucket(LIVE_IDS, 'garbage')],
    ['the bucket throws', () => makeBucket(LIVE_IDS, 'throw')],
    ['there is no bucket binding', () => ({ bucket: undefined, reads: () => 0 })],
  ] as const) {
    test(`when ${label}, channel events drop and the rest still land — never an unverified id`, async () => {
      const { binding, points } = makeDataset()
      const res = await call(makeRequest(JSON.stringify(VALID), { cf: CF }), {
        TELEMETRY: binding,
        CATALOGUE_BUCKET: make().bucket,
      })
      expect(res.status).toBe(202)
      const expected = validateBatch(VALID, { activeChannelIds: new Set() })
      expect(expected.ok).toBe(true)
      if (!expected.ok) return
      expect(res.headers.get('x-telemetry-dropped')).toBe(String(expected.dropped))
      expect(points.map((p) => p.blobs[1])).toEqual(expected.events.map((e) => e.e))
      expect(points.every((p) => p.blobs[5] === '')).toBe(true)
    })
  }

  test('a malformed body never costs a bucket read', async () => {
    const { binding } = makeDataset()
    const { bucket, reads } = makeBucket(LIVE_IDS)
    const res = await call(makeRequest('not json'), { TELEMETRY: binding, CATALOGUE_BUCKET: bucket })
    expect(res.status).toBe(400)
    expect(reads()).toBe(0)
  })
})

test.describe('configuration', () => {
  test('without the TELEMETRY binding the route answers 503 and throws nothing', async () => {
    const res = await call(makeRequest(JSON.stringify(VALID), { cf: CF }), {
      TELEMETRY: 'a variable, not a binding',
      CATALOGUE_BUCKET: makeBucket(LIVE_IDS).bucket,
    })
    expect(res.status).toBe(503)
    expect(await res.text()).toBe('')
  })
})
