import { test, expect } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'
import fs from 'node:fs'
import { installUpstashMock } from './support/upstashMock'
import { classifyStreamUrl, xtreamHlsVariant } from '../src/util/streamKind'

/**
 * The engine ladder: the stream kind picks the engine, mpegts.js is fetched only for raw TS,
 * and a stream type no browser can open is skipped at once with a plain message.
 */

const TS_FIXTURE = fs.readFileSync(new URL('./fixtures/sample.mpegts', import.meta.url))
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }
const MPEGTS_CHUNK = /\/(node_modules|assets)\/[^?]*mpegts/i

async function openHome(page: Page, context: BrowserContext) {
  await installUpstashMock(context, { totalChannels: 20, guideChannels: 10, engineChannels: true })
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Play Channel 1', exact: true }).first()).toBeVisible({
    timeout: 60_000,
  })
}

async function go(page: Page, path: string) {
  await page.evaluate((to) => {
    history.pushState({}, '', to)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, path)
}

function track(page: Page) {
  const chunk: string[] = []
  const stream: string[] = []
  page.on('request', (r) => {
    const u = r.url()
    if (MPEGTS_CHUNK.test(u)) chunk.push(u)
    if (/streams\.invalid|\/api\/proxy/.test(u)) stream.push(u)
  })
  return { chunk, stream }
}

test('classifyStreamUrl and the Xtream twin', () => {
  expect(classifyStreamUrl('https://h/a/b.m3u8?x=1')).toBe('hls')
  expect(classifyStreamUrl('http://h/hls/abc')).toBe('hls')
  expect(classifyStreamUrl('http://h:8080/live/u/p/12.ts')).toBe('ts')
  expect(classifyStreamUrl('http://h:8080/live/u/p/12')).toBe('ts')
  expect(classifyStreamUrl('http://h:8080/stream')).toBe('unknown')
  expect(classifyStreamUrl('https://h/v.mp4')).toBe('mp4')
  expect(classifyStreamUrl('https://h/manifest.mpd')).toBe('dash')
  for (const s of ['rtmp', 'rtsp', 'udp', 'mms', 'rtp']) expect(classifyStreamUrl(`${s}://h/x`)).toBe('unsupported')
  expect(xtreamHlsVariant('http://h:8080/live/u/p/12.ts')).toBe('http://h:8080/live/u/p/12.m3u8')
  expect(xtreamHlsVariant('http://h:8080/live/u/p/12')).toBeNull()
  expect(xtreamHlsVariant('https://h/a.ts')).toBeNull()
})

test('the mpegts chunk is requested only when a TS channel is opened', async ({ page, context }) => {
  const t = track(page)
  await page.route(/streams\.invalid\/.*\.m3u8/, (r) => r.fulfill({ status: 404, headers: CORS, body: 'no' }))
  await openHome(page, context)
  await page.waitForTimeout(1500)
  expect(t.chunk).toEqual([])

  await go(page, '/watch/ch1.xx')
  await page.waitForTimeout(2500)
  expect(t.chunk).toEqual([])

  await page.route(/streams\.invalid\/ch3\.xx\.mpegts/, (r) =>
    r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'video/mp2t' }, body: TS_FIXTURE }),
  )
  await go(page, '/watch/ch3.xx')
  await expect.poll(() => t.chunk.length, { timeout: 20_000 }).toBeGreaterThan(0)
})

test('an rtmp-only or mpd-only channel shows the unsupported message at once, without stream requests', async ({ page, context }) => {
  const t = track(page)
  await openHome(page, context)
  for (const id of ['ch5.xx', 'ch4.xx']) {
    t.stream.length = 0
    const started = Date.now()
    await go(page, `/watch/${id}`)
    await expect(page.getByText(/can't play in a web browser/i)).toBeVisible({ timeout: 2000 })
    expect(Date.now() - started).toBeLessThan(2500)
    expect(t.stream).toEqual([])
    await go(page, '/')
  }
})

test('an Xtream .ts candidate tries its .m3u8 twin first', async ({ page, context }) => {
  const t = track(page)
  await page.route(/streams\.invalid|\/api\/proxy/, (r) => r.fulfill({ status: 404, headers: CORS, body: 'no' }))
  await openHome(page, context)
  t.stream.length = 0
  await go(page, '/watch/ch2.xx')
  await expect.poll(() => t.stream.length, { timeout: 20_000 }).toBeGreaterThan(0)
  const firstDirect = t.stream.find((u) => u.startsWith('https://streams.invalid/'))
  expect(firstDirect).toBe('https://streams.invalid/live/user/pass/2.m3u8')
})
