import { test, expect } from '@playwright/test'
// FIRST, and deliberately: see the same import in picks-endpoint.spec.ts.
import { resetJwksCache } from './support/testSeams'
import { onRequest as customChannelsHandler } from '../functions/api/picks/custom-channels'
import { bindBucket } from '../functions/api/_lib/catalogueBucket'
import { jwks, makeTestKey, mintToken, validPayload, type TestKey } from './support/accessTokens'

/**
 * The custom-channels write path (WO-21), attacked the same way `picks-endpoint.spec.ts`
 * attacks `/api/picks`: real handler, generated RSA keypair, stubbed JWKS fetch, an in-memory
 * R2 double. Unlike `/api/picks`, there is no iptv-org list to check against and no fast-track
 * dispatch to trigger — the two things this route does not do, and does not need to fetch
 * anything to refuse a bad save.
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

/** Same double as picks-endpoint.spec.ts's `makeBucket` — see there for the `onlyIf` rules. */
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
    async put(key: string, value: string, options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) {
      const existing = objects.get(key)
      const mustMatch = options?.onlyIf?.etagMatches
      if (mustMatch !== undefined) {
        if (mustMatch.startsWith('"') || mustMatch.startsWith('W/')) {
          throw new TypeError(`Conditional ETag should not be wrapped in quotes ("${mustMatch}").`)
        }
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
let stub: { restore: () => void }

test.beforeAll(async () => {
  key = await makeTestKey('kid-live')
})

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

const GOOD_BODY = { schema: 1, channels: [{ name: 'Community TV', streamUrl: 'https://example.com/stream.m3u8' }] }

function writeRequest(token: string | null, body: unknown = GOOD_BODY, extra: Record<string, string> = {}, method = 'PUT'): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...extra }
  if (token) headers['Cf-Access-Jwt-Assertion'] = token
  return new Request(`${ORIGIN}/api/picks/custom-channels`, {
    method,
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

test.describe('the Access gate', () => {
  test('a valid token saves, and the server assigns a custom- id', async () => {
    const { bucket, objects } = makeBucket()
    const res = await call(customChannelsHandler, writeRequest(await goodToken()), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.channels).toHaveLength(1)
    expect(body.channels[0].id).toMatch(/^custom-/)
    expect(body.channels[0].name).toBe('Community TV')

    const stored = JSON.parse(objects.get('catalogue/custom-channels.json')!.body)
    expect(stored.schema).toBe(1)
    expect(stored.channels[0].id).toBe(body.channels[0].id)
  })

  test('no token is refused with 401 and writes nothing', async () => {
    const { bucket, mutations } = makeBucket()
    const res = await call(customChannelsHandler, writeRequest(null), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
    expect(res.status).toBe(401)
    expect(mutations).toEqual([])
  })

  test('a token for another audience is refused with 403, writing nothing', async () => {
    const token = await mintToken({ key, payload: validPayload(TEAM, 'b'.repeat(64)) })
    const { bucket, mutations } = makeBucket()
    const res = await call(customChannelsHandler, writeRequest(token), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
    expect(res.status).toBe(403)
    expect(mutations).toEqual([])
  })

  test('a cross-site write is refused even with a valid token', async () => {
    const { bucket, mutations } = makeBucket()
    const res = await call(
      customChannelsHandler,
      writeRequest(await goodToken(), GOOD_BODY, { 'sec-fetch-site': 'cross-site' }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(res.status).toBe(403)
    expect(mutations).toEqual([])
  })
})

test.describe('configuration and bucket proof', () => {
  test('no R2 binding: 503 and nothing written', async () => {
    const res = await call(customChannelsHandler, writeRequest(await goodToken()), ENV_VARS)
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('storage-not-configured')
  })

  test('a bucket without catalogue/meta.json is refused: nothing seeded into the wrong bucket', async () => {
    const { bucket, mutations } = makeBucket({ 'icons/x.webp': 'not-json' })
    const res = await call(customChannelsHandler, writeRequest(await goodToken()), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('wrong-bucket')
    expect(mutations).toEqual([])
  })

  test('a GET works before any custom channel has ever been saved', async () => {
    const { bucket } = makeBucket()
    const res = await call(
      customChannelsHandler,
      new Request(`${ORIGIN}/api/picks/custom-channels`, { headers: { 'Cf-Access-Jwt-Assertion': await goodToken() } }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(res.status).toBe(200)
    expect((await res.json()).channels).toEqual([])
  })

  test('a malformed body against the wrong bucket is still 400, not 503: validation runs first', async () => {
    const { bucket, mutations } = makeBucket({ 'icons/x.webp': 'not-json' })
    const res = await call(
      customChannelsHandler,
      writeRequest(await goodToken(), { schema: 1, channels: [{ name: 'A' }] }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid-custom-channels')
    expect(mutations).toEqual([])
  })
})

test.describe('validation on save', () => {
  const badBodies: [string, unknown][] = [
    ['a non-object body', []],
    ['an unknown schema', { schema: 2, channels: [] }],
    ['an unknown top-level field', { schema: 1, channels: [], extra: 1 }],
    ['an unknown channel field', { schema: 1, channels: [{ name: 'A', streamUrl: 'https://x.test/a.m3u8', categories: ['news'] }] }],
    ['a missing name', { schema: 1, channels: [{ streamUrl: 'https://x.test/a.m3u8' }] }],
    ['a missing streamUrl', { schema: 1, channels: [{ name: 'A' }] }],
    ['a non-http(s) streamUrl', { schema: 1, channels: [{ name: 'A', streamUrl: 'ftp://x.test/a.m3u8' }] }],
    ['a malformed streamUrl', { schema: 1, channels: [{ name: 'A', streamUrl: 'not a url' }] }],
    ['a non-http(s) iconUrl', { schema: 1, channels: [{ name: 'A', streamUrl: 'https://x.test/a.m3u8', iconUrl: 'javascript:alert(1)' }] }],
    ['an id the client invented, naming nothing on the document', { schema: 1, channels: [{ id: 'custom-invented', name: 'A', streamUrl: 'https://x.test/a.m3u8' }] }],
    ['too many channels', { schema: 1, channels: Array.from({ length: 51 }, (_, i) => ({ name: `C${i}`, streamUrl: `https://x.test/${i}.m3u8` })) }],
  ]

  for (const [label, body] of badBodies) {
    test(`${label} is refused with 400 and writes nothing`, async () => {
      const { bucket, mutations } = makeBucket()
      const res = await call(customChannelsHandler, writeRequest(await goodToken(), body), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
      expect(res.status).toBe(400)
      expect(mutations).toEqual([])
    })
  }

  test('an oversized body is refused with 413 before it is parsed', async () => {
    // Past LIMITS.bodyBytes (256 KiB) — comfortably past, so the check trips regardless of
    // JSON framing overhead, and before schema validation ever sees the (also invalid) name.
    const huge = JSON.stringify({ schema: 1, channels: [{ name: 'A'.repeat(300_000), streamUrl: 'https://x.test/a.m3u8' }] })
    const { bucket, mutations } = makeBucket()
    const res = await call(customChannelsHandler, writeRequest(await goodToken(), huge), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
    expect(res.status).toBe(413)
    expect(mutations).toEqual([])
  })

  test('categories can never be sent: there is no such field in this schema', async () => {
    const { bucket, mutations } = makeBucket()
    const res = await call(
      customChannelsHandler,
      writeRequest(await goodToken(), { schema: 1, channels: [{ name: 'A', streamUrl: 'https://x.test/a.m3u8', categories: ['sport'] }] }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(res.status).toBe(400)
    expect((await res.json()).errors.join(' ')).toContain('unknown field "categories"')
    expect(mutations).toEqual([])
  })
})

test.describe('editing keeps the id stable', () => {
  test('an existing id round-trips unchanged; a new entry alongside it gets assigned one', async () => {
    const { bucket, objects } = makeBucket()
    const first = await call(customChannelsHandler, writeRequest(await goodToken()), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
    const firstBody = await first.json()
    const existingId = firstBody.channels[0].id as string
    const etag = firstBody.etag as string

    const second = await call(
      customChannelsHandler,
      writeRequest(
        await goodToken(),
        {
          schema: 1,
          channels: [
            { id: existingId, name: 'Community TV', streamUrl: 'https://example.com/stream.m3u8' },
            { name: 'Second Channel', streamUrl: 'https://example.com/second.m3u8' },
          ],
        },
        { 'if-match': etag },
      ),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(second.status).toBe(200)
    const secondBody = await second.json()
    expect(secondBody.channels).toHaveLength(2)
    expect(secondBody.channels[0].id).toBe(existingId)
    expect(secondBody.channels[1].id).toMatch(/^custom-/)
    expect(secondBody.channels[1].id).not.toBe(existingId)

    const stored = JSON.parse(objects.get('catalogue/custom-channels.json')!.body)
    expect(stored.channels.map((c: { id: string }) => c.id)).toEqual(secondBody.channels.map((c: { id: string }) => c.id))
  })

  test('removing a channel by omitting its id from the save drops it', async () => {
    const { bucket } = makeBucket()
    const first = await call(customChannelsHandler, writeRequest(await goodToken()), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
    const { etag } = await first.json()

    const second = await call(
      customChannelsHandler,
      writeRequest(await goodToken(), { schema: 1, channels: [] }, { 'if-match': etag }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(second.status).toBe(200)
    expect((await second.json()).channels).toEqual([])
  })
})

test.describe('concurrent edits', () => {
  test('a save without If-Match over an existing document returns 412 with the newer copy', async () => {
    const existing = JSON.stringify({ schema: 1, updatedAt: '2026-01-01T00:00:00.000Z', channels: [] })
    const { bucket, mutations } = makeBucket({ ...PROOF, 'catalogue/custom-channels.json': existing })
    const res = await call(customChannelsHandler, writeRequest(await goodToken()), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
    expect(res.status).toBe(412)
    expect(mutations).toEqual([])
  })

  test('a stale If-Match returns 412 and writes nothing', async () => {
    const existing = JSON.stringify({ schema: 1, updatedAt: '2026-01-01T00:00:00.000Z', channels: [] })
    const { bucket, mutations } = makeBucket({ ...PROOF, 'catalogue/custom-channels.json': existing })
    const res = await call(
      customChannelsHandler,
      writeRequest(await goodToken(), GOOD_BODY, { 'if-match': '"an-older-etag"' }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(res.status).toBe(412)
    expect(mutations).toEqual([])
  })
})

test.describe('the binding facade', () => {
  test('a plain variable named CATALOGUE_BUCKET is 503, not a 500', async () => {
    expect(bindBucket({ CATALOGUE_BUCKET: 'streamloom-catalogue' })).toBeNull()
    const res = await call(customChannelsHandler, writeRequest(await goodToken()), { ...ENV_VARS, CATALOGUE_BUCKET: 'streamloom-catalogue' })
    expect(res.status).toBe(503)
  })
})
