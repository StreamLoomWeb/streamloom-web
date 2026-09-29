import { test, expect } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'
import fs from 'node:fs'
import { installUpstashMock } from './support/upstashMock'
import { isMseDecodeFailure } from '../src/util/nativeHls'

/**
 * Safari's native HLS engine as the fallback for a stream its MSE decoder rejects.
 *
 * Production case: raw-IP "Astra" restreams (MNX, Disney International HD, Colors Cineplex
 * Bollywood) carry field-coded interlaced H.264 + MPEG-1 Layer II audio. Chrome plays them
 * through hls.js; WebKit's MSE fails the first fragment with "Media failed to decode" while
 * Safari's native engine plays the same URL. No encoder available here writes field-coded
 * H.264, so the decode failure is reproduced by corrupting the video payload on its way into
 * MSE only (the native engine never goes through MediaSource and gets the clean bytes).
 *
 * The WebKit project runs this file only; the Chromium project runs the non-Apple case.
 */

const FIXTURE_DIR = new URL('./fixtures/hls-testsrc/', import.meta.url)
const STREAM = 'https://streams.invalid/ch1.xx-0.m3u8'
const SECOND_CANDIDATE = 'https://streams.invalid/ch1.xx-1.m3u8'

/** Zeroes (0x21) the mdat payload of every video append, so the decoder rejects it. */
const CORRUPT_VIDEO_MSE = () => {
  const add = MediaSource.prototype.addSourceBuffer
  const isVideo = new WeakSet<SourceBuffer>()
  MediaSource.prototype.addSourceBuffer = function (type: string) {
    const sb = add.call(this, type)
    if (type.startsWith('video')) isVideo.add(sb)
    return sb
  }
  const append = SourceBuffer.prototype.appendBuffer
  SourceBuffer.prototype.appendBuffer = function (data: BufferSource) {
    if (!isVideo.has(this)) return append.call(this, data)
    const src = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    const c = new Uint8Array(src)
    let i = 0
    while (i + 8 <= c.length) {
      const size = ((c[i] << 24) | (c[i + 1] << 16) | (c[i + 2] << 8) | c[i + 3]) >>> 0
      const box = String.fromCharCode(c[i + 4], c[i + 5], c[i + 6], c[i + 7])
      if (box === 'mdat') for (let j = i + 8; j < Math.min(i + size, c.length); j++) c[j] = 0x21
      if (size < 8) break
      i += size
    }
    return append.call(this, c)
  }
}

async function serveFixture(context: BrowserContext, requested: string[]) {
  await context.route('https://streams.invalid/**', (route) => {
    const url = route.request().url()
    requested.push(url)
    const name = new URL(url).pathname.split('/').pop() ?? ''
    const file = name.endsWith('.m3u8') ? 'i.m3u8' : name
    if (!/^i\d?\.(m3u8|mpegts)$/.test(file) || url === SECOND_CANDIDATE) {
      return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: 'no' })
    }
    return route.fulfill({
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'content-type': file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
      },
      body: fs.readFileSync(new URL(file, FIXTURE_DIR)),
    })
  })
}

async function openChannel(page: Page, context: BrowserContext) {
  await installUpstashMock(context, { totalChannels: 20, guideChannels: 10 })
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Play Channel 1', exact: true }).first()).toBeVisible({
    timeout: 60_000,
  })
  await page.evaluate(() => {
    history.pushState({}, '', '/watch/ch1.xx')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
}

const videoState = (page: Page) =>
  page.evaluate(() => {
    const v = document.querySelector('video')
    return { src: v?.currentSrc ?? '', readyState: v?.readyState ?? 0 }
  })

test('decode-failure classification', () => {
  expect(isMseDecodeFailure('mediaSourceRequiresReset', undefined)).toBe(true)
  expect(isMseDecodeFailure('bufferAppendError', 3)).toBe(true)
  expect(isMseDecodeFailure('bufferStalledError', undefined)).toBe(false)
  expect(isMseDecodeFailure('fragParsingError', 4)).toBe(false)
})

test('Safari: a stream its MSE decoder rejects reopens in the native engine and plays', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'webkit', 'Apple WebKit only')
  const requested: string[] = []
  await context.addInitScript(CORRUPT_VIDEO_MSE)
  await serveFixture(context, requested)
  await openChannel(page, context)

  // Native engine: the element's own src is the stream URL, not an hls.js blob.
  await expect.poll(async () => (await videoState(page)).src, { timeout: 20_000 }).toBe(STREAM)
  await expect.poll(async () => (await videoState(page)).readyState, { timeout: 20_000 }).toBeGreaterThanOrEqual(2)
  await expect(page.locator('.player__state-overlay--error')).toHaveCount(0)
  // The candidate that plays is kept: no failover to the second one, no proxy retry.
  expect(requested).not.toContain(SECOND_CANDIDATE)
  await page.waitForTimeout(3000)
  expect((await videoState(page)).src).toBe(STREAM)
  expect(requested).not.toContain(SECOND_CANDIDATE)
})

test('Safari: a stream MSE decodes stays on hls.js', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'webkit', 'Apple WebKit only')
  const requested: string[] = []
  await serveFixture(context, requested)
  await openChannel(page, context)
  await expect.poll(async () => (await videoState(page)).readyState, { timeout: 20_000 }).toBeGreaterThanOrEqual(2)
  await page.waitForTimeout(2000)
  expect((await videoState(page)).src).toMatch(/^blob:/)
})

test('non-Apple browsers never switch engines, even where native HLS exists', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium only')
  const requested: string[] = []
  await context.addInitScript(() => {
    // Recent Chrome answers canPlayType for HLS; the fallback must stay Apple-only.
    const orig = HTMLMediaElement.prototype.canPlayType
    HTMLMediaElement.prototype.canPlayType = function (t: string) {
      return /mpegurl/i.test(t) ? 'maybe' : orig.call(this, t)
    }
  })
  await context.addInitScript(CORRUPT_VIDEO_MSE)
  await serveFixture(context, requested)
  await openChannel(page, context)
  await expect.poll(() => requested.some((u) => u.endsWith('/i0.mpegts')), { timeout: 20_000 }).toBe(true)
  await page.waitForTimeout(4000)
  expect((await videoState(page)).src).not.toBe(STREAM)
})
