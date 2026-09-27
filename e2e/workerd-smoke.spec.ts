import { test, expect } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDispatchMock, DISPATCH_MOCK_URL } from './support/dispatchMock'
import { killLoggedProcess, spawnLogged, wait, waitUntilReady, type LoggedProcess } from './support/wranglerDev'

/**
 * `picks-endpoint.spec.ts` calls the Function handler directly in Node with a stubbed
 * `globalThis.fetch` and a synthetic `waitUntil` that just collects promises into an array
 * the test harness fully awaits before returning. That stub is exactly what let the
 * picks-portal 503 bug ship (a real `redirect: 'error'`/`'manual'` divergence between
 * Node's `fetch` and workerd's) — this spawns `wrangler pages dev` against an isolated
 * fixture (`e2e/support/workerd-smoke/`, never deployed — see that directory's own
 * comment) with `dispatchFastTrack` pointed at a local stub instead of the real GitHub API
 * (`FAST_TRACK_DISPATCH_URL_OVERRIDE`), and proves the request GitHub actually receives
 * — URL, method, headers, JSON body — is correct under a real workerd `fetch`, closing
 * that specific class of gap.
 *
 * What this does NOT prove, confirmed empirically while writing it (see
 * `e2e/support/workerd-smoke/functions/api/smoke.ts`'s own comment): whether omitting
 * `context.waitUntil` entirely would be caught. It would not — local `wrangler pages dev`
 * keeps its whole process alive across a request rather than tearing an isolate down once
 * its response is sent, so a stray un-awaited promise still runs to completion locally
 * regardless of whether `waitUntil` wrapped it. That specific failure mode needs a real
 * deployed environment to reproduce, which is why the 2026-09-22 incident needed live
 * production tailing to find, not a local test run. What this test suite *can* and does
 * verify locally: the response never blocks on the dispatch completing (a real, observable
 * ordering property, not a proxy for the teardown question) — see the second test below.
 */

const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url)) + '/support/workerd-smoke'
const WRANGLER_PORT = 5200
const WRANGLER_URL = `http://127.0.0.1:${WRANGLER_PORT}`
const WRANGLER_URL_T = `http://127.0.0.1:${WRANGLER_PORT + 1}`
const READY_TIMEOUT_MS = 60_000
const DISPATCH_TIMEOUT_MS = 10_000

async function waitForDispatch(dispatchMock: ReturnType<typeof createDispatchMock>, wrangler: LoggedProcess | null) {
  const deadline = Date.now() + DISPATCH_TIMEOUT_MS
  while (dispatchMock.requests.length === 0 && Date.now() < deadline) {
    await wait(100)
  }
  if (dispatchMock.requests.length === 0) {
    throw new Error(`dispatch never reached the mock within ${DISPATCH_TIMEOUT_MS}ms.\nwrangler output:\n${wrangler?.log() ?? ''}`)
  }
}

test.describe('POST /api/t under real workerd (WO-22)', () => {
  // Shares the fixture server below (fixed port), so it runs in the same worker, serially.
  test.describe.configure({ mode: 'default' })

  let wrangler: LoggedProcess | null = null

  test.beforeAll(async () => {
    wrangler = spawnLogged('npx', [
      'wrangler', 'pages', 'dev', '--cwd', FIXTURE_DIR, '--ip', '127.0.0.1', '--port', String(WRANGLER_PORT + 1),
      '--inspector-port', '9231',
    ])
    await waitUntilReady(`${WRANGLER_URL_T}/`, READY_TIMEOUT_MS)
  })

  test.afterAll(() => killLoggedProcess(wrangler))

  const post = (body: string | null, headers: Record<string, string> = {}, method = 'POST') =>
    fetch(`${WRANGLER_URL_T}/api/t`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === null ? {} : { body }),
    })

  test('Sec-GPC: 1 and DNT: 1 answer 204 with nothing else', async () => {
    for (const header of ['sec-gpc', 'dnt']) {
      const res = await post(JSON.stringify({ v: 1, p: 'web', a: '1.0', b: [{ e: 'guide_open' }] }), { [header]: '1' })
      expect(res.status, wrangler?.log()).toBe(204)
      expect(await res.text()).toBe('')
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    }
  })

  test('an accepted batch writes through the real Analytics Engine binding and answers 202', async () => {
    const res = await post(JSON.stringify({ v: 1, p: 'web', a: '1.0', b: [{ e: 'guide_open' }, { e: 'search', z: 1 }] }))
    expect(res.status, wrangler?.log()).toBe(202)
    expect(res.headers.get('x-telemetry-dropped')).toBe('0')
    expect(await res.text()).toBe('')
  })

  test('a channel id the (empty) local catalogue bucket does not list is dropped, not refused', async () => {
    const res = await post(JSON.stringify({ v: 1, p: 'web', a: '1.0', b: [{ e: 'play', c: 'Nobody.zz', s: '0123456789abcdef' }, { e: 'guide_open' }] }))
    expect(res.status, wrangler?.log()).toBe(202)
    expect(res.headers.get('x-telemetry-dropped')).toBe('1')
  })

  test('a malformed or over-size batch is refused with validateBatch\'s reason', async () => {
    const bad = await post('{"v":1,')
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'refused', reason: 'not JSON' })
    const clock = await post(JSON.stringify({ v: 1, p: 'web', a: '1.0', b: [{ e: 'guide_open', t: 1 }] }))
    expect(clock.status).toBe(400)
    expect(await clock.json()).toEqual({ error: 'refused', reason: 'guide_open does not carry "t"' })
    const big = await post(JSON.stringify({ v: 1, p: 'web', a: '1.0', b: Array.from({ length: 20 }, () => ({ e: 'guide_open' })) }) + ' '.repeat(3000))
    expect(big.status).toBe(400)
    expect(await big.json()).toEqual({ error: 'refused', reason: 'over 2048 bytes' })
    const preflight = await post(null, {}, 'OPTIONS')
    expect(preflight.status).toBe(405)
  })
})

test.describe('fast-track dispatch under real workerd (regression: 2026-09-22 silent-dispatch incident)', () => {
  // One worker for the whole group: it shares one server on a fixed port.
  test.describe.configure({ mode: 'default' })

  let wrangler: LoggedProcess | null = null
  const dispatchMock = createDispatchMock()

  test.beforeAll(async () => {
    await dispatchMock.listen()
    wrangler = spawnLogged('npx', [
      'wrangler',
      'pages',
      'dev',
      'public',
      '--cwd',
      FIXTURE_DIR,
      '--ip',
      '127.0.0.1',
      '--port',
      String(WRANGLER_PORT),
      '--inspector-port',
      '9230',
      '-b',
      'GITHUB_DISPATCH_TOKEN=smoke-test-token',
      '-b',
      `FAST_TRACK_DISPATCH_URL_OVERRIDE=${DISPATCH_MOCK_URL}`,
    ])
    await waitUntilReady(WRANGLER_URL, READY_TIMEOUT_MS)
  })

  test.afterAll(async () => {
    killLoggedProcess(wrangler)
    await dispatchMock.close()
  })

  test.beforeEach(() => {
    dispatchMock.requests.length = 0
    dispatchMock.delayMs = 0
  })

  test('the request GitHub actually receives is correct under real workerd', async () => {
    const res = await fetch(`${WRANGLER_URL}/api/smoke`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')

    await waitForDispatch(dispatchMock, wrangler)

    expect(dispatchMock.requests.length).toBe(1)
    expect(dispatchMock.requests[0].body).toEqual({
      event_type: 'fast-track-pick',
      client_payload: { channelIds: ['SmokeTestChannel.zz'] },
    })
    expect(dispatchMock.requests[0].headers.authorization).toBe('Bearer smoke-test-token')
    expect(dispatchMock.requests[0].headers.accept).toBe('application/vnd.github+json')
    expect(dispatchMock.requests[0].headers['content-type']).toBe('application/json')
  })

  test("the response does not wait for the dispatch to finish, even when the dispatch is slow", async () => {
    // A real, locally-observable ordering property (unlike the isolate-teardown question
    // this suite's own top comment explains it cannot test): if handleWrite's response
    // waited on dispatchFastTrack's fetch, a slow dispatch target would slow the response
    // by the same amount. It must not.
    dispatchMock.delayMs = 3_000
    const start = Date.now()
    const res = await fetch(`${WRANGLER_URL}/api/smoke`, { method: 'POST' })
    const responseMs = Date.now() - start
    expect(res.status).toBe(200)
    expect(responseMs).toBeLessThan(dispatchMock.delayMs / 2)

    // The slow dispatch is still in flight (or just landing) — prove it happens too, just
    // not before the response above.
    await waitForDispatch(dispatchMock, wrangler)
    expect(dispatchMock.requests.length).toBe(1)
  })
})
