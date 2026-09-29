import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { installUpstashMock } from './support/upstashMock'
import { surpriseWeight } from '../src/util/surprise'

/** Phase 3 delight features: all local-only, none autoplay on Home. */

const STREAM = /^https:\/\/streams\.invalid\//

async function go(page: Page, path: string) {
  await page.evaluate((to) => {
    history.pushState({}, '', to)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, path)
}

async function boot(page: Page, context: Parameters<typeof installUpstashMock>[0], seed?: () => void) {
  await installUpstashMock(context, { totalChannels: 20, guideChannels: 10 })
  await page.route(STREAM, () => {})
  await page.route(/\/api\/proxy/, () => {})
  if (seed) await page.addInitScript(seed)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Play Channel 1', exact: true }).first()).toBeVisible({
    timeout: 60_000,
  })
}

test('surprise weighting favours watched categories and known-working streams', () => {
  const w = { news: 16 }
  const a = surpriseWeight({ id: 'a', categoryIds: ['news'] }, w, {})
  const b = surpriseWeight({ id: 'b', categoryIds: ['kids'] }, w, {})
  const c = surpriseWeight({ id: 'c', categoryIds: ['kids'] }, w, { c: {} })
  expect(a).toBeGreaterThan(b)
  expect(c).toBeGreaterThan(b)
  expect(b).toBeGreaterThanOrEqual(1) // nothing is ever excluded by weighting
})

test.describe('Surprise me', () => {
  test('the * key opens a random channel', async ({ page, context }) => {
    await boot(page, context)
    await page.keyboard.press('*')
    await expect(page).toHaveURL(/\/watch\//, { timeout: 15_000 })
  })

  test('the nav button works and shows a caption during the spin', async ({ page, context }) => {
    await boot(page, context)
    await page.getByRole('button', { name: /Surprise me/ }).first().click()
    await expect(page.getByText('Finding something for you…')).toBeVisible()
    await expect(page).toHaveURL(/\/watch\//, { timeout: 15_000 })
  })

  test('reduced motion still works', async ({ page, context }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await boot(page, context)
    await page.getByRole('button', { name: /Surprise me/ }).first().click()
    await expect(page).toHaveURL(/\/watch\//, { timeout: 15_000 })
  })

  test('* on the watch route switches channel', async ({ page, context }) => {
    await boot(page, context)
    await go(page, '/watch/ch1.xx')
    await expect(page.locator('.player')).toBeVisible({ timeout: 30_000 })
    await page.keyboard.press('*')
    await expect
      .poll(() => decodeURIComponent(new URL(page.url()).pathname), { timeout: 10_000 })
      .not.toBe('/watch/ch1.xx')
  })
})

test.describe('Sleep timer', () => {
  test('Z cycles 30 → 60 → 90 → off and ends on the Good night card', async ({ page, context }) => {
    await boot(page, context)
    await go(page, '/watch/ch1.xx')
    await expect(page.locator('.player')).toBeVisible({ timeout: 30_000 })
    const btn = page.locator('.player__sleep-btn')
    await page.keyboard.press('z')
    await expect(btn).toContainText('30m')
    await page.keyboard.press('z')
    await expect(btn).toContainText('60m')
    await page.keyboard.press('z')
    await expect(btn).toContainText('90m')
    await page.keyboard.press('z')
    await expect(btn).not.toContainText('m')

    // Jump the clock to the end of a 30 minute timer.
    await page.clock.install()
    await page.keyboard.press('z')
    await page.clock.fastForward('31:00')
    await expect(page.getByRole('heading', { name: 'Good night' })).toBeVisible()
    await page.getByRole('button', { name: 'Keep watching' }).click()
    await expect(page.getByRole('heading', { name: 'Good night' })).toHaveCount(0)
  })
})

test.describe('Resume line', () => {
  test('shows within 6h on a cold start, never autoplays, dismisses', async ({ page, context }) => {
    await boot(page, context, () => {
      if (!localStorage.getItem('sl_last_watch_v1')) {
        localStorage.setItem('sl_last_watch_v1', JSON.stringify({ id: 'ch3.xx', t: Date.now() - 30 * 60_000 }))
      }
    })
    const line = page.getByRole('region', { name: 'Pick up where you left off' })
    await expect(line).toContainText('Back to')
    expect(new URL(page.url()).pathname).toBe('/')
    await line.getByRole('button', { name: 'Dismiss' }).click()
    await expect(line).toHaveCount(0)
  })

  test('absent when the last watch is older than 6h', async ({ page, context }) => {
    await boot(page, context, () => {
      localStorage.setItem('sl_last_watch_v1', JSON.stringify({ id: 'ch3.xx', t: Date.now() - 7 * 3600_000 }))
    })
    await expect(page.getByRole('region', { name: 'Pick up where you left off' })).toHaveCount(0)
  })
})

test.describe('Reminders (local, in-app only)', () => {
  test('a due reminder toasts once and then clears', async ({ page, context }) => {
    await boot(page, context, () => {
      if (!localStorage.getItem('sl_reminders_v1')) {
        localStorage.setItem(
          'sl_reminders_v1',
          JSON.stringify([{ c: 'ch2.xx', n: 'Channel 2', p: 'Evening News', s: Date.now() + 30_000 }]),
        )
      }
    })
    const toast = page.locator('.reminder-toast')
    await expect(toast).toContainText('Evening News', { timeout: 10_000 })
    await toast.getByRole('button', { name: 'Dismiss reminder' }).click()
    await expect(toast).toHaveCount(0)
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('sl_reminders_v1') ?? '[]'))).toEqual([])
  })
})

test.describe('Flip preview', () => {
  test('resting on a drawer row for 800 ms shows now/next without a second video', async ({ page, context }) => {
    await boot(page, context)
    await go(page, '/watch/ch1.xx')
    await expect(page.locator('.player')).toBeVisible({ timeout: 30_000 })
    await page.keyboard.press('g')
    const rows = page.locator('.player__drawer-item')
    await expect(rows.nth(2)).toBeVisible()
    await rows.nth(2).hover()
    await expect(page.locator('.player__flip')).toHaveCount(0)
    await expect(page.locator('.player__flip')).toBeVisible({ timeout: 3000 })
    expect(await page.locator('video').count()).toBe(1)
  })
})

test.describe('Surprise me pool', () => {
  const ch = (id: string, url: string) => ({
    id,
    categoryIds: [],
    stream: { channel_id: id, url, quality: null, status: null },
    streams: [{ channel_id: id, url, quality: null, status: null }],
  })

  /** Runs pickSurprise in the page (real localStorage) over `n` seeded draws; returns picked ids. */
  async function draws(page: Page, channels: unknown[], excludeId?: string, seed?: () => void) {
    if (seed) await page.addInitScript(seed)
    await page.goto('/')
    return page.evaluate(
      async ({ channels, excludeId }) => {
        const m = await import('/src/util/surprise.ts')
        const out = new Set<string>()
        for (let i = 0; i < 40; i++) {
          const p = m.pickSurprise(channels as never, excludeId, () => (i + 0.5) / 40)
          out.add(p ? p.id : 'null')
        }
        return [...out]
      },
      { channels, excludeId },
    )
  }

  test('rtmp-only and mpd-only channels are never picked; the current channel is excluded', async ({ page }) => {
    const channels = [
      ch('ok', 'https://streams.invalid/a.m3u8'),
      ch('cur', 'https://streams.invalid/b.m3u8'),
      ch('rtmp', 'rtmp://streams.invalid/live'),
      ch('mpd', 'https://streams.invalid/x.mpd?token=1'),
    ]
    expect(await draws(page, channels, 'cur')).toEqual(['ok'])
  })

  test('broken-marked channels are excluded even with hide-broken off', async ({ page }) => {
    const channels = [ch('ok', 'https://streams.invalid/a.m3u8'), ch('bad', 'https://streams.invalid/b.m3u8')]
    const picked = await draws(page, channels, undefined, () => {
      localStorage.setItem('sl_broken_reset_v1', '1')
      localStorage.setItem('sl_broken_streams_v2', JSON.stringify({ bad: { timestamp: Date.now() } }))
      localStorage.removeItem('sl_hide_broken')
    })
    expect(picked).toEqual(['ok'])
  })

  test('a cached-working channel is strongly preferred', async ({ page }) => {
    const channels = Array.from({ length: 10 }, (_, i) => ch(`c${i}`, `https://streams.invalid/${i}.m3u8`))
    const counts = await (async () => {
      await page.addInitScript(() => {
        localStorage.setItem(
          'sl_working_streams_v1',
          JSON.stringify({ c3: { url: 'https://streams.invalid/3.m3u8', useProxy: false, timestamp: Date.now() } }),
        )
      })
      await page.goto('/')
      return page.evaluate(async (channels) => {
        const m = await import('/src/util/surprise.ts')
        let hits = 0
        for (let i = 0; i < 100; i++) if (m.pickSurprise(channels as never, undefined, () => (i + 0.5) / 100)?.id === 'c3') hits++
        return hits
      }, channels)
    })()
    // weight 26 of 35 total
    expect(counts).toBeGreaterThan(60)
  })

  test('recent failures expire after 30 minutes and drop out of the pool unless nothing else remains', async ({
    page,
  }) => {
    await page.goto('/')
    const r = await page.evaluate(async () => {
      const f = await import('/src/util/recentFailures.ts')
      const s = await import('/src/util/surprise.ts')
      f.clearRecentFailures()
      const t0 = 1_000_000
      f.noteFailure('a', t0)
      const within = f.hasRecentFailure('a', t0 + 29 * 60_000)
      const expired = f.hasRecentFailure('a', t0 + 30 * 60_000)
      const mk = (id: string) => ({
        id,
        categoryIds: [],
        stream: { channel_id: id, url: 'https://streams.invalid/x.m3u8', quality: null, status: null },
        streams: [{ channel_id: id, url: 'https://streams.invalid/x.m3u8', quality: null, status: null }],
      })
      f.noteFailure('a')
      const both = s.pickSurprise([mk('a'), mk('b')] as never, undefined, () => 0)?.id
      const only = s.pickSurprise([mk('a')] as never, undefined, () => 0)?.id
      f.clearRecentFailures()
      return { within, expired, both, only }
    })
    expect(r).toEqual({ within: true, expired: false, both: 'b', only: 'a' })
  })
})
