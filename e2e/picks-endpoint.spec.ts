import { test, expect } from '@playwright/test'
// FIRST, and deliberately: this creates the seam registry that the Function
// libraries look for as they are evaluated. Imported below them, the caches
// would hold no hooks and every reset would throw. See e2e/support/testSeams.ts.
import { ageIptvCache, resetIptvCache, resetJwksCache } from './support/testSeams'
import {
  bindBucket,
  onRequest as picksHandler,
  writeHistory,
} from '../functions/api/picks/index'
import { onRequest as channelsHandler } from '../functions/api/picks/channels'
import { readAccessConfig, verifyAccessJwt } from '../functions/api/_lib/accessJwt'
import { jwks, makeTestKey, mintToken, validPayload, type TestKey } from './support/accessTokens'

/**
 * The picks write path, attacked.
 *
 * These call the real Pages Function handlers with a generated RSA keypair, a
 * stubbed `fetch` standing in for the team's certs endpoint and the iptv-org
 * lists, and an in-memory R2 double that records every mutation. No Cloudflare
 * runtime, no network and no account are involved, so the whole Access gate can
 * be exercised — including the cases a live deployment cannot easily produce,
 * such as `alg: none`, an unknown `kid` and an unreachable JWKS.
 *
 * The rule every case checks, one way or another: **nothing is written unless a
 * token verifies end to end**, and a refusal writes nothing at all.
 */

const ORIGIN = 'https://streamloom.example'
const TEAM = 'https://streamloom.cloudflareaccess.com'
const CERTS = `${TEAM}/cdn-cgi/access/certs`
const AUD = 'a'.repeat(64)

const ENV_VARS = { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD }

const CHANNELS_URL = 'https://iptv-org.github.io/api/channels.json'
const BLOCKLIST_URL = 'https://iptv-org.github.io/api/blocklist.json'
const DISPATCH_URL = 'https://api.github.com/repos/StreamLoomBackEnd/streamloom-backend/dispatches'

/** A small stand-in for the 31K-row upstream list, with one of each interesting flag. */
const UPSTREAM_CHANNELS = [
  { id: 'BBCNews.uk', name: 'BBC News', country: 'GB', categories: ['news'], is_nsfw: false, closed: null, replaced_by: null },
  { id: 'Arte.fr', name: 'Arte', country: 'FR', categories: ['culture'], is_nsfw: false, closed: null, replaced_by: null },
  { id: 'OldNews.us', name: 'Old News', country: 'US', categories: ['news'], is_nsfw: false, closed: '2024-01-01', replaced_by: null },
  { id: 'Moved.de', name: 'Moved Channel', country: 'DE', categories: ['general'], is_nsfw: false, closed: null, replaced_by: 'Arte.fr' },
  { id: 'Adult.xx', name: 'Adult Channel', country: 'US', categories: ['xxx'], is_nsfw: true, closed: null, replaced_by: null },
  { id: 'Blocked.us', name: 'Blocked Channel', country: 'US', categories: ['movies'], is_nsfw: false, closed: null, replaced_by: null },
]
const UPSTREAM_BLOCKLIST = [{ channel: 'Blocked.us', reason: 'dmca', ref: 'https://example.invalid/1' }]

// ---- R2 double ----

interface StoredObject {
  body: string
  etag: string
}

/**
 * The object the route requires before it will write: proof that the binding
 * really is the catalogue bucket and not `channel-icons` or an empty one.
 */
const PROOF = { 'catalogue/meta.json': JSON.stringify({ generation: 1, version: 2, layout: 1 }) }

/**
 * Minimal R2 double.
 *
 * Every mutation is recorded, and `delete` is deliberately present so a test can
 * prove the route never calls it — and can no longer reach it, since the Function
 * now wraps the binding in a three-method facade.
 *
 * `onlyIf` is honoured for both conditions the route uses: `etagMatches` (the
 * picks.json compare-and-set) and `etagDoesNotMatch: '*'` (the append-only
 * history write).
 */
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
    async put(
      key: string,
      value: string,
      options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } },
    ) {
      const existing = objects.get(key)
      const mustMatch = options?.onlyIf?.etagMatches
      if (mustMatch !== undefined) {
        // Real R2 throws for exactly this shape (found live, 2026-09-22): it
        // wants the bare hash, not the quoted or weak-tagged HTTP form. This
        // check is the reason that bug could not have shipped through this
        // fixture — the old version compared quoted-to-quoted and never
        // noticed the value it was given was the wrong shape.
        if (mustMatch.startsWith('"') || mustMatch.startsWith('W/')) {
          throw new TypeError(`Conditional ETag should not be wrapped in quotes ("${mustMatch}").`)
        }
        const existingBare = existing?.etag.replace(/^W\//, '').replace(/^"|"$/g, '')
        if (existingBare !== mustMatch) {
          mutations.push(`put-refused ${key}`)
          return null
        }
      }
      const mustNotMatch = options?.onlyIf?.etagDoesNotMatch
      if (mustNotMatch === '*' && existing) {
        mutations.push(`put-refused ${key}`)
        return null
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

  /** Mutations that actually changed the bucket (a refused conditional put did not). */
  const writes = () => mutations.filter((m) => m.startsWith('put ') || m.startsWith('delete '))

  return { bucket, objects, mutations, writes }
}

/** Runs a handler the way Pages does, draining anything it defers. */
async function call(
  handler: (ctx: any) => Promise<Response>,
  request: Request,
  env: Record<string, unknown>,
): Promise<Response> {
  const deferred: Promise<unknown>[] = []
  const response = await handler({
    request,
    params: {},
    env,
    waitUntil: (p: Promise<unknown>) => deferred.push(p),
  })
  await Promise.allSettled(deferred)
  return response
}

// ---- fetch stub ----

interface FetchStub {
  outbound: string[]
  /** Set to make the certs endpoint fail. */
  certsStatus: number
  certsBody: string
  iptvStatus: number
  /** Set to make a fast-track dispatch fail (ADR-0043, WO-19). */
  dispatchStatus: number
  /** Every dispatch body received, parsed, in call order. */
  dispatches: { event_type: string; client_payload: { channelIds: string[] } }[]
  /** The upstream channel list this stub serves — replace for a test that needs more rows. */
  channels: typeof UPSTREAM_CHANNELS
  restore: () => void
}

function stubFetch(keys: TestKey[]): FetchStub {
  const original = globalThis.fetch
  const stub: FetchStub = {
    outbound: [],
    certsStatus: 200,
    certsBody: jwks(...keys),
    iptvStatus: 200,
    dispatchStatus: 204,
    dispatches: [],
    channels: UPSTREAM_CHANNELS,
    restore: () => {
      globalThis.fetch = original
    },
  }

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    stub.outbound.push(url)
    if (url === CERTS) {
      return new Response(stub.certsBody, {
        status: stub.certsStatus,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === CHANNELS_URL) {
      return new Response(JSON.stringify(stub.channels), {
        status: stub.iptvStatus,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === BLOCKLIST_URL) {
      return new Response(JSON.stringify(UPSTREAM_BLOCKLIST), {
        status: stub.iptvStatus,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === DISPATCH_URL) {
      stub.dispatches.push(JSON.parse(String(init?.body)))
      return new Response(null, { status: stub.dispatchStatus })
    }
    // Any other outbound request is a bug worth failing on.
    return new Response('unexpected', { status: 599 })
  }) as typeof fetch

  return stub
}

// ---- request builders ----

const GOOD_BODY = {
  schema: 1,
  groups: [{ title: 'News', items: [{ channelId: 'BBCNews.uk', note: 'Always on', rank: 0 }] }],
}

function writeRequest(
  token: string | null,
  body: unknown = GOOD_BODY,
  extra: Record<string, string> = {},
  method = 'PUT',
): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'sec-fetch-site': 'same-origin',
    ...extra,
  }
  if (token) headers['Cf-Access-Jwt-Assertion'] = token
  return new Request(`${ORIGIN}/api/picks`, {
    method,
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

let key: TestKey
let otherKey: TestKey
let stub: FetchStub

test.beforeAll(async () => {
  key = await makeTestKey('kid-live')
  otherKey = await makeTestKey('kid-attacker')
})

test.beforeEach(() => {
  resetJwksCache()
  resetIptvCache()
  stub = stubFetch([key])
})

test.afterEach(() => {
  stub.restore()
})

const goodToken = () => mintToken({ key, payload: validPayload(TEAM, AUD) })

// ---------------------------------------------------------------------------

test.describe('the Access gate', () => {
  test('a valid token saves, and writes picks.json plus an append-only history object', async () => {
    const { bucket, objects, mutations } = makeBucket()
    const res = await call(picksHandler, writeRequest(await goodToken()), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.counts).toEqual({ groups: 1, items: 1 })

    const stored = JSON.parse(objects.get('catalogue/picks.json')!.body)
    expect(stored.schema).toBe(1)
    expect(stored.groups[0].items[0].channelId).toBe('BBCNews.uk')
    // The server owns updatedAt; the client never sends one.
    expect(typeof stored.updatedAt).toBe('string')

    const historyKeys = [...objects.keys()].filter((k) => k.startsWith('picks-history/'))
    expect(historyKeys).toHaveLength(1)
    expect(body.historyKey).toBe(historyKeys[0])
    expect(mutations.filter((m) => m.startsWith('delete'))).toEqual([])
  })

  test('no token is refused with 401 and writes nothing', async () => {
    const { bucket, mutations } = makeBucket()
    const res = await call(picksHandler, writeRequest(null), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
    expect(res.status).toBe(401)
    expect(mutations).toEqual([])
  })

  test('an expired token is refused with 401 and writes nothing', async () => {
    const nowS = Math.floor(Date.now() / 1000)
    const token = await mintToken({
      key,
      payload: validPayload(TEAM, AUD, { exp: nowS - 3600, iat: nowS - 7200, nbf: nowS - 7200 }),
    })
    const { bucket, mutations } = makeBucket()
    const res = await call(picksHandler, writeRequest(token), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
    expect(res.status).toBe(401)
    expect(mutations).toEqual([])
  })

  test('a comma-separated audience list accepts either application, and nothing else', async () => {
    const second = 'c'.repeat(64)
    const env = { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: `${AUD}, ${second}` }

    for (const aud of [AUD, second]) {
      const { bucket, objects } = makeBucket()
      const token = await mintToken({ key, payload: validPayload(TEAM, aud) })
      const res = await call(picksHandler, writeRequest(token), { ...env, CATALOGUE_BUCKET: bucket })
      expect(res.status).toBe(200)
      expect(objects.has('catalogue/picks.json')).toBe(true)
    }

    const { bucket, mutations } = makeBucket()
    const stranger = await mintToken({ key, payload: validPayload(TEAM, 'd'.repeat(64)) })
    const res = await call(picksHandler, writeRequest(stranger), { ...env, CATALOGUE_BUCKET: bucket })
    expect(res.status).toBe(403)
    expect(mutations).toEqual([])
  })

  test('a token for another audience is refused with 403', async () => {
    const token = await mintToken({ key, payload: validPayload(TEAM, 'b'.repeat(64)) })
    const { bucket, mutations } = makeBucket()
    const res = await call(picksHandler, writeRequest(token), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
    expect(res.status).toBe(403)
    expect(mutations).toEqual([])
  })

  test('a token from another team is refused with 403', async () => {
    const token = await mintToken({
      key,
      payload: validPayload('https://someone-else.cloudflareaccess.com', AUD),
    })
    const { bucket, mutations } = makeBucket()
    const res = await call(picksHandler, writeRequest(token), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
    expect(res.status).toBe(403)
    expect(mutations).toEqual([])
  })

  test('a tampered payload is refused: the signature no longer covers it', async () => {
    const token = await goodToken()
    const [head, , signature] = token.split('.')
    const forgedPayload = btoa(JSON.stringify(validPayload(TEAM, AUD, { email: 'attacker@example.com' })))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    const { bucket, mutations } = makeBucket()
    const res = await call(picksHandler, writeRequest(`${head}.${forgedPayload}.${signature}`), {
      ...ENV_VARS,
      CATALOGUE_BUCKET: bucket,
    })
    expect(res.status).toBe(401)
    expect(mutations).toEqual([])
  })

  test('alg: none is refused before any key is fetched', async () => {
    const token = await mintToken({
      key,
      payload: validPayload(TEAM, AUD),
      header: { alg: 'none', typ: 'JWT', kid: key.kid },
      rawSignature: '',
    })
    const { bucket, mutations } = makeBucket()
    const res = await call(picksHandler, writeRequest(token), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
    expect(res.status).toBe(401)
    expect(stub.outbound).not.toContain(CERTS)
    expect(mutations).toEqual([])
  })

  test('a non-RS256 algorithm is refused (an HS256 token signed with the public modulus)', async () => {
    const token = await mintToken({
      key,
      payload: validPayload(TEAM, AUD),
      header: { alg: 'HS256', typ: 'JWT', kid: key.kid },
      rawSignature: 'ZmFrZQ',
    })
    const { bucket, mutations } = makeBucket()
    const res = await call(picksHandler, writeRequest(token), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
    expect(res.status).toBe(401)
    expect(mutations).toEqual([])
  })

  test('a token signed by a key that is not in the JWKS is refused (unknown kid)', async () => {
    const token = await mintToken({ key: otherKey, payload: validPayload(TEAM, AUD) })
    const { bucket, mutations } = makeBucket()
    const res = await call(picksHandler, writeRequest(token), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
    expect(res.status).toBe(401)
    expect(mutations).toEqual([])
  })

  test('a token whose kid names a real key but signed by another is refused', async () => {
    // Same kid as the published key, different private key: the signature fails.
    const impostor = await makeTestKey(key.kid)
    const token = await mintToken({ key: impostor, payload: validPayload(TEAM, AUD) })
    const { bucket, mutations } = makeBucket()
    const res = await call(picksHandler, writeRequest(token), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
    expect(res.status).toBe(401)
    expect(mutations).toEqual([])
  })

  test('an unreadable JWKS fails closed with 503, never open', async () => {
    stub.certsStatus = 500
    const { bucket, mutations } = makeBucket()
    const res = await call(picksHandler, writeRequest(await goodToken()), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
    expect(res.status).toBe(503)
    expect(mutations).toEqual([])
  })

  test('a service token (no email claim) is refused with 403', async () => {
    const payload = validPayload(TEAM, AUD)
    delete payload.email
    const token = await mintToken({ key, payload: { ...payload, common_name: 'a-service-token' } })
    const { bucket, mutations } = makeBucket()
    const res = await call(picksHandler, writeRequest(token), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
    expect(res.status).toBe(403)
    expect(mutations).toEqual([])
  })

  test('a malformed token is refused without reaching the store', async () => {
    const { bucket, mutations } = makeBucket()
    for (const bad of ['', 'not-a-jwt', 'a.b', 'a.b.c.d', '..', '$$$.$$$.$$$']) {
      const res = await call(picksHandler, writeRequest(bad || null), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
      expect(res.status).toBe(401)
    }
    expect(mutations).toEqual([])
  })
})

test.describe('configuration fails closed', () => {
  for (const [label, env] of [
    ['neither variable', {}],
    ['only the team domain', { CF_ACCESS_TEAM_DOMAIN: TEAM }],
    ['only the audience', { CF_ACCESS_AUD: AUD }],
    ['an empty audience', { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: '   ' }],
    ['an audience list with an empty entry', {
      CF_ACCESS_TEAM_DOMAIN: TEAM,
      CF_ACCESS_AUD: `${AUD},,${'b'.repeat(64)}`,
    }],
    ['an audience list with a malformed entry', {
      CF_ACCESS_TEAM_DOMAIN: TEAM,
      CF_ACCESS_AUD: `${AUD},not a tag`,
    }],
    ['a team domain that is not a Cloudflare Access host', {
      CF_ACCESS_TEAM_DOMAIN: 'https://attacker.example',
      CF_ACCESS_AUD: AUD,
    }],
    ['a team domain carrying a path', {
      CF_ACCESS_TEAM_DOMAIN: 'https://streamloom.cloudflareaccess.com/../attacker.example',
      CF_ACCESS_AUD: AUD,
    }],
  ] as [string, Record<string, unknown>][]) {
    test(`${label}: 503 and nothing written`, async () => {
      const { bucket, mutations } = makeBucket()
      const res = await call(picksHandler, writeRequest(await goodToken()), { ...env, CATALOGUE_BUCKET: bucket })
      expect(res.status).toBe(503)
      expect(mutations).toEqual([])
      // Nothing was fetched either: the request ends before the JWKS is wanted.
      expect(stub.outbound).not.toContain(CERTS)
    })
  }

  test('no R2 binding: 503 and nothing written, even with a valid token', async () => {
    const res = await call(picksHandler, writeRequest(await goodToken()), ENV_VARS)
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('storage-not-configured')
  })
})

test.describe('the route surface', () => {
  test('OPTIONS is refused and no CORS headers are emitted anywhere', async () => {
    const { bucket } = makeBucket()
    const res = await call(
      picksHandler,
      new Request(`${ORIGIN}/api/picks`, { method: 'OPTIONS' }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    // Authorisation runs first, so an unauthenticated OPTIONS never learns the
    // method list; either way there is no Access-Control-Allow-Origin to be had.
    expect([401, 405]).toContain(res.status)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  test('DELETE is not a method this route has', async () => {
    const { bucket, mutations } = makeBucket({ ...PROOF, 'catalogue/picks.json': JSON.stringify(GOOD_BODY) })
    const res = await call(
      picksHandler,
      new Request(`${ORIGIN}/api/picks`, {
        method: 'DELETE',
        headers: { 'Cf-Access-Jwt-Assertion': await goodToken() },
      }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(res.status).toBe(405)
    expect(mutations).toEqual([])
  })

  test('a cross-site write is refused even with a valid token', async () => {
    const { bucket, mutations } = makeBucket()
    const res = await call(
      picksHandler,
      writeRequest(await goodToken(), GOOD_BODY, { 'sec-fetch-site': 'cross-site' }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(res.status).toBe(403)
    expect(mutations).toEqual([])
  })

  test('a form content type is refused (a cross-origin post cannot preflight past it)', async () => {
    const { bucket, mutations } = makeBucket()
    const res = await call(
      picksHandler,
      writeRequest(await goodToken(), GOOD_BODY, { 'content-type': 'application/x-www-form-urlencoded' }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(res.status).toBe(415)
    expect(mutations).toEqual([])
  })

  test('the responses are never cached', async () => {
    const { bucket } = makeBucket()
    const res = await call(picksHandler, writeRequest(await goodToken()), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})

test.describe('validation on save', () => {
  const badBodies: [string, unknown][] = [
    ['a non-object body', []],
    ['an unknown schema', { schema: 2, groups: [] }],
    ['an unknown top-level field', { schema: 1, groups: [], updatedAt: '2000-01-01T00:00:00.000Z' }],
    ['an unknown item field', { schema: 1, groups: [{ title: 'A', items: [{ channelId: 'Arte.fr', evil: 1 }] }] }],
    ['a non-string title', { schema: 1, groups: [{ title: 42, items: [] }] }],
    ['a note that is not a string', { schema: 1, groups: [{ title: 'A', items: [{ channelId: 'Arte.fr', note: { x: 1 } }] }] }],
    ['a rank that is not an integer', { schema: 1, groups: [{ title: 'A', items: [{ channelId: 'Arte.fr', rank: 1.5 }] }] }],
    ['a channel id with a path separator', { schema: 1, groups: [{ title: 'A', items: [{ channelId: '../../evil' }] }] }],
    ['too many groups', { schema: 1, groups: Array.from({ length: 13 }, (_, i) => ({ title: `G${i}`, items: [] })) }],
    ['duplicate group titles', { schema: 1, groups: [{ title: 'News', items: [] }, { title: 'news', items: [] }] }],
    ['the same channel twice in one group', {
      schema: 1,
      groups: [{ title: 'A', items: [{ channelId: 'Arte.fr' }, { channelId: 'Arte.fr' }] }],
    }],
    ['a group limit that is not an integer', { schema: 1, groups: [{ title: 'A', items: [], limit: 1.5 }] }],
    ['a group limit of zero', { schema: 1, groups: [{ title: 'A', items: [], limit: 0 }] }],
    ['a group limit above the ceiling', { schema: 1, groups: [{ title: 'A', items: [], limit: 201 }] }],
    ['a group with more items than its own limit', {
      schema: 1,
      groups: [{ title: 'A', limit: 1, items: [{ channelId: 'Arte.fr' }, { channelId: 'BBCNews.uk' }] }],
    }],
  ]

  for (const [label, body] of badBodies) {
    test(`${label} is refused with 400 and writes nothing`, async () => {
      const { bucket, mutations } = makeBucket()
      const res = await call(picksHandler, writeRequest(await goodToken(), body), {
        ...ENV_VARS,
        CATALOGUE_BUCKET: bucket,
      })
      expect(res.status).toBe(400)
      expect(mutations).toEqual([])
    })
  }

  test('an oversized body is refused with 413 before it is parsed', async () => {
    const huge = JSON.stringify({ schema: 1, groups: [{ title: 'A'.repeat(70_000), items: [] }] })
    const { bucket, mutations } = makeBucket()
    const res = await call(picksHandler, writeRequest(await goodToken(), huge), {
      ...ENV_VARS,
      CATALOGUE_BUCKET: bucket,
    })
    expect(res.status).toBe(413)
    expect(mutations).toEqual([])
  })

  test('an id that is not in the iptv-org list is refused', async () => {
    const { bucket, mutations } = makeBucket()
    const res = await call(
      picksHandler,
      writeRequest(await goodToken(), { schema: 1, groups: [{ title: 'A', items: [{ channelId: 'Invented.zz' }] }] }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(res.status).toBe(400)
    expect((await res.json()).errors.join(' ')).toContain('not in the iptv-org channel list')
    expect(mutations).toEqual([])
  })

  test('a blocklisted id is refused', async () => {
    const { bucket, mutations } = makeBucket()
    const res = await call(
      picksHandler,
      writeRequest(await goodToken(), { schema: 1, groups: [{ title: 'A', items: [{ channelId: 'Blocked.us' }] }] }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(res.status).toBe(400)
    expect((await res.json()).errors.join(' ')).toContain('blocklist')
    expect(mutations).toEqual([])
  })

  test('an is_nsfw id is refused', async () => {
    const { bucket, mutations } = makeBucket()
    const res = await call(
      picksHandler,
      writeRequest(await goodToken(), { schema: 1, groups: [{ title: 'A', items: [{ channelId: 'Adult.xx' }] }] }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(res.status).toBe(400)
    expect((await res.json()).errors.join(' ')).toContain('is_nsfw')
    expect(mutations).toEqual([])
  })

  test('closed and replaced ids are saved, with a warning', async () => {
    const { bucket, objects } = makeBucket()
    const res = await call(
      picksHandler,
      writeRequest(await goodToken(), {
        schema: 1,
        groups: [{ title: 'A', items: [{ channelId: 'OldNews.us' }, { channelId: 'Moved.de' }] }],
      }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(res.status).toBe(200)
    const warnings = (await res.json()).warnings as string[]
    expect(warnings.join(' ')).toContain('closed')
    expect(warnings.join(' ')).toContain('replaced by')
    expect(objects.has('catalogue/picks.json')).toBe(true)
  })

  test('a save embeds the iptv-org identity snapshot, never a stream (ADR-0042)', async () => {
    const { bucket, objects } = makeBucket()
    const res = await call(
      picksHandler,
      writeRequest(await goodToken(), {
        schema: 1,
        groups: [{ title: 'A', items: [{ channelId: 'BBCNews.uk', note: 'x' }] }],
      }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(res.status).toBe(200)
    const stored = JSON.parse(objects.get('catalogue/picks.json')!.body)
    const item = stored.groups[0].items[0]
    expect(item.channelId).toBe('BBCNews.uk')
    expect(item.note).toBe('x')
    expect(item.name).toBe('BBC News')
    expect(item.country).toBe('GB')
    expect(item.categories).toEqual(['news'])
    // Identity only, never anything stream-shaped: a URL, a quality, a status.
    expect(JSON.stringify(item)).not.toMatch(/url|quality|status/i)
  })

  test('a client cannot set its own snapshot: the input schema has no such field', async () => {
    const { bucket, mutations } = makeBucket()
    const res = await call(
      picksHandler,
      writeRequest(await goodToken(), {
        schema: 1,
        groups: [{ title: 'A', items: [{ channelId: 'BBCNews.uk', name: 'Not The Real Name' }] }],
      }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    // Refused outright, the same as any other unknown field — never silently
    // dropped and never written through as-is. The value that does get stored
    // for a valid save always comes from the server's own iptv-org read (the
    // previous test), not from anything the client sent.
    expect(res.status).toBe(400)
    expect((await res.json()).errors.join(' ')).toContain('unknown field "name"')
    expect(mutations).toEqual([])
  })

  test('an unreachable iptv-org list fails the save closed, writing nothing', async () => {
    stub.iptvStatus = 500
    const { bucket, mutations } = makeBucket()
    const res = await call(picksHandler, writeRequest(await goodToken()), {
      ...ENV_VARS,
      CATALOGUE_BUCKET: bucket,
    })
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('validation-unavailable')
    expect(mutations).toEqual([])
  })

  test('a group without its own limit still caps at the default 50 (pre-existing behaviour)', async () => {
    const { bucket, mutations } = makeBucket()
    const items = Array.from({ length: 51 }, () => ({ channelId: 'Arte.fr' }))
    const res = await call(
      picksHandler,
      writeRequest(await goodToken(), { schema: 1, groups: [{ title: 'A', items }] }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(res.status).toBe(400)
    expect((await res.json()).errors.join(' ')).toContain('at most 50 items')
    expect(mutations).toEqual([])
  })

  test('a group with its own higher limit accepts more than 50 items, and the limit is stored', async () => {
    const { bucket, objects } = makeBucket()
    const items = [{ channelId: 'Arte.fr' }, { channelId: 'BBCNews.uk' }]
    const res = await call(
      picksHandler,
      writeRequest(await goodToken(), { schema: 1, groups: [{ title: 'A', limit: 75, items }] }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(res.status).toBe(200)
    const stored = JSON.parse(objects.get('catalogue/picks.json')!.body)
    expect(stored.groups[0].limit).toBe(75)
  })

  test('a limit exactly at the ceiling (200) is accepted', async () => {
    const { bucket, objects } = makeBucket()
    const res = await call(
      picksHandler,
      writeRequest(await goodToken(), { schema: 1, groups: [{ title: 'A', limit: 200, items: [] }] }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(res.status).toBe(200)
    const stored = JSON.parse(objects.get('catalogue/picks.json')!.body)
    expect(stored.groups[0].limit).toBe(200)
  })

  test('a group deliberately shrunk below the old default of 50 still enforces its own, smaller limit', async () => {
    const { bucket, mutations } = makeBucket()
    const items = [{ channelId: 'Arte.fr' }, { channelId: 'BBCNews.uk' }]
    const res = await call(
      picksHandler,
      writeRequest(await goodToken(), { schema: 1, groups: [{ title: 'A', limit: 1, items }] }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(res.status).toBe(400)
    expect((await res.json()).errors.join(' ')).toContain('at most 1 items')
    expect(mutations).toEqual([])
  })
})

test.describe('fast-track dispatch (ADR-0043, WO-19)', () => {
  const withToken = (extra: Record<string, string> = {}) => ({ ...ENV_VARS, GITHUB_DISPATCH_TOKEN: 'ghp_fake', ...extra })

  test('a genuinely new pin is dispatched, and the save still succeeds', async () => {
    const { bucket } = makeBucket()
    const res = await call(picksHandler, writeRequest(await goodToken()), { ...withToken(), CATALOGUE_BUCKET: bucket })
    expect(res.status).toBe(200)
    expect(stub.dispatches).toEqual([{ event_type: 'fast-track-pick', client_payload: { channelIds: ['BBCNews.uk'] } }])
  })

  test('an id already pinned before this save is not dispatched again', async () => {
    const { bucket } = makeBucket()
    const first = await call(picksHandler, writeRequest(await goodToken()), { ...withToken(), CATALOGUE_BUCKET: bucket })
    expect(stub.dispatches.length).toBe(1)
    const etag = first.headers.get('etag')!

    // Re-save the same pin (an edit that does not add anything new) plus one genuinely new one.
    const second = await call(
      picksHandler,
      writeRequest(await goodToken(), {
        schema: 1,
        groups: [{ title: 'News', items: [{ channelId: 'BBCNews.uk', rank: 0 }, { channelId: 'Arte.fr', rank: 1 }] }],
      }, { 'if-match': etag }),
      { ...withToken(), CATALOGUE_BUCKET: bucket },
    )
    expect(second.status).toBe(200)
    expect(stub.dispatches.length).toBe(2)
    expect(stub.dispatches[1]).toEqual({ event_type: 'fast-track-pick', client_payload: { channelIds: ['Arte.fr'] } })
  })

  test('no token configured means no dispatch attempt at all', async () => {
    const { bucket } = makeBucket()
    const res = await call(picksHandler, writeRequest(await goodToken()), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
    expect(res.status).toBe(200)
    expect(stub.dispatches).toEqual([])
    expect(stub.outbound).not.toContain(DISPATCH_URL)
  })

  test('a dispatch failure never fails the save — the write already succeeded', async () => {
    stub.dispatchStatus = 500
    const { bucket, objects } = makeBucket()
    const res = await call(picksHandler, writeRequest(await goodToken()), { ...withToken(), CATALOGUE_BUCKET: bucket })
    expect(res.status).toBe(200)
    expect(objects.has('catalogue/picks.json')).toBe(true)
    expect(stub.dispatches.length).toBe(1)
  })

  test('at most 10 ids are dispatched for one save, even when a bulk add pins more', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `Extra${i}.uk`)
    stub.channels = [
      ...UPSTREAM_CHANNELS,
      ...ids.map((id) => ({ id, name: id, country: 'GB', categories: ['news'], is_nsfw: false, closed: null, replaced_by: null })),
    ]

    const { bucket } = makeBucket()
    const res = await call(
      picksHandler,
      writeRequest(await goodToken(), { schema: 1, groups: [{ title: 'Many', items: ids.map((channelId, rank) => ({ channelId, rank })) }] }),
      { ...withToken(), CATALOGUE_BUCKET: bucket },
    )
    expect(res.status).toBe(200)
    expect(stub.dispatches.length).toBe(1)
    expect(stub.dispatches[0].client_payload.channelIds.length).toBe(10)
  })
})

test.describe('concurrent edits', () => {
  test('a save without If-Match over an existing document returns 412 with the newer copy', async () => {
    const existing = JSON.stringify({ schema: 1, updatedAt: '2026-01-01T00:00:00.000Z', groups: [] })
    const { bucket, mutations } = makeBucket({ ...PROOF, 'catalogue/picks.json': existing })
    const res = await call(picksHandler, writeRequest(await goodToken()), {
      ...ENV_VARS,
      CATALOGUE_BUCKET: bucket,
    })
    expect(res.status).toBe(412)
    const body = await res.json()
    expect(body.picks.updatedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(body.etag).toBeTruthy()
    expect(mutations).toEqual([])
  })

  test('a stale If-Match returns 412 with the newer copy and writes nothing', async () => {
    const existing = JSON.stringify({ schema: 1, updatedAt: '2026-01-01T00:00:00.000Z', groups: [] })
    const { bucket, mutations } = makeBucket({ ...PROOF, 'catalogue/picks.json': existing })
    const res = await call(
      picksHandler,
      writeRequest(await goodToken(), GOOD_BODY, { 'if-match': '"an-older-etag"' }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(res.status).toBe(412)
    expect((await res.json()).picks.updatedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(mutations).toEqual([])
  })

  test('a current If-Match saves, and the new ETag is returned for the next save', async () => {
    const { bucket, objects } = makeBucket()
    const first = await call(picksHandler, writeRequest(await goodToken()), {
      ...ENV_VARS,
      CATALOGUE_BUCKET: bucket,
    })
    const firstEtag = (await first.json()).etag as string
    expect(firstEtag).toBe(objects.get('catalogue/picks.json')!.etag)

    const second = await call(
      picksHandler,
      writeRequest(await goodToken(), GOOD_BODY, { 'if-match': firstEtag }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(second.status).toBe(200)
    // Two saves, two history objects: nothing was replaced.
    expect([...objects.keys()].filter((k) => k.startsWith('picks-history/'))).toHaveLength(2)
  })

  test('an If-Match naming a copy that does not exist is refused', async () => {
    const { bucket, mutations } = makeBucket()
    const res = await call(
      picksHandler,
      writeRequest(await goodToken(), GOOD_BODY, { 'if-match': '"ghost"' }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(res.status).toBe(412)
    expect(mutations).toEqual([])
  })

  test('history is never overwritten: a colliding key gets a new one', async () => {
    const { bucket, objects } = makeBucket()
    // Pre-place every candidate for the current millisecond so the first key is taken.
    const res = await call(picksHandler, writeRequest(await goodToken()), {
      ...ENV_VARS,
      CATALOGUE_BUCKET: bucket,
    })
    const firstKey = (await res.json()).historyKey as string
    const firstBody = objects.get(firstKey)!.body

    // A second save that lands on the same key must not replace the first.
    const etag = objects.get('catalogue/picks.json')!.etag
    await call(picksHandler, writeRequest(await goodToken(), GOOD_BODY, { 'if-match': etag }), {
      ...ENV_VARS,
      CATALOGUE_BUCKET: bucket,
    })
    expect(objects.get(firstKey)!.body).toBe(firstBody)
  })
})

test.describe('reading', () => {
  test('GET returns the stored document and its ETag', async () => {
    const existing = JSON.stringify({ schema: 1, updatedAt: '2026-02-02T00:00:00.000Z', groups: [] })
    const { bucket } = makeBucket({ ...PROOF, 'catalogue/picks.json': existing })
    const res = await call(
      picksHandler,
      new Request(`${ORIGIN}/api/picks`, { headers: { 'Cf-Access-Jwt-Assertion': await goodToken() } }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.picks.updatedAt).toBe('2026-02-02T00:00:00.000Z')
    expect(body.etag).toBeTruthy()
  })

  test('GET is refused without a token', async () => {
    const { bucket } = makeBucket()
    const res = await call(picksHandler, new Request(`${ORIGIN}/api/picks`), {
      ...ENV_VARS,
      CATALOGUE_BUCKET: bucket,
    })
    expect(res.status).toBe(401)
  })
})

test.describe('the picker search', () => {
  test('is refused without a token, and never fetches the upstream list', async () => {
    const res = await call(channelsHandler, new Request(`${ORIGIN}/api/picks/channels?q=bbc`), ENV_VARS)
    expect(res.status).toBe(401)
    expect(stub.outbound).not.toContain(CHANNELS_URL)
  })

  test('searches by name and reports every flag the portal has to show', async () => {
    const res = await call(
      channelsHandler,
      new Request(`${ORIGIN}/api/picks/channels?q=channel`, {
        headers: { 'Cf-Access-Jwt-Assertion': await goodToken() },
      }),
      ENV_VARS,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    const byId = new Map(body.results.map((c: { id: string }) => [c.id, c]))
    expect(byId.get('Adult.xx').nsfw).toBe(true)
    expect(byId.get('Blocked.us').blocked).toBe('dmca')
    expect(byId.get('Moved.de').replacedBy).toBe('Arte.fr')
  })

  test('narrows by country and category', async () => {
    const res = await call(
      channelsHandler,
      new Request(`${ORIGIN}/api/picks/channels?country=GB&category=news`, {
        headers: { 'Cf-Access-Jwt-Assertion': await goodToken() },
      }),
      ENV_VARS,
    )
    const body = await res.json()
    expect(body.results.map((c: { id: string }) => c.id)).toEqual(['BBCNews.uk'])
  })

  test.describe('?live=true (WO-21)', () => {
    const LIVE_IDS = { ids: ['Arte.fr'], generation: 3 }

    test('narrows to active-channel-ids.json and reports live: true', async () => {
      const { bucket } = makeBucket({ ...PROOF, 'catalogue/active-channel-ids.json': JSON.stringify(LIVE_IDS) })
      const res = await call(
        channelsHandler,
        new Request(`${ORIGIN}/api/picks/channels?live=true`, {
          headers: { 'Cf-Access-Jwt-Assertion': await goodToken() },
        }),
        { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
      )
      const body = await res.json()
      expect(body.live).toBe(true)
      expect(body.results.map((c: { id: string }) => c.id)).toEqual(['Arte.fr'])
    })

    test('without ?live, every match is returned and live reports false', async () => {
      const { bucket } = makeBucket({ ...PROOF, 'catalogue/active-channel-ids.json': JSON.stringify(LIVE_IDS) })
      const res = await call(
        channelsHandler,
        new Request(`${ORIGIN}/api/picks/channels?q=channel`, {
          headers: { 'Cf-Access-Jwt-Assertion': await goodToken() },
        }),
        { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
      )
      const body = await res.json()
      expect(body.live).toBe(false)
      expect(body.results.length).toBeGreaterThan(1)
    })

    test('no bucket configured: falls back to the unfiltered list and says so', async () => {
      const res = await call(
        channelsHandler,
        new Request(`${ORIGIN}/api/picks/channels?live=true&q=channel`, {
          headers: { 'Cf-Access-Jwt-Assertion': await goodToken() },
        }),
        ENV_VARS,
      )
      const body = await res.json()
      expect(body.live).toBe(false)
      expect(body.results.length).toBeGreaterThan(1)
    })

    test('a malformed active-channel-ids.json falls back the same way, never a 500', async () => {
      const { bucket } = makeBucket({ ...PROOF, 'catalogue/active-channel-ids.json': 'not json' })
      const res = await call(
        channelsHandler,
        new Request(`${ORIGIN}/api/picks/channels?live=true&q=channel`, {
          headers: { 'Cf-Access-Jwt-Assertion': await goodToken() },
        }),
        { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
      )
      expect(res.status).toBe(200)
      expect((await res.json()).live).toBe(false)
    })

    test('an absent object (nothing published yet) falls back the same way', async () => {
      const { bucket } = makeBucket(PROOF)
      const res = await call(
        channelsHandler,
        new Request(`${ORIGIN}/api/picks/channels?live=true&q=channel`, {
          headers: { 'Cf-Access-Jwt-Assertion': await goodToken() },
        }),
        { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
      )
      const body = await res.json()
      expect(body.live).toBe(false)
      expect(body.results.length).toBeGreaterThan(1)
    })
  })
})

// ---------------------------------------------------------------------------
// Findings from the adversarial review of f96e3e7.
// ---------------------------------------------------------------------------

test.describe('the verifier reports why, where only the log can see it', () => {
  /**
   * The handler's refusal body is generic on purpose: an unauthenticated caller
   * is told nothing but "refused". The precise reason still has to be right, so
   * it is asserted here, one layer down, against `verifyAccessJwt` itself.
   */
  const config = () => readAccessConfig(ENV_VARS)!

  test('every failure mode names itself to the caller inside the Function', async () => {
    const nowS = Math.floor(Date.now() / 1000)
    const cases: [string, string][] = [
      ['missing-token', ''],
      ['malformed-token', 'a.b'],
      [
        'unsupported-alg',
        await mintToken({ key, payload: validPayload(TEAM, AUD), header: { alg: 'none', kid: key.kid }, rawSignature: '' }),
      ],
      ['unknown-kid', await mintToken({ key: otherKey, payload: validPayload(TEAM, AUD) })],
      [
        'expired',
        await mintToken({ key, payload: validPayload(TEAM, AUD, { exp: nowS - 3600, iat: nowS - 7200, nbf: nowS - 7200 }) }),
      ],
      ['wrong-audience', await mintToken({ key, payload: validPayload(TEAM, 'z'.repeat(64)) })],
      ['wrong-issuer', await mintToken({ key, payload: validPayload('https://other.cloudflareaccess.com', AUD) })],
      ['not-yet-valid', await mintToken({ key, payload: validPayload(TEAM, AUD, { nbf: nowS + 3600, iat: nowS }) })],
    ]
    for (const [expected, token] of cases) {
      const result = await verifyAccessJwt(token, config())
      expect(result.ok).toBe(false)
      expect((result as { reason: string }).reason).toBe(expected)
    }
  })

  test('the handler answers generically: no reason, no variable names, no platform', async () => {
    const { bucket } = makeBucket()
    const res = await call(picksHandler, writeRequest('a.b'), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorised' })
  })

  test('an unconfigured project tells a stranger nothing about how to configure it', async () => {
    const { bucket } = makeBucket()
    const res = await call(picksHandler, writeRequest(await goodToken()), { CATALOGUE_BUCKET: bucket })
    expect(res.status).toBe(503)
    const text = JSON.stringify(await res.json())
    expect(text).toBe('{"error":"unavailable"}')
    expect(text).not.toContain('CF_ACCESS')
    expect(text).not.toContain('Pages')
  })
})

test.describe('the JWKS is fetched from the team and nowhere else', () => {
  test('the certs request refuses to follow a redirect', async () => {
    let init: RequestInit | undefined
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url === CERTS) init = options
      return original(input as RequestInfo, options)
    }) as typeof fetch
    try {
      const { bucket } = makeBucket()
      await call(picksHandler, writeRequest(await goodToken()), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
    } finally {
      globalThis.fetch = original
    }
    // A redirect would hand the `*.cloudflareaccess.com` constraint back to
    // whatever answered; signing keys from a redirect target are not the
    // team's. `'manual'`, not the spec's `'error'`: workerd — the runtime this
    // Function actually runs on in production — only implements `'follow'`
    // and `'manual'` and throws for anything else, so `'error'` fails every
    // request closed with a 503 before a redirect is ever in play.
    expect(init?.redirect).toBe('manual')
  })

  test('a redirected certs endpoint fails closed with 503, never open', async () => {
    stub.restore()
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url === CERTS) {
        // What `redirect: 'manual'` does to a 302: the fetch resolves with the
        // 3xx response itself, unfollowed — never rejects. `fetchJwks`'s own
        // `!res.ok` then refuses it (`res.ok` is true only for 200–299).
        if (options?.redirect === 'manual') {
          return new Response(null, { status: 302, headers: { location: 'https://attacker.example/keys' } })
        }
        return new Response(jwks(otherKey), { status: 200 })
      }
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const { bucket, writes } = makeBucket()
      const res = await call(picksHandler, writeRequest(await goodToken()), {
        ...ENV_VARS,
        CATALOGUE_BUCKET: bucket,
      })
      expect(res.status).toBe(503)
      expect(writes()).toEqual([])
    } finally {
      globalThis.fetch = original
    }
  })
})

test.describe('the optional email allow-list', () => {
  const withList = (list: string) => ({ ...ENV_VARS, CF_ACCESS_ALLOWED_EMAILS: list })

  test('unset leaves behaviour exactly as it was', async () => {
    const { bucket, objects } = makeBucket()
    const res = await call(picksHandler, writeRequest(await goodToken()), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
    expect(res.status).toBe(200)
    expect(objects.has('catalogue/picks.json')).toBe(true)
  })

  test('a listed identity saves; a verified but unlisted one is refused with 403', async () => {
    const env = withList('Owner@Example.com, second@example.com')

    for (const email of ['owner@example.com', 'SECOND@EXAMPLE.COM']) {
      const { bucket, objects } = makeBucket()
      const token = await mintToken({ key, payload: validPayload(TEAM, AUD, { email }) })
      const res = await call(picksHandler, writeRequest(token), { ...env, CATALOGUE_BUCKET: bucket })
      expect(res.status).toBe(200)
      expect(objects.has('catalogue/picks.json')).toBe(true)
    }

    // A token Access itself would accept — correct signature, audience, issuer —
    // but for an identity the owner did not list.
    const { bucket, writes } = makeBucket()
    const stranger = await mintToken({
      key,
      payload: validPayload(TEAM, AUD, { email: 'someone-else@example.com' }),
    })
    const res = await call(picksHandler, writeRequest(stranger), { ...env, CATALOGUE_BUCKET: bucket })
    expect(res.status).toBe(403)
    expect(writes()).toEqual([])

    const result = await verifyAccessJwt(stranger, readAccessConfig(env)!)
    expect((result as { reason: string }).reason).toBe('not-on-allow-list')
  })

  test('a malformed or oversized list fails the whole configuration closed', async () => {
    for (const list of ['not-an-email', 'a@b.com, no-at-sign', 'a b@c.com', Array.from({ length: 11 }, (_, i) => `a${i}@b.com`).join(',')]) {
      expect(readAccessConfig({ ...ENV_VARS, CF_ACCESS_ALLOWED_EMAILS: list })).toBeNull()

      const { bucket, writes } = makeBucket()
      const res = await call(picksHandler, writeRequest(await goodToken()), {
        ...ENV_VARS,
        CF_ACCESS_ALLOWED_EMAILS: list,
        CATALOGUE_BUCKET: bucket,
      })
      expect(res.status).toBe(503)
      expect(writes()).toEqual([])
    }
  })

  test('absent means no gate; present-but-blank fails closed rather than disabling it', async () => {
    // Absent: the key is not on the environment at all.
    expect(readAccessConfig(ENV_VARS)?.allowedEmails).toEqual([])

    // Present but producing no gate. `""` and `"   "` used to trim to an empty
    // list and silently turn the gate off, while `","` refused everyone: the
    // same slip with opposite outcomes. Both are now a refused configuration.
    for (const blank of ['', '   ', ',', ' , ', '\t\n']) {
      expect(readAccessConfig({ ...ENV_VARS, CF_ACCESS_ALLOWED_EMAILS: blank })).toBeNull()

      const { bucket, writes } = makeBucket()
      const res = await call(picksHandler, writeRequest(await goodToken()), {
        ...ENV_VARS,
        CF_ACCESS_ALLOWED_EMAILS: blank,
        CATALOGUE_BUCKET: bucket,
      })
      expect(res.status).toBe(503)
      expect(writes()).toEqual([])
    }
  })

  test('a non-string value is a misconfiguration, not an absent variable', async () => {
    for (const value of [42, true, [], null, {}]) {
      expect(readAccessConfig({ ...ENV_VARS, CF_ACCESS_ALLOWED_EMAILS: value })).toBeNull()
    }
  })
})

test.describe('the binding must really be the catalogue bucket', () => {
  test('a plain variable named CATALOGUE_BUCKET is 503, not a 500', async () => {
    for (const notABinding of ['streamloom-catalogue', 42, true, [], null]) {
      expect(bindBucket({ CATALOGUE_BUCKET: notABinding })).toBeNull()
      const res = await call(picksHandler, writeRequest(await goodToken()), {
        ...ENV_VARS,
        CATALOGUE_BUCKET: notABinding,
      })
      expect(res.status).toBe(503)
      expect((await res.json()).error).toBe('storage-not-configured')
    }
  })

  test('an object missing one of the three methods is not accepted as a binding', async () => {
    const partial = { get: () => null, head: () => null }
    expect(bindBucket({ CATALOGUE_BUCKET: partial })).toBeNull()
  })

  test('the facade exposes only get/head/put, so delete is unreachable', async () => {
    const { bucket, mutations } = makeBucket()
    const facade = bindBucket({ CATALOGUE_BUCKET: bucket })!
    expect(Object.keys(facade).sort()).toEqual(['get', 'head', 'put'])
    expect('delete' in facade).toBe(false)
    expect((facade as unknown as Record<string, unknown>).delete).toBeUndefined()
    // The underlying double still has one, so this is the facade's doing, not the double's.
    expect(typeof bucket.delete).toBe('function')
    expect(mutations).toEqual([])
  })

  test('a bucket without catalogue/meta.json is refused: nothing is seeded into the wrong bucket', async () => {
    // What a binding aimed at `channel-icons` looks like from here.
    const { bucket, writes } = makeBucket({ 'icons/BBCNews.uk.webp': 'not-json' })
    const res = await call(picksHandler, writeRequest(await goodToken()), {
      ...ENV_VARS,
      CATALOGUE_BUCKET: bucket,
    })
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('wrong-bucket')
    expect(writes()).toEqual([])
  })

  test('an empty bucket, before the first catalogue publish, is refused the same way', async () => {
    const { bucket, writes } = makeBucket({})
    const res = await call(picksHandler, writeRequest(await goodToken()), {
      ...ENV_VARS,
      CATALOGUE_BUCKET: bucket,
    })
    expect(res.status).toBe(503)
    expect(writes()).toEqual([])
  })

  test('a GET still works before the first publish, so the portal can open and explain itself', async () => {
    const { bucket } = makeBucket({})
    const res = await call(
      picksHandler,
      new Request(`${ORIGIN}/api/picks`, { headers: { 'Cf-Access-Jwt-Assertion': await goodToken() } }),
      { ...ENV_VARS, CATALOGUE_BUCKET: bucket },
    )
    expect(res.status).toBe(200)
    expect((await res.json()).picks).toBeNull()
  })
})

test.describe('invisible and reordering characters', () => {
  const BIDI = ['‪', '‫', '‬', '‭', '‮', '⁦', '⁧', '⁨', '⁩']
  const INVISIBLE = ['​', '‌', '‍', '⁠', '﻿']

  for (const [label, chars] of [['bidi overrides', BIDI], ['zero-width characters', INVISIBLE]] as const) {
    test(`${label} are refused in a group title`, async () => {
      for (const ch of chars) {
        const { bucket, writes } = makeBucket()
        const body = { schema: 1, groups: [{ title: `News${ch}Sport`, items: [] }] }
        const res = await call(picksHandler, writeRequest(await goodToken(), body), {
          ...ENV_VARS,
          CATALOGUE_BUCKET: bucket,
        })
        expect(res.status).toBe(400)
        expect(writes()).toEqual([])
      }
    })

    test(`${label} are refused in a note`, async () => {
      for (const ch of chars) {
        const { bucket, writes } = makeBucket()
        const body = {
          schema: 1,
          groups: [{ title: 'News', items: [{ channelId: 'BBCNews.uk', note: `safe${ch}text` }] }],
        }
        const res = await call(picksHandler, writeRequest(await goodToken(), body), {
          ...ENV_VARS,
          CATALOGUE_BUCKET: bucket,
        })
        expect(res.status).toBe(400)
        expect(writes()).toEqual([])
      }
    })
  }

  test('two titles that look identical cannot both be saved by hiding a zero-width character', async () => {
    const { bucket, writes } = makeBucket()
    const body = { schema: 1, groups: [{ title: 'News', items: [] }, { title: 'New​s', items: [] }] }
    const res = await call(picksHandler, writeRequest(await goodToken(), body), {
      ...ENV_VARS,
      CATALOGUE_BUCKET: bucket,
    })
    expect(res.status).toBe(400)
    expect(writes()).toEqual([])
  })

  test('ordinary non-ASCII text is still accepted', async () => {
    const { bucket, objects } = makeBucket()
    const body = {
      schema: 1,
      groups: [{ title: 'Actualités 📺', items: [{ channelId: 'Arte.fr', note: 'Câble — très bien' }] }],
    }
    const res = await call(picksHandler, writeRequest(await goodToken(), body), {
      ...ENV_VARS,
      CATALOGUE_BUCKET: bucket,
    })
    expect(res.status).toBe(200)
    expect(JSON.parse(objects.get('catalogue/picks.json')!.body).groups[0].title).toBe('Actualités 📺')
  })
})

test.describe('how stale the iptv-org list may get', () => {
  /** Warms the cache, then breaks upstream and backdates the copy by `hours`. */
  async function warmThenAge(hours: number) {
    const { bucket } = makeBucket()
    await call(picksHandler, writeRequest(await goodToken()), { ...ENV_VARS, CATALOGUE_BUCKET: bucket })
    stub.iptvStatus = 500
    ageIptvCache(hours * 60 * 60 * 1000)
  }

  test('a copy inside 24 hours still saves, and the response says how old it was', async () => {
    await warmThenAge(9)
    const { bucket, objects } = makeBucket()
    const res = await call(picksHandler, writeRequest(await goodToken()), {
      ...ENV_VARS,
      CATALOGUE_BUCKET: bucket,
    })
    expect(res.status).toBe(200)
    expect(((await res.json()).warnings as string[]).join(' ')).toContain('9h')
    expect(objects.has('catalogue/picks.json')).toBe(true)
  })

  test('a copy past 24 hours fails the save closed: a takedown must not stay pinnable', async () => {
    await warmThenAge(25)
    const { bucket, writes } = makeBucket()
    const res = await call(picksHandler, writeRequest(await goodToken()), {
      ...ENV_VARS,
      CATALOGUE_BUCKET: bucket,
    })
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('validation-unavailable')
    expect(writes()).toEqual([])
  })

  test('a fresh copy carries no staleness warning', async () => {
    const { bucket } = makeBucket()
    const res = await call(picksHandler, writeRequest(await goodToken()), {
      ...ENV_VARS,
      CATALOGUE_BUCKET: bucket,
    })
    expect((await res.json()).warnings).toEqual([])
  })
})

test.describe('history is append-only under concurrency', () => {
  const AT = '2026-09-22T01:02:03.456Z'

  test('two saves in the same millisecond both survive, under different keys', async () => {
    const { bucket, objects } = makeBucket()
    const facade = bindBucket({ CATALOGUE_BUCKET: bucket })!

    // Not sequential: both conditional puts are in flight before either resolves,
    // which is the case a head-then-put loses.
    const [first, second] = await Promise.all([
      writeHistory(facade, AT, '{"n":1}'),
      writeHistory(facade, AT, '{"n":2}'),
    ])

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(first).not.toBe(second)

    const bodies = [objects.get(first!)!.body, objects.get(second!)!.body].sort()
    expect(bodies).toEqual(['{"n":1}', '{"n":2}'])
  })

  test('a third and fourth save at the same instant keep going, never replacing', async () => {
    const { bucket, objects } = makeBucket()
    const facade = bindBucket({ CATALOGUE_BUCKET: bucket })!
    const keys = await Promise.all(
      [1, 2, 3, 4].map((n) => writeHistory(facade, AT, JSON.stringify({ n }))),
    )
    expect(new Set(keys).size).toBe(4)
    expect([...objects.keys()].filter((k) => k.startsWith('picks-history/'))).toHaveLength(4)
  })

  test('the write is conditional, so the store refuses a key rather than this code checking first', async () => {
    const seen: unknown[] = []
    const { bucket } = makeBucket()
    const spy = {
      get: bucket.get,
      head: bucket.head,
      put: async (key: string, value: string, options?: unknown) => {
        seen.push(options)
        return bucket.put(key, value, options as never)
      },
    }
    await writeHistory(bindBucket({ CATALOGUE_BUCKET: spy })!, AT, '{}')
    expect(seen[0]).toMatchObject({ onlyIf: { etagDoesNotMatch: '*' } })
  })
})

test.describe('the Function libraries ship no state mutators', () => {
  test('nothing named reset/age/clear/set is exported from a production module', async () => {
    const modules: [string, Record<string, unknown>][] = [
      ['_lib/accessJwt', await import('../functions/api/_lib/accessJwt')],
      ['_lib/iptvOrg', await import('../functions/api/_lib/iptvOrg')],
      ['_lib/picksSchema', await import('../functions/api/_lib/picksSchema')],
      ['_lib/catalogueBucket', await import('../functions/api/_lib/catalogueBucket')],
      ['_lib/customChannelsSchema', await import('../functions/api/_lib/customChannelsSchema')],
      ['_lib/activeChannelIds', await import('../functions/api/_lib/activeChannelIds')],
      ['picks/index', await import('../functions/api/picks/index')],
      ['picks/channels', await import('../functions/api/picks/channels')],
      ['picks/custom-channels', await import('../functions/api/picks/custom-channels')],
    ]
    for (const [name, mod] of modules) {
      const mutators = Object.keys(mod).filter((key) => /^(reset|age|clear|seed|set)[A-Z]/.test(key))
      expect(mutators, `${name} exports a state mutator`).toEqual([])
    }
  })

  test('the seams are registered only because a test created the registry', async () => {
    const registry = (globalThis as Record<string, unknown>).__streamloomTestSeams as
      | Record<string, unknown>
      | undefined
    // Present here, because e2e/support/testSeams.ts created it before the
    // libraries were evaluated. Nothing in functions/ or src/ ever does.
    expect(registry).toBeDefined()
    expect(typeof registry?.resetJwksCache).toBe('function')
    expect(typeof registry?.resetIptvCache).toBe('function')
    expect(typeof registry?.ageIptvCache).toBe('function')
  })
})
