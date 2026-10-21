import { test, expect } from '@playwright/test'
// FIRST, and deliberately: see the same import in picks-endpoint.spec.ts.
import { resetJwksCache } from './support/testSeams'
import { onRequest as safeChannelsHandler } from '../functions/api/picks/safe-channels'
import { bindBucket } from '../functions/api/_lib/catalogueBucket'
import { jwks, makeTestKey, mintToken, validPayload, type TestKey } from './support/accessTokens'

/**
 * The safe-catalogue write path (ADR-0059), attacked the same way `custom-channels-endpoint.spec.ts`
 * attacks its route: real handler, generated RSA keypair, stubbed JWKS fetch, an in-memory R2
 * double. The document is the flattest shape in this family (just `ids`), so there is less
 * validation surface than custom-channels, but the same Access gate, bucket proof and ETag rules.
 */

const ORIGIN = 'https://streamloom.example'
const TEAM = 'https://streamloom.cloudflareaccess.com'
const CERTS = `${TEAM}/cdn-cgi/access/certs`
const AUD = 'a'.repeat(64)
const ENV_VARS = { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD }

const PROOF = { 'catalogue/meta.json': JSON.stringify({ generation: 1, version: 2, layout: 1 }) }

interface StoredObject {
  body: string
  etag: string
}

/** Same double as custom-channels-endpoint.spec.ts's `makeBucket` — see there for the `onlyIf` rules. */
function makeBucket(initial: Record<string, string> = PROOF) {
  const objects = new Map<string, StoredObject>()
  const mutations: string[] = []
  let etagSeq = 0
  const nextEtag = () => `"etag-${(etagSeq += 1)}"`

  for (const [key, body] of Object.entries(initial)) {
    objects.set(key, { body, etag: nextEtag() })
  }

  const wrap = (stored: StoredObject) => ({
    httpEtag: stored.etag,
    size: stored.body.length,
    json: async <T,>() => JSON.parse(stored.body) as T,
    text: async () => stored.body,
  })

  const bucket = {
    async get(key: string) {
      const stored = objects.get(key)
      return stored ? wrap(stored) : null
    },
    async head(key: string) {
      return objects.has(key) ? { key } : null
    },
    async put(key: string, value: string, options?: { onlyIf?: { etagMatches?: string } }) {
      const existing = objects.get(key)
      const mustMatch = options?.onlyIf?.etagMatches
      if (mustMatch !== undefined) {
        const existingBare = existing?.etag.replace(/^W\//, '').replace(/^"|"$/g, '')
        if (existingBare !== mustMatch) {
          mutations.push(`put-refused ${key}`)
          return null
        }
      }
      const etag = nextEtag()
      objects.set(key, { body: value, etag })
      mutations.push(`put ${key}`)
      return { httpEtag: etag }
    },
    async delete(key: string) {
      mutations.push(`delete ${key}`)
    },
  }

  return { bucket, objects, mutations }
}

async function call(
  handler: (ctx: any) => Promise<Response>,
  request: Request,
  env: Record<string, unknown>,
): Promise<Response> {
  const deferred: Promise<unknown>[] = []
  const response = await handler({ request, params: {}, env, waitUntil: (p: Promise<unknown>) => deferred.push(p) })
  await Promise.allSettled(deferred)
  return response
}

let key: TestKey

test.beforeAll(async () => {
  key = await makeTestKey('kid-live')
})

let stub: { restore: () => void }

test.beforeEach(() => {
  resetJwksCache()
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url === CERTS) {
      return new Response(jwks(key), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('unexpected', { status: 599 })
  }) as typeof fetch
  stub = { restore: () => { globalThis.fetch = original } }
})

test.afterEach(() => stub.restore())

const goodToken = () => mintToken({ key, payload: validPayload(TEAM, AUD) })

const GOOD_BODY = { ids: ['ch1.xx', 'ch2.xx'] }

function writeRequest(token: string | null, body: unknown = GOOD_BODY, extra: Record<string, string> = {}, method = 'PUT'): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...extra }
  if (token) headers['Cf-Access-Jwt-Assertion'] = token
  return new Request(`${ORIGIN}/api/picks/safe-channels`, {
    method,
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

test.describe('the Access gate', () => {
  test('a valid token saves', async () => {
    const { bucket, objects } = makeBucket()
    const res = await call(safeChannelsHandler, writeRequest(await goodToken()), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.ids).toEqual(['ch1.xx', 'ch2.xx'])

    const stored = JSON.parse(objects.get('catalogue/safe-channels.json')!.body)
    expect(stored.schema).toBe(1)
    expect(stored.ids).toEqual(['ch1.xx', 'ch2.xx'])
  })

  test('no token is refused with 401 and writes nothing', async () => {
    const { bucket, mutations } = makeBucket()
    const res = await call(safeChannelsHandler, writeRequest(null), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
    expect(res.status).toBe(401)
    expect(mutations).toEqual([])
  })

  test('a token for another audience is refused with 403, writing nothing', async () => {
    const token = await mintToken({ key, payload: validPayload(TEAM, 'b'.repeat(64)) })
    const { bucket, mutations } = makeBucket()
    const res = await call(safeChannelsHandler, writeRequest(token), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
    expect(res.status).toBe(403)
    expect(mutations).toEqual([])
  })

  test('a cross-site write is refused even with a valid token', async () => {
    const { bucket, mutations } = makeBucket()
    const res = await call(
      safeChannelsHandler,
      writeRequest(await goodToken(), GOOD_BODY, { 'sec-fetch-site': 'cross-site' }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(res.status).toBe(403)
    expect(mutations).toEqual([])
  })

  test('GET also requires the Access JWT', async () => {
    const { bucket } = makeBucket()
    const res = await call(
      safeChannelsHandler,
      new Request(`${ORIGIN}/api/picks/safe-channels`),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(res.status).toBe(401)
  })
})

test.describe('configuration and bucket proof', () => {
  test('no R2 binding: 503 and nothing written', async () => {
    const res = await call(safeChannelsHandler, writeRequest(await goodToken()), ENV_VARS)
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('storage-not-configured')
  })

  test('a bucket without catalogue/meta.json is refused: nothing seeded into the wrong bucket', async () => {
    const { bucket, mutations } = makeBucket({ 'icons/x.webp': 'not-json' })
    const res = await call(safeChannelsHandler, writeRequest(await goodToken()), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('wrong-bucket')
    expect(mutations).toEqual([])
  })

  test('a GET works before any safe-channels document has ever been saved', async () => {
    const { bucket } = makeBucket()
    const res = await call(
      safeChannelsHandler,
      new Request(`${ORIGIN}/api/picks/safe-channels`, { headers: { 'Cf-Access-Jwt-Assertion': await goodToken() } }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(res.status).toBe(200)
    expect((await res.json()).ids).toEqual([])
  })

  test('a malformed body against the wrong bucket is still 400, not 503: validation runs first', async () => {
    const { bucket, mutations } = makeBucket({ 'icons/x.webp': 'not-json' })
    const res = await call(
      safeChannelsHandler,
      writeRequest(await goodToken(), { ids: [123] }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid-safe-channels')
    expect(mutations).toEqual([])
  })
})

test.describe('validation on save', () => {
  const badBodies: [string, unknown][] = [
    ['a non-object body', []],
    ['a missing ids field', {}],
    ['a non-array ids field', { ids: 'ch1.xx' }],
    ['a non-string id', { ids: [1] }],
    ['an empty-string id', { ids: [''] }],
    ['too many ids', { ids: Array.from({ length: 2001 }, (_, i) => `ch${i}.xx`) }],
    ['an id too long', { ids: ['x'.repeat(201)] }],
  ]

  for (const [label, body] of badBodies) {
    test(`${label} is refused with 400 and writes nothing`, async () => {
      const { bucket, mutations } = makeBucket()
      const res = await call(safeChannelsHandler, writeRequest(await goodToken(), body), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
      expect(res.status).toBe(400)
      expect(mutations).toEqual([])
    })
  }

  test('duplicate ids are silently de-duplicated, not refused', async () => {
    const { bucket } = makeBucket()
    const res = await call(
      safeChannelsHandler,
      writeRequest(await goodToken(), { ids: ['ch1.xx', 'ch1.xx', 'ch2.xx'] }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(res.status).toBe(200)
    expect((await res.json()).ids).toEqual(['ch1.xx', 'ch2.xx'])
  })

  test('an oversized body is refused with 413 before it is parsed', async () => {
    // Past LIMITS.bodyBytes (64 KiB): 2000 ids of 40 chars each, comfortably over, regardless
    // of whether the ids themselves would otherwise be valid.
    const huge = JSON.stringify({ ids: Array.from({ length: 2000 }, (_, i) => `channel-with-a-rather-long-id-number-${i}`) })
    const { bucket, mutations } = makeBucket()
    const res = await call(
      safeChannelsHandler,
      writeRequest(await goodToken(), huge, { 'content-length': String(new TextEncoder().encode(huge).byteLength) }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(res.status).toBe(413)
    expect(mutations).toEqual([])
  })
})

test.describe('concurrent edits', () => {
  test('a save without If-Match over an existing document returns 412 with the newer copy', async () => {
    const existing = JSON.stringify({ schema: 1, updatedAt: '2026-01-01T00:00:00.000Z', ids: ['ch9.xx'] })
    const { bucket, mutations } = makeBucket({ ...PROOF, 'catalogue/safe-channels.json': existing })
    const res = await call(safeChannelsHandler, writeRequest(await goodToken()), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
    expect(res.status).toBe(412)
    expect((await res.json()).ids).toEqual(['ch9.xx'])
    expect(mutations).toEqual([])
  })

  test('a stale If-Match returns 412 and writes nothing', async () => {
    const existing = JSON.stringify({ schema: 1, updatedAt: '2026-01-01T00:00:00.000Z', ids: [] })
    const { bucket, mutations } = makeBucket({ ...PROOF, 'catalogue/safe-channels.json': existing })
    const res = await call(
      safeChannelsHandler,
      writeRequest(await goodToken(), GOOD_BODY, { 'if-match': '"an-older-etag"' }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(res.status).toBe(412)
    expect(mutations).toEqual([])
  })

  test('the ETag read is sent back as If-Match and a second save with it succeeds', async () => {
    const { bucket } = makeBucket()
    const first = await call(safeChannelsHandler, writeRequest(await goodToken()), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
    const { etag } = await first.json()
    const second = await call(
      safeChannelsHandler,
      writeRequest(await goodToken(), { ids: ['ch3.xx'] }, { 'if-match': etag }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(second.status).toBe(200)
    expect((await second.json()).ids).toEqual(['ch3.xx'])
  })
})

test.describe('the binding facade', () => {
  test('a plain variable named CATALOGUE_BUCKET is 503, not a 500', async () => {
    expect(bindBucket({ CATALOGUE_BUCKET: 'streamloom-catalogue' })).toBeNull()
    const res = await call(safeChannelsHandler, writeRequest(await goodToken()), { ...ENV_VARS, CATALOGUE_BUCKET: 'streamloom-catalogue' })
    expect(res.status).toBe(503)
  })

  test('method not allowed on anything but GET/PUT/POST', async () => {
    const { bucket } = makeBucket()
    const res = await call(
      safeChannelsHandler,
      new Request(`${ORIGIN}/api/picks/safe-channels`, { method: 'DELETE', headers: { 'Cf-Access-Jwt-Assertion': await goodToken() } }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(res.status).toBe(405)
  })
})
