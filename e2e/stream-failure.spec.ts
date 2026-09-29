import { test, expect } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'
import { installUpstashMock } from './support/upstashMock'

/**
 * A channel is hidden or skipped only when the user turned that setting on, and
 * a failure caused by the user's own network never changes what is shown.
 *
 * These drive the real player against a mocked catalogue: `ch1.xx` has a single
 * stream at https://streams.invalid/ch1.xx-0.m3u8, and each test decides how
 * that URL (and the edge proxy in front of it) fails.
 */

const CHANNEL = 'ch1.xx'
const CHANNEL_NAME = 'Channel 1'
const STREAM = /^https:\/\/streams\.invalid\//
const PROBE = /\/favicon\.svg\?probe=/
const BROKEN_KEY = 'sl_broken_streams_v2'

const ORIGIN_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
}

async function openHome(page: Page, context: BrowserContext) {
  await installUpstashMock(context, { totalChannels: 20, guideChannels: 10 })
  await page.goto('/')
  await expect(page.getByRole('button', { name: `Play ${CHANNEL_NAME}`, exact: true }).first()).toBeVisible({
    timeout: 60_000,
  })
}

/** Client-side navigation, so an offline browser needs no document request. */
async function go(page: Page, path: string) {
  await page.evaluate((to) => {
    history.pushState({}, '', to)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, path)
}

async function brokenIds(page: Page): Promise<string[]> {
  return page.evaluate(
    (key) => Object.keys(JSON.parse(localStorage.getItem(key) ?? '{}')),
    BROKEN_KEY,
  )
}

async function waitForFailureScreen(page: Page) {
  await expect(page.getByText('Stream Unavailable')).toBeVisible({ timeout: 60_000 })
}

test.describe('failed play never hides a channel by itself', () => {
  test('an offline play failure records nothing and the channel stays listed', async ({ page, context }) => {
    await openHome(page, context)

    // Watch is a lazy route: fetch it while still online so offline needs no download.
    await page.evaluate(`import('/src/pages/Watch.tsx')`)
    await context.setOffline(true)
    await page.route(STREAM, (route) => route.abort('internetdisconnected'))
    await page.route(/\/api\/proxy/, (route) => route.abort('internetdisconnected'))
    await go(page, `/watch/${CHANNEL}`)

    await waitForFailureScreen(page)
    await expect(page.getByText(/connection appears to be down/i)).toBeVisible({ timeout: 10_000 })
    expect(await brokenIds(page)).toEqual([])

    await context.setOffline(false)
    await go(page, '/')
    await expect(page.getByRole('button', { name: `Play ${CHANNEL_NAME}`, exact: true }).first()).toBeVisible()
  })

  test('coming back online resumes a stream that was waiting on the network, without a click', async ({ page, context }) => {
    await openHome(page, context)

    await page.evaluate(`import('/src/pages/Watch.tsx')`)
    await context.setOffline(true)
    await page.route(STREAM, (route) => route.abort('internetdisconnected'))
    await page.route(/\/api\/proxy/, (route) => route.abort('internetdisconnected'))
    await go(page, `/watch/${CHANNEL}`)
    await waitForFailureScreen(page)
    await expect(page.getByText(/connection appears to be down/i)).toBeVisible({ timeout: 10_000 })

    let requestedAfterReconnect = false
    await context.setOffline(false)
    await page.unroute(STREAM)
    await page.route(STREAM, (route) => {
      requestedAfterReconnect = true
      return route.fulfill({ status: 404, headers: ORIGIN_CORS, body: 'gone' })
    })
    await expect.poll(() => requestedAfterReconnect, { timeout: 15_000 }).toBe(true)
  })

  test('a valid playlist served as text/html is still played', async ({ page, context }) => {
    await openHome(page, context)

    let segmentRequested = false
    await page.route(STREAM, (route) => {
      const url = route.request().url()
      if (url.includes('seg0')) {
        segmentRequested = true
        return route.fulfill({ status: 404, headers: ORIGIN_CORS, body: 'x' })
      }
      return route.fulfill({
        status: 200,
        headers: { ...ORIGIN_CORS, 'content-type': 'text/html' },
        body: '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:4,\nhttps://streams.invalid/seg0.ts\n',
      })
    })
    await go(page, `/watch/${CHANNEL}`)
    await expect.poll(() => segmentRequested, { timeout: 15_000 }).toBe(true)
  })

  test('a failed play while the connectivity probe fails records nothing', async ({ page, context }) => {
    await openHome(page, context)

    // Browser says online, but nothing reaches the network: the origin 404 below
    // cannot be told apart from the user's connection dropping mid-play.
    await page.route(PROBE, (route) => route.abort('connectionreset'))
    await page.route(STREAM, (route) => route.fulfill({ status: 404, headers: ORIGIN_CORS, body: 'gone' }))
    await page.route(/\/api\/proxy/, (route) => route.fulfill({ status: 404, body: 'gone' }))
    await go(page, `/watch/${CHANNEL}`)

    await waitForFailureScreen(page)
    await expect(page.getByText(/connection appears to be down/i)).toBeVisible({ timeout: 10_000 })
    expect(await brokenIds(page)).toEqual([])
  })

  test('a stream that only times out records nothing', async ({ page, context }) => {
    await openHome(page, context)

    // Never answered: a dead origin and a slow link look the same from here.
    await page.route(STREAM, () => {})
    await page.route(/\/api\/proxy/, () => {})
    await go(page, `/watch/${CHANNEL}`)

    await waitForFailureScreen(page)
    expect(await brokenIds(page)).toEqual([])
  })

  test('an origin 404 records a mark, and the channel is hidden only while hide-broken is on', async ({
    page,
    context,
  }) => {
    await openHome(page, context)

    await page.route(STREAM, (route) => route.fulfill({ status: 404, headers: ORIGIN_CORS, body: 'gone' }))
    await page.route(/\/api\/proxy/, (route) => route.fulfill({ status: 404, body: 'gone' }))
    await go(page, `/watch/${CHANNEL}`)

    await waitForFailureScreen(page)
    await expect.poll(() => brokenIds(page), { timeout: 15_000 }).toEqual([CHANNEL])

    // Default profile: the setting is off, so the flagged channel is still listed.
    await go(page, '/')
    await expect(page.getByRole('button', { name: `Play ${CHANNEL_NAME}`, exact: true }).first()).toBeVisible()

    // Turning it on hides it; turning it off lists it again.
    await page.evaluate(() => localStorage.setItem('sl_hide_broken', 'true'))
    await page.reload()
    await expect(page.getByRole('button', { name: 'Play Channel 0', exact: true }).first()).toBeVisible({ timeout: 60_000 })
    await expect(page.getByRole('button', { name: `Play ${CHANNEL_NAME}`, exact: true })).toHaveCount(0)

    await page.evaluate(() => localStorage.setItem('sl_hide_broken', 'false'))
    await page.reload()
    await expect(page.getByRole('button', { name: `Play ${CHANNEL_NAME}`, exact: true }).first()).toBeVisible({
      timeout: 60_000,
    })
  })
})

test.describe('hiding a channel voluntarily', () => {
  test('hides from every list regardless of hide-broken, survives reload, and can be restored', async ({
    page,
    context,
  }) => {
    await openHome(page, context)

    // A stream that hangs, which failure classification deliberately never marks.
    await page.route(STREAM, () => {})
    await page.route(/\/api\/proxy/, () => {})
    await go(page, `/watch/${CHANNEL}`)
    await waitForFailureScreen(page)
    expect(await brokenIds(page)).toEqual([])

    await page.getByRole('button', { name: 'Hide this channel' }).first().click()
    await expect(page).toHaveURL(/\/watch\/(?!ch1\.xx)/)

    // hide-broken is at its default (off): the hide is the user's, so it still applies.
    expect(await page.evaluate(() => localStorage.getItem('sl_hide_broken'))).toBeNull()
    await go(page, '/')
    await expect(page.getByRole('button', { name: 'Play Channel 0', exact: true }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: `Play ${CHANNEL_NAME}`, exact: true })).toHaveCount(0)

    await page.reload()
    await expect(page.getByRole('button', { name: 'Play Channel 0', exact: true }).first()).toBeVisible({
      timeout: 60_000,
    })
    await expect(page.getByRole('button', { name: `Play ${CHANNEL_NAME}`, exact: true })).toHaveCount(0)

    // Listed by name in Settings, where it can be restored.
    await go(page, '/settings')
    const hidden = page.locator('.settings-hidden-list__item', { hasText: CHANNEL_NAME })
    await expect(hidden).toBeVisible()
    await page.getByRole('button', { name: `Restore ${CHANNEL_NAME}` }).click()
    await expect(hidden).toHaveCount(0)

    await go(page, '/')
    await expect(page.getByRole('button', { name: `Play ${CHANNEL_NAME}`, exact: true }).first()).toBeVisible()
  })

  test('a hidden channel is loaded from storage and cleared only by Restore All', async ({ page, context }) => {
    await installUpstashMock(context, { totalChannels: 20, guideChannels: 10 })
    await page.addInitScript(() => {
      if (sessionStorage.getItem('seeded')) return
      sessionStorage.setItem('seeded', '1')
      localStorage.setItem('sl_hidden_channels_v1', JSON.stringify(['ch1.xx']))
    })
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Play Channel 0', exact: true }).first()).toBeVisible({
      timeout: 60_000,
    })
    await expect(page.getByRole('button', { name: `Play ${CHANNEL_NAME}`, exact: true })).toHaveCount(0)

    await go(page, '/settings')
    await expect(page.getByRole('button', { name: `Restore ${CHANNEL_NAME}` })).toBeVisible()
    await page.getByRole('button', { name: 'Restore All' }).click()
    await expect(page.locator('.settings-hidden-list__item')).toHaveCount(0)
    expect(await page.evaluate(() => localStorage.getItem('sl_hidden_channels_v1'))).toBe('[]')
  })
})

test.describe('hidden channels across tabs', () => {
  test('a hide made in one tab is merged, not overwritten, by a hide in another', async ({ context }) => {
    await installUpstashMock(context, { totalChannels: 20, guideChannels: 10 })
    const tabA = await context.newPage()
    const tabB = await context.newPage()
    await tabA.goto('/')
    await tabB.goto('/')
    const hide = (id: string) => `import('/src/util/stream.ts').then((m) => m.hideChannel('${id}'))`

    // Tab B has read the (empty) list before tab A writes, so its cache is stale.
    await tabB.evaluate(`import('/src/util/stream.ts').then((m) => m.getHiddenSet().size)`)
    await tabA.evaluate(hide('ch1.xx'))
    await tabB.evaluate(hide('ch2.xx'))

    const stored = await tabA.evaluate(() => JSON.parse(localStorage.getItem('sl_hidden_channels_v1') ?? '[]'))
    expect([...stored].sort()).toEqual(['ch1.xx', 'ch2.xx'])
  })
})

test.describe('defaults and migration', () => {
  test('a fresh profile has hide-broken and auto-skip off', async ({ page, context }) => {
    await installUpstashMock(context, { totalChannels: 20, guideChannels: 10 })
    await page.goto('/settings')

    const hide = page.locator('.settings-item', { hasText: 'Hide Failed Channels' }).locator('input')
    const skip = page.locator('.settings-item', { hasText: 'Auto-Skip Unavailable Channels' }).locator('input')
    await expect(hide).not.toBeChecked()
    await expect(skip).not.toBeChecked()

    // An explicit choice still wins.
    await page.locator('.settings-item', { hasText: 'Hide Failed Channels' }).locator('.toggle-slider').click()
    await page.reload()
    await expect(hide).toBeChecked()
  })

  test('marks from before failures were classified are cleared once', async ({ page, context }) => {
    await installUpstashMock(context, { totalChannels: 20, guideChannels: 10 })
    // Seed a legacy mark on the first document only, so the reload below is not re-seeded.
    await page.addInitScript((key) => {
      if (sessionStorage.getItem('seeded')) return
      sessionStorage.setItem('seeded', '1')
      localStorage.setItem(key, JSON.stringify({ 'ch1.xx': { timestamp: Date.now() } }))
    }, BROKEN_KEY)

    await page.goto('/')
    expect(await brokenIds(page)).toEqual([])
    expect(await page.evaluate(() => localStorage.getItem('sl_broken_reset_v1'))).toBe('1')

    // A mark written after the reset survives later loads: the purge ran only once.
    await page.evaluate(
      (key) => localStorage.setItem(key, JSON.stringify({ 'ch1.xx': { timestamp: Date.now() } })),
      BROKEN_KEY,
    )
    await page.reload()
    expect(await brokenIds(page)).toEqual(['ch1.xx'])
  })
})

test.describe('failure classification', () => {
  test('separates stream faults from network faults and timeouts', async ({ page, context }) => {
    await installUpstashMock(context, { totalChannels: 20, guideChannels: 10 })
    await page.goto('/')

    const result = await page.evaluate(`import('/src/util/streamFailure.ts').then((m) => ({
      notFound: m.classifyHlsError({ details: 'manifestLoadError', response: { code: 404 } }),
      serverError: m.classifyHlsError({ details: 'fragLoadError', response: { code: 502 } }),
      throttled: m.classifyHlsError({ details: 'manifestLoadError', response: { code: 429 } }),
      proxyUnreachable: m.classifyHlsError({ details: 'manifestLoadError', response: { code: 523 } }),
      noResponse: m.classifyHlsError({ details: 'manifestLoadError', response: { code: 0 } }),
      noResponseAtAll: m.classifyHlsError({ details: 'levelLoadError' }),
      timeout: m.classifyHlsError({ details: 'manifestLoadTimeOut' }),
      parse: m.classifyHlsError({ details: 'manifestParsingError' }),
      codec: m.classifyHlsError({ details: 'bufferAddCodecError' }),
      unknown: m.classifyHlsError({ details: 'somethingNew' }),
      nativeNetwork: m.classifyMediaElementError(2),
      nativeDecode: m.classifyMediaElementError(3),
      nativeUnsupported: m.classifyMediaElementError(4),
      nativeAborted: m.classifyMediaElementError(1),
      allStream: m.isStreamSpecificFailure(new Map([[0, 'stream'], [1, 'stream']]), 2),
      oneTimeout: m.isStreamSpecificFailure(new Map([[0, 'stream'], [1, 'inconclusive']]), 2),
      oneUntried: m.isStreamSpecificFailure(new Map([[0, 'stream']]), 2),
      noCandidates: m.isStreamSpecificFailure(new Map(), 0),
    }))`)

    expect(result).toEqual({
      notFound: 'stream',
      serverError: 'stream',
      throttled: 'inconclusive',
      proxyUnreachable: 'inconclusive',
      noResponse: 'network',
      noResponseAtAll: 'network',
      timeout: 'inconclusive',
      parse: 'stream',
      codec: 'stream',
      unknown: 'inconclusive',
      nativeNetwork: 'network',
      nativeDecode: 'stream',
      nativeUnsupported: 'stream',
      nativeAborted: 'inconclusive',
      allStream: true,
      oneTimeout: false,
      oneUntried: false,
      noCandidates: false,
    })
  })
})
