import { test, expect } from '@playwright/test'
// FIRST, and deliberately: see the same import in picks-endpoint.spec.ts.
import { resetJwksCache } from './support/testSeams'
import { onRequest as unlockGenerateHandler } from '../functions/api/picks/unlock-generate'
import { onRequest as unlockValidateHandler } from '../functions/api/unlock-validate'
import { deriveUnlockCode } from '../functions/api/_lib/unlockCode'
import { jwks, makeTestKey, mintToken, validPayload, type TestKey } from './support/accessTokens'

/**
 * The two sides of the full-catalogue unlock (ADR-0060): the admin-only derivation
 * (`/api/picks/unlock-generate`, same Access gate as the rest of `/api/picks/*`) and the public
 * redemption (`/api/unlock-validate`, intentionally unauthenticated — see that module's own
 * doc comment). Both are pure functions of `UNLOCK_HMAC_SECRET`, so there is no bucket double
 * here, unlike the other `/api/picks/*` routes.
 */

const ORIGIN = 'https://streamloom.example'
const TEAM = 'https://streamloom.cloudflareaccess.com'
const CERTS = `${TEAM}/cdn-cgi/access/certs`
const AUD = 'a'.repeat(64)
const ENV_VARS = { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD }
const SECRET = 'test-unlock-secret-do-not-use-in-production'

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

function generateRequest(token: string | null, body: unknown = { clientCode: 'ABCDEF' }): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers['Cf-Access-Jwt-Assertion'] = token
  return new Request(`${ORIGIN}/api/picks/unlock-generate`, { method: 'POST', headers, body: JSON.stringify(body) })
}

function validateRequest(body: unknown): Request {
  return new Request(`${ORIGIN}/api/unlock-validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test.describe('unlock-generate: the Access gate', () => {
  test('no token is refused with 401', async () => {
    const res = await call(unlockGenerateHandler, generateRequest(null), { ...ENV_VARS, UNLOCK_HMAC_SECRET: SECRET })
    expect(res.status).toBe(401)
  })

  test('a token for another audience is refused with 403', async () => {
    const token = await mintToken({ key, payload: validPayload(TEAM, 'b'.repeat(64)) })
    const res = await call(unlockGenerateHandler, generateRequest(token), { ...ENV_VARS, UNLOCK_HMAC_SECRET: SECRET })
    expect(res.status).toBe(403)
  })

  test('a valid token derives a 6-character code matching the shared alphabet', async () => {
    const res = await call(unlockGenerateHandler, generateRequest(await goodToken()), { ...ENV_VARS, UNLOCK_HMAC_SECRET: SECRET })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.unlockCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/)
  })

  test('calling it twice for the same client code gives the same unlock code: nothing is stored', async () => {
    const first = await call(unlockGenerateHandler, generateRequest(await goodToken()), { ...ENV_VARS, UNLOCK_HMAC_SECRET: SECRET })
    const second = await call(unlockGenerateHandler, generateRequest(await goodToken()), { ...ENV_VARS, UNLOCK_HMAC_SECRET: SECRET })
    expect((await first.json()).unlockCode).toBe((await second.json()).unlockCode)
  })

  test('no UNLOCK_HMAC_SECRET configured: 503, fails closed', async () => {
    const res = await call(unlockGenerateHandler, generateRequest(await goodToken()), ENV_VARS)
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('unlock-not-configured')
  })

  test('a malformed client code is refused with 400', async () => {
    const res = await call(
      unlockGenerateHandler,
      generateRequest(await goodToken(), { clientCode: 'not-well-formed!' }),
      { ...ENV_VARS, UNLOCK_HMAC_SECRET: SECRET },
    )
    expect(res.status).toBe(400)
  })

  test('method not allowed on anything but POST', async () => {
    const res = await call(
      unlockGenerateHandler,
      new Request(`${ORIGIN}/api/picks/unlock-generate`, { headers: { 'Cf-Access-Jwt-Assertion': await goodToken() } }),
      { ...ENV_VARS, UNLOCK_HMAC_SECRET: SECRET },
    )
    expect(res.status).toBe(405)
  })
})

test.describe('unlock-validate: public, fail-closed', () => {
  test('no auth header is required at all', async () => {
    const unlockCode = await deriveUnlockCode(SECRET, 'ABCDEF')
    const res = await call(
      unlockValidateHandler,
      validateRequest({ clientCode: 'ABCDEF', unlockCode }),
      { UNLOCK_HMAC_SECRET: SECRET },
    )
    expect(res.status).toBe(200)
    expect((await res.json()).valid).toBe(true)
  })

  test('the matching code generated by unlock-generate validates here', async () => {
    const generated = await call(unlockGenerateHandler, generateRequest(await goodToken()), { ...ENV_VARS, UNLOCK_HMAC_SECRET: SECRET })
    const { unlockCode } = await generated.json()
    const res = await call(
      unlockValidateHandler,
      validateRequest({ clientCode: 'ABCDEF', unlockCode }),
      { UNLOCK_HMAC_SECRET: SECRET },
    )
    expect((await res.json()).valid).toBe(true)
  })

  test('a wrong unlock code is invalid, not an error', async () => {
    const res = await call(
      unlockValidateHandler,
      validateRequest({ clientCode: 'ABCDEF', unlockCode: 'ZZZZZZ' }),
      { UNLOCK_HMAC_SECRET: SECRET },
    )
    expect(res.status).toBe(200)
    expect((await res.json()).valid).toBe(false)
  })

  test('a malformed code is invalid, not a 400 — it never reaches the HMAC', async () => {
    const res = await call(
      unlockValidateHandler,
      validateRequest({ clientCode: 'short', unlockCode: 'ZZZZZZ' }),
      { UNLOCK_HMAC_SECRET: SECRET },
    )
    expect(res.status).toBe(200)
    expect((await res.json()).valid).toBe(false)
  })

  test('no UNLOCK_HMAC_SECRET configured: every code is invalid, 503, fails closed', async () => {
    const res = await call(unlockValidateHandler, validateRequest({ clientCode: 'ABCDEF', unlockCode: 'ABCDEF' }), {})
    expect(res.status).toBe(503)
    expect((await res.json()).valid).toBeUndefined()
  })

  test('a non-JSON content-type is refused with 415', async () => {
    const res = await call(
      unlockValidateHandler,
      new Request(`${ORIGIN}/api/unlock-validate`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' }),
      { UNLOCK_HMAC_SECRET: SECRET },
    )
    expect(res.status).toBe(415)
  })

  test('method not allowed on anything but POST', async () => {
    const res = await call(unlockValidateHandler, new Request(`${ORIGIN}/api/unlock-validate`), { UNLOCK_HMAC_SECRET: SECRET })
    expect(res.status).toBe(405)
  })

  test('responses are never cached or sniffed', async () => {
    const res = await call(
      unlockValidateHandler,
      validateRequest({ clientCode: 'ABCDEF', unlockCode: 'ZZZZZZ' }),
      { UNLOCK_HMAC_SECRET: SECRET },
    )
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })
})
