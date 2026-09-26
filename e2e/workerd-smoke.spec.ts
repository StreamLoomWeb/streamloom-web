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
