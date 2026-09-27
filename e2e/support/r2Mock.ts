import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { BrowserContext } from '@playwright/test'
import zlib from 'node:zlib'
import { readFileSync } from 'node:fs'
import { DEFAULT_GENERATION, scheduleFor, syntheticCatalogue } from './catalogueData'
import type { CatalogueOptions } from './catalogueData'

/**
 * A real local HTTP server standing in for the R2 snapshot host (ADR-0030/0034).
 *
 * It is a server, not a `page.route`, on purpose: Chromium does not apply
 * `Content-Encoding` to a body fulfilled from a route, so only a real response
 * proves the browser decodes the brotli objects. It answers with what the real
 * bucket stores (`Content-Encoding: br` on generation objects whether or not the
 * client asked for it, the `Cache-Control` values of ADR-0034) and records every
 * request so a test can count them and the bytes on the wire.
 *
 * The dev server is started with `VITE_CATALOGUE_R2_BASE_URL` set to this host
 * (playwright.config.ts), so specs never reach the real bucket. Nothing listens
 * on it: each worker's server takes an ephemeral port and `route(context)`
 * re-targets the browser's requests there, so specs run in parallel without
 * sharing a port or each other's state. The rewrite is a `route.continue`, not a
 * `fulfill`, so the response still arrives over a real socket, brotli and all.
 */

export const R2_MOCK_BASE_URL = 'http://127.0.0.1:5198'

export type R2Kind =
  | 'meta'
  | 'picks'
  | 'fastTrack'
  | 'channels'
  | 'streams'
  | 'categories'
  | 'countries'
  | 'epgIds'
  | 'schedule'

export interface R2Request {
  kind: R2Kind
  path: string
  status: number
  /** Bytes of the response body as sent (brotli for generation objects). */
  bytes: number
  acceptEncoding: string
}

/**
 * How a kind misbehaves:
 *  - `status`   answers 503 (an R2 outage behind the CDN)
 *  - `notfound` answers 404
 *  - `reset`    drops the connection (a network error)
 *  - `garbage`  answers 200 with bytes that are not valid brotli
 *  - `short`    answers a valid list missing its last row (an object that disagrees with meta.counts)
 */
export type R2Fault = 'status' | 'notfound' | 'reset' | 'garbage' | 'short'

export interface R2Mock {
  /** Every request since the last `resetRequests()`, in arrival order. */
  requests: R2Request[]
  count(kind: R2Kind): number
  /** Bytes of every response body since the last reset. */
  bytes(): number
  resetRequests(): void
  /** Publishes a new generation, as the sync worker does. */
  setGeneration(generation: number): void
  /** Serves the copied backend fixture (`r2-golden.json`) instead of the synthetic catalogue. */
  useGolden(): void
  /** Rewrites `catalogue/meta.json` fields, e.g. `{ version: 3 }` or `{ layout: 2 }`. */
  patchMeta(patch: Record<string, unknown>): void
  /**
   * Publishes `catalogue/picks.json` (ADR-0033). Null means the object does not
   * exist, which is what a bucket where the owner has never saved looks like.
   */
  setPicks(document: unknown | null): void
  /**
   * Publishes `catalogue/fast-track.json` (ADR-0043, WO-19). Null means the object
   * does not exist, which is the common case: most runs fast-track nothing.
   */
  setFastTrack(document: unknown | null): void
  /** Makes `kind` (or every kind) fail in `fault` mode until `clearFaults()`. */
  fail(kind: R2Kind | 'all', fault?: R2Fault): void
  /** Makes every object whose path (relative to `catalogue/`) matches `pattern` fail in `fault` mode. */
  failPath(pattern: RegExp, fault?: R2Fault): void
  clearFaults(): void
}

export interface R2Server {
  mock: R2Mock
  /** Starts listening on an ephemeral port. */
  listen(): Promise<void>
  /** Sends `context`'s requests for `R2_MOCK_BASE_URL` to this server; call per test. */
  route(context: BrowserContext): Promise<void>
  /** Back to a healthy synthetic catalogue with an empty request log. */
  reset(options?: CatalogueOptions): void
  close(): Promise<void>
}

interface GoldenObject {
  contentType: string
  contentEncoding: string | null
  cacheControl: string
  body: string
}

const GENERATION_CACHE = 'public, max-age=31536000, immutable'
const META_CACHE = 'public, max-age=60, stale-while-revalidate=3600'

/** `r2-golden.json` is the backend's fixture, copied verbatim; see e2e/support/r2-golden.json. */
export function readGolden(): Record<string, GoldenObject> {
  return JSON.parse(readFileSync(new URL('./r2-golden.json', import.meta.url), 'utf8'))
}

function classify(path: string): R2Kind | null {
  if (path === 'meta.json') return 'meta'
  if (path === 'picks.json') return 'picks'
  if (path === 'fast-track.json') return 'fastTrack'
  const m = /^g\d+\/(.+)\.json\.br$/.exec(path)
  if (!m) return null
  const name = m[1]
  if (name === 'channels' || name === 'streams' || name === 'categories' || name === 'countries') return name
  if (name === 'epg/ids') return 'epgIds'
  if (name.startsWith('epg/')) return 'schedule'
  return null
}

/** Brotli at a low quality: the mock compresses on every miss, and only the framing matters. */
function brotli(json: string): Buffer {
  return zlib.brotliCompressSync(Buffer.from(json), {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 },
  })
}

/** Builds the server; nothing listens until `listen()`, so a spec can hold `mock` at module scope. */
export function createR2Server(): R2Server {
  let generation = DEFAULT_GENERATION
  let options: CatalogueOptions = {}
  let golden: Record<string, GoldenObject> | null = null
  let metaPatch: Record<string, unknown> = {}
  let picks: unknown | null = null
  let fastTrack: unknown | null = null
  const faults = new Map<R2Kind | 'all', R2Fault>()
  const pathFaults: { pattern: RegExp; fault: R2Fault }[] = []
  const compressed = new Map<string, Buffer>()

  const mock: R2Mock = {
    requests: [],
    count: (kind) => mock.requests.filter((r) => r.kind === kind).length,
    bytes: () => mock.requests.reduce((sum, r) => sum + r.bytes, 0),
    resetRequests: () => { mock.requests.length = 0 },
    setGeneration: (g) => { generation = g },
    useGolden: () => { golden = readGolden() },
    patchMeta: (patch) => { metaPatch = { ...metaPatch, ...patch } },
    setPicks: (document) => { picks = document },
    setFastTrack: (document) => { fastTrack = document },
    fail: (kind, fault = 'status') => { faults.set(kind, fault) },
    failPath: (pattern, fault = 'status') => { pathFaults.push({ pattern, fault }) },
    clearFaults: () => { faults.clear(); pathFaults.length = 0 },
  }

  /** The decoded JSON of one object, or null when there is no such object. */
  function json(kind: R2Kind, path: string): string | null {
    if (golden) {
      const entry = golden['catalogue/' + path]
      return entry ? entry.body : null
    }
    const data = syntheticCatalogue(options)
    switch (kind) {
      case 'meta':
        return JSON.stringify({
          generation,
          version: 2,
          layout: 1,
          syncedAt: new Date().toISOString(),
          hash: 'mock',
          guide: true,
          counts: {
            channels: data.channels.length,
            streams: data.streams.length,
            categories: data.categories.length,
            countries: 0,
            epgChannels: data.epgIds.length,
          },
          ...metaPatch,
        })
      case 'picks': return picks === null ? null : JSON.stringify(picks)
      case 'fastTrack': return fastTrack === null ? null : JSON.stringify(fastTrack)
      case 'channels': return JSON.stringify(data.channels)
      case 'streams': return JSON.stringify(data.streams)
      case 'categories': return JSON.stringify(data.categories)
      case 'countries': return '[]'
      case 'epgIds': return JSON.stringify(data.epgIds)
      case 'schedule': {
        const id = decodeURIComponent(/\/epg\/(.+)\.json\.br$/.exec(path)![1])
        return data.epgIds.includes(id) ? JSON.stringify(scheduleFor(id, options.endedSchedules ?? false)) : null
      }
    }
  }

  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS' }

  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end()
      return
    }
    const path = decodeURIComponent(new URL(req.url ?? '/', R2_MOCK_BASE_URL).pathname).replace(/^\/catalogue\//, '')
    const kind = classify(path)
    const acceptEncoding = String(req.headers['accept-encoding'] ?? '')
    const log = (status: number, bytes: number) => {
      if (kind) mock.requests.push({ kind, path, status, bytes, acceptEncoding })
    }
    if (!kind) {
      res.writeHead(404, cors).end()
      return
    }

    const fault =
      pathFaults.find((f) => f.pattern.test(path))?.fault ?? faults.get(kind) ?? faults.get('all')
    if (fault === 'reset') {
      log(0, 0)
      req.socket.destroy()
      return
    }
    if (fault === 'status' || fault === 'notfound') {
      const status = fault === 'status' ? 503 : 404
      log(status, 0)
      res.writeHead(status, cors).end()
      return
    }

    let body = json(kind, path)
    if (body === null) {
      log(404, 0)
      res.writeHead(404, cors).end()
      return
    }
    if (fault === 'short') {
      const list = JSON.parse(body) as unknown[]
      body = JSON.stringify(Array.isArray(list) ? list.slice(0, -1) : list)
    }

    // Generation objects are stored brotli-encoded and served so whatever the client
    // asked for; `meta.json` and `picks.json` are plain JSON with a short lifetime
    // (ADR-0034 section 2, ADR-0033 section 7).
    const isMeta = kind === 'meta' || kind === 'picks' || kind === 'fastTrack'
    const cacheKey = fault === 'short' ? null : path + ':' + generation + ':' + body.length
    let payload: Buffer
    if (isMeta) payload = Buffer.from(body)
    else if (fault === 'garbage') payload = Buffer.from('this is not brotli')
    else if (cacheKey && compressed.has(cacheKey)) payload = compressed.get(cacheKey)!
    else {
      payload = brotli(body)
      if (cacheKey) compressed.set(cacheKey, payload)
    }

    log(200, payload.length)
    res.writeHead(200, {
      ...cors,
      'content-type': 'application/json',
      ...(isMeta ? {} : { 'content-encoding': 'br' }),
      'cache-control': isMeta ? META_CACHE : GENERATION_CACHE,
      'content-length': String(payload.length),
    })
    res.end(payload)
  })

  return {
    mock,
    listen: () =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      }),
    route: (context) => {
      const target = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      return context.route(`${R2_MOCK_BASE_URL}/**`, (route) =>
        route.continue({ url: target + route.request().url().slice(R2_MOCK_BASE_URL.length) }),
      )
    },
    reset(next = {}) {
      generation = DEFAULT_GENERATION
      options = next
      golden = null
      metaPatch = {}
      picks = null
      fastTrack = null
      faults.clear()
      pathFaults.length = 0
      compressed.clear()
      mock.requests.length = 0
    },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}
