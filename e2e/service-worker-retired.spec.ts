import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { killLoggedProcess, spawnLogged, waitUntilReady, type LoggedProcess } from './support/wranglerDev'

/**
 * The site has no service worker (ADR-0045), and `public/sw.js` retires the one earlier
 * builds installed. That worker answered every navigation from its own cache, so a new
 * deploy showed one visit late, and `/admin` never reached Cloudflare Access (the
 * 2026-09-23 incident). These specs build the real bundle and serve it with
 * `wrangler pages dev`, which honours `public/_headers` and `public/_redirects` as
 * deployed; plain `vite` dev would not.
 */

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WRANGLER_PORT = 5201
const WRANGLER_URL = `http://127.0.0.1:${WRANGLER_PORT}`
const READY_TIMEOUT_MS = 60_000
const BUILD_TIMEOUT_MS = 120_000

/** The real production bundle, deliberately: `dist/` is what ships. */
function buildApp(): Promise<void> {
  return new Promise((resolve, reject) => {
    const build = spawn('npx', ['vite', 'build'], { cwd: PROJECT_ROOT, stdio: 'pipe' })
    let log = ''
    build.stdout?.on('data', (d) => (log += String(d)))
    build.stderr?.on('data', (d) => (log += String(d)))
    const timer = setTimeout(() => {
      build.kill()
      reject(new Error(`vite build did not finish within ${BUILD_TIMEOUT_MS}ms.\n${log}`))
    }, BUILD_TIMEOUT_MS)
    build.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`vite build exited with code ${code}.\n${log}`))
    })
  })
}

test.describe('the retired service worker', () => {
  // One worker for the whole group: it shares one server on a fixed port.
  test.describe.configure({ mode: 'default' })

  let wrangler: LoggedProcess | null = null

  test.beforeAll(async () => {
    // The build and the server have their own budgets; the hook must outlast both.
    test.setTimeout(BUILD_TIMEOUT_MS + READY_TIMEOUT_MS + 30_000)
    await buildApp()
    wrangler = spawnLogged(
      'npx',
      ['wrangler', 'pages', 'dev', 'dist', '--ip', '127.0.0.1', '--port', String(WRANGLER_PORT), '--inspector-port', '9231'],
      { cwd: PROJECT_ROOT },
    )
    await waitUntilReady(`${WRANGLER_URL}/`, READY_TIMEOUT_MS)
  })

  test.afterAll(() => {
    killLoggedProcess(wrangler)
  })

  test('a visit registers no service worker, so every navigation reaches the network', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: WRANGLER_URL })
    const page = await context.newPage()
    try {
      await page.goto('/')
      await page.waitForLoadState('load')
      expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0)
      const res = await page.goto('/admin')
      expect(res!.fromServiceWorker()).toBe(false)
    } finally {
      await context.close()
    }
  })

  test('an old worker still registered at /sw.js empties its caches, unregisters and reloads the tab', async ({
    browser,
  }) => {
    const context = await browser.newContext({ baseURL: WRANGLER_URL })
    const page = await context.newPage()
    try {
      // Stand in for a returning browser: the old build's worker, which cached and
      // claimed every tab, and a Workbox cache it left behind.
      await context.route('**/sw.js', (route) =>
        route.fulfill({
          contentType: 'text/javascript',
          body: `self.addEventListener('install', () => self.skipWaiting())
            self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
            self.addEventListener('fetch', () => {})`,
        }),
      )
      await page.goto('/')
      await page.evaluate(async () => {
        await (await caches.open('workbox-precache-v2-stale')).put('/stale', new Response('old build'))
        await navigator.serviceWorker.register('/sw.js', { scope: '/' })
        await navigator.serviceWorker.ready
        if (!navigator.serviceWorker.controller) {
          await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }))
        }
      })
      // The deploy: the next update check fetches today's `/sw.js`, whose activate step
      // navigates this tab to the same URL.
      await context.unroute('**/sw.js')
      const reloaded = page.waitForEvent('framenavigated', { timeout: 15_000 })
      // Not awaited in the page: the reload it triggers would destroy this evaluate's context.
      await page.evaluate(() => {
        void navigator.serviceWorker.getRegistration().then((registration) => registration?.update())
      })
      await reloaded
      await page.waitForLoadState('load')
      await expect
        .poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length))
        .toBe(0)
      expect(await page.evaluate(() => caches.keys())).toEqual([])
      expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull()
    } finally {
      await context.close()
    }
  })

  test('/admin is a real 200, not a redirect (guards the original Safari deep-link fix)', async ({
    browser,
  }) => {
    const context = await browser.newContext({ baseURL: WRANGLER_URL })
    const page = await context.newPage()
    try {
      const res = await page.goto('/admin')
      expect(res).not.toBeNull()
      expect(res!.status()).toBe(200)
      expect(res!.request().redirectedFrom()).toBeNull()
    } finally {
      await context.close()
    }
  })
})
