import { test, expect } from '@playwright/test'
import type { BrowserContext, Page, Request as PwRequest } from '@playwright/test'
import { installUpstashMock } from './support/upstashMock'
import { EVENT_FIELDS, STREAM_KEY_RE, validateBatch } from '../functions/api/_lib/telemetryContract'

/**
 * The web telemetry client, watched at the network (ADR-0032's gate):
 *
 *   - nothing it sends can name a person: every batch is exactly the contract's fields, there is
 *     no cookie, no query string, no client clock, and the only thing kept locally is the
 *     period-first marker;
 *   - the opt-out, once set, sends nothing at all — asserted on the wire, not on a toggle;
 *   - a browser signalling Global Privacy Control sends nothing either;
 *   - one `play_fail` per stream per session, however many times the same stream is retried;
 *   - `/admin/analytics` is unreadable to a browser that is not signed in through Access.
 */

const CHANNEL = 'ch1.xx'
const CHANNEL_NAME = 'Channel 1'
const STREAM = /^https:\/\/streams\.invalid\//
const ORIGIN_CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }

interface Captured {
  batches: unknown[]
  requests: PwRequest[]
}

/** Answers `/api/t` like the endpoint and records every batch the page sent. */
async function captureTelemetry(page: Page): Promise<Captured> {
  const captured: Captured = { batches: [], requests: [] }
  await page.route('**/api/t', async (route) => {
    const request = route.request()
    captured.requests.push(request)
    const body = request.postData()
    captured.batches.push(body ? JSON.parse(body) : null)
    await route.fulfill({ status: 202, body: '' })
  })
  return captured
}

async function openHome(page: Page, context: BrowserContext) {
  await installUpstashMock(context, { totalChannels: 20, guideChannels: 10 })
  await page.goto('/')
  await expect(page.getByRole('button', { name: `Play ${CHANNEL_NAME}`, exact: true }).first()).toBeVisible({ timeout: 60_000 })
}

/** Client-side navigation, the way the app itself moves between routes. */
async function go(page: Page, path: string) {
  await page.evaluate((to) => {
    history.pushState({}, '', to)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, path)
}

/** The client flushes on `pagehide`; dispatching it is what leaving the page does. */
async function flush(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
}

function events(captured: Captured): { e: string; [k: string]: unknown }[] {
  return captured.batches.flatMap((b) => ((b as { b?: { e: string }[] } | null)?.b ?? []))
}

test.describe('what leaves the browser', () => {
  test('a batch carries only the contract fields, no cookie, no query string, no identifier', async ({ page, context }) => {
    const captured = await captureTelemetry(page)
    await openHome(page, context)
    await flush(page)
    await expect.poll(() => captured.batches.length, { timeout: 15_000 }).toBeGreaterThan(0)

    for (const request of captured.requests) {
      expect(request.method()).toBe('POST')
      expect(new URL(request.url()).search).toBe('')
      const headers = await request.allHeaders()
      expect(headers.cookie).toBeUndefined()
      expect(headers.authorization).toBeUndefined()
    }
    for (const batch of captured.batches) {
      expect(Object.keys(batch as object).sort()).toEqual(['a', 'b', 'p', 'v'])
      // The endpoint's own validator accepts it whole: nothing unknown rides along.
      const verdict = validateBatch(batch)
      expect(verdict).toMatchObject({ ok: true, platform: 'web' })
      for (const event of (batch as { b: Record<string, unknown>[] }).b) {
        const spec = EVENT_FIELDS[event.e as string]
        const allowed = new Set(['e', ...spec.required, ...spec.optional])
        for (const key of Object.keys(event)) expect(allowed.has(key), `${event.e} carries ${key}`).toBe(true)
      }
    }
    const opens = events(captured).filter((e) => e.e === 'app_open')
    expect(opens).toHaveLength(1)
    expect(opens[0].f).toBe('dwmn')

    // Nothing stored that could be an identifier: only the period marker and app preferences.
    expect(await page.evaluate(() => document.cookie)).toBe('')
    const marker = await page.evaluate(() => JSON.parse(localStorage.getItem('sl_telemetry_marker_v1') ?? 'null'))
    expect(Object.keys(marker).sort()).toEqual(['day', 'month', 'week'])
    expect(marker.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const keys: string[] = await page.evaluate(() => Object.keys(localStorage))
    expect(keys.filter((k) => /telemetry/.test(k))).toEqual(['sl_telemetry_marker_v1'])
  })

  test('a second open the same day carries no flags', async ({ page, context }) => {
    const captured = await captureTelemetry(page)
    await openHome(page, context)
    await flush(page)
    await expect.poll(() => events(captured).filter((e) => e.e === 'app_open').length, { timeout: 15_000 }).toBe(1)
    await page.reload()
    await expect(page.getByRole('button', { name: `Play ${CHANNEL_NAME}`, exact: true }).first()).toBeVisible({ timeout: 60_000 })
    await flush(page)
    await expect.poll(() => events(captured).filter((e) => e.e === 'app_open').length, { timeout: 15_000 }).toBe(2)
    expect(events(captured).filter((e) => e.e === 'app_open').map((e) => e.f)).toEqual(['dwmn', ''])
  })

  test('a failed play sends play, one play_fail with a stream class, then play_end in bucket 0', async ({ page, context }) => {
    const captured = await captureTelemetry(page)
    await openHome(page, context)
    await page.route(STREAM, (route) => route.fulfill({ status: 404, headers: ORIGIN_CORS, body: 'gone' }))
    await page.route(/\/api\/proxy/, (route) => route.fulfill({ status: 404, body: 'gone' }))
    await go(page, `/watch/${CHANNEL}`)
    await expect(page.getByText('Stream Unavailable')).toBeVisible({ timeout: 60_000 })

    // Retry the same channel twice: the same streams fail again, and must not be counted again.
    for (let i = 0; i < 2; i += 1) {
      await page.getByRole('button', { name: /retry/i }).first().click()
      await expect(page.getByText('Stream Unavailable')).toBeVisible({ timeout: 60_000 })
    }

    await go(page, '/')
    await flush(page)
    await expect.poll(() => events(captured).filter((e) => e.e === 'play_end').length, { timeout: 15_000 }).toBeGreaterThan(0)

    const all = events(captured)
    const plays = all.filter((e) => e.e === 'play')
    const fails = all.filter((e) => e.e === 'play_fail')
    const ends = all.filter((e) => e.e === 'play_end')
    expect(plays.length).toBeGreaterThanOrEqual(1)
    expect(plays[0]).toMatchObject({ c: CHANNEL })
    expect(STREAM_KEY_RE.test(String(plays[0].s))).toBe(true)
    // ch1.xx has one candidate stream: exactly one play_fail, whatever the retries did.
    expect(fails).toHaveLength(1)
    expect(fails[0]).toMatchObject({ c: CHANNEL, k: 'http_4xx' })
    expect(fails[0].s).toBe(plays[0].s)
    expect(ends[ends.length - 1]).toMatchObject({ c: CHANNEL, d: 0 })
    // No event carries a URL, a query or a time.
    for (const event of all) {
      for (const value of Object.values(event)) expect(String(value)).not.toMatch(/https?:|streams\.invalid|\d{13}/)
    }
  })

  test('a play that only times out sends no play_fail', async ({ page, context }) => {
    const captured = await captureTelemetry(page)
    await openHome(page, context)
    await page.route(STREAM, () => {})
    await page.route(/\/api\/proxy/, () => {})
    await go(page, `/watch/${CHANNEL}`)
    await expect(page.getByText('Stream Unavailable')).toBeVisible({ timeout: 60_000 })
    await go(page, '/')
    await flush(page)
    await expect.poll(() => events(captured).filter((e) => e.e === 'play_end').length, { timeout: 15_000 }).toBeGreaterThan(0)
    expect(events(captured).filter((e) => e.e === 'play_fail')).toEqual([])
  })

  test('a settled search sends only whether it found nothing', async ({ page, context }) => {
    const captured = await captureTelemetry(page)
    await openHome(page, context)
    const box = page.getByRole('searchbox', { name: 'Search channels' })
    await box.fill('zzzz-nothing-here')
    await page.waitForTimeout(1200)
    await box.fill('Channel 1')
    await page.waitForTimeout(1200)
    await flush(page)
    await expect.poll(() => events(captured).filter((e) => e.e === 'search').length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
    const searches = events(captured).filter((e) => e.e === 'search')
    expect(searches.map((s) => Object.keys(s).sort())).toEqual(searches.map(() => ['e', 'z']))
    expect(searches.some((s) => s.z === 1)).toBe(true)
    expect(searches.some((s) => s.z === 0)).toBe(true)
    expect(JSON.stringify(captured.batches)).not.toContain('zzzz')
  })
})

test.describe('opting out', () => {
  test('the in-app opt-out, once set, sends nothing at all — on load, on play, on leaving', async ({ page, context }) => {
    const captured = await captureTelemetry(page)
    await context.addInitScript(() => localStorage.setItem('sl_telemetry_optout', 'true'))
    await openHome(page, context)
    await page.route(STREAM, (route) => route.fulfill({ status: 404, headers: ORIGIN_CORS, body: 'gone' }))
    await page.route(/\/api\/proxy/, (route) => route.fulfill({ status: 404, body: 'gone' }))
    await go(page, `/watch/${CHANNEL}`)
    await expect(page.getByText('Stream Unavailable')).toBeVisible({ timeout: 60_000 })
    await go(page, '/')
    await flush(page)
    await page.waitForTimeout(1500)
    expect(captured.requests).toHaveLength(0)
    expect(await page.evaluate(() => localStorage.getItem('sl_telemetry_marker_v1'))).toBeNull()
  })

  test('turning the switch off in Settings stops sending, and it stays off after a reload', async ({ page, context }) => {
    const captured = await captureTelemetry(page)
    await openHome(page, context)
    await go(page, '/settings')
    const toggle = page.getByRole('checkbox', { name: 'Share anonymous usage statistics' })
    await expect(toggle).toBeChecked()
    // The input is visually replaced by the slider; the label is what a person clicks.
    await toggle.locator('xpath=..').click()
    await expect(toggle).not.toBeChecked()
    await expect(page.getByTestId('privacy-card')).toContainText('What is never collected')
    await flush(page)
    await page.waitForTimeout(500)
    const before = captured.requests.length
    await page.reload()
    await expect(page.getByRole('checkbox', { name: 'Share anonymous usage statistics' })).not.toBeChecked()
    await flush(page)
    await page.waitForTimeout(1500)
    expect(captured.requests.length).toBe(before)
    expect(await page.evaluate(() => localStorage.getItem('sl_telemetry_optout'))).toBe('true')
  })

  test('a browser signalling Global Privacy Control sends nothing', async ({ page, context }) => {
    const captured = await captureTelemetry(page)
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true, configurable: true })
    })
    await openHome(page, context)
    await flush(page)
    await page.waitForTimeout(1500)
    expect(captured.requests).toHaveLength(0)
    expect(await page.evaluate(() => localStorage.getItem('sl_telemetry_marker_v1'))).toBeNull()
  })
})

test.describe('/admin/analytics is behind Access', () => {
  test('a browser that is not signed in sees only that it is not signed in', async ({ page, context }) => {
    await installUpstashMock(context, { totalChannels: 20, guideChannels: 10 })
    let asked = 0
    await page.route('**/api/stats', async (route) => {
      asked += 1
      await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'unauthorised' }) })
    })
    await page.goto('/admin/analytics')
    await expect(page.locator('body')).toContainText('not signed in through Cloudflare Access')
    // Dev-mode StrictMode runs the effect twice (the first fetch is aborted); what matters is
    // that the page asked the endpoint and rendered nothing else.
    expect(asked).toBeGreaterThanOrEqual(1)
    await expect(page.locator('.an-tile')).toHaveCount(0)
    expect(await page.locator('meta[name="robots"]').getAttribute('content')).toContain('noindex')
  })
})
