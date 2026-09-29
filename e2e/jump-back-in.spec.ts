import { test, expect } from '@playwright/test'
import { installUpstashMock } from './support/upstashMock'
import { createR2Server } from './support/r2Mock'

/** Home "Jump back in": row order, v1 -> v2 migration, and the "watched ago" note. */

const r2Server = createR2Server()
const CATALOGUE = { totalChannels: 20, guideChannels: 5, streamlessChannels: 2 }

test.beforeAll(() => r2Server.listen())
test.afterAll(() => r2Server.close())

test.beforeEach(async ({ context }) => {
  r2Server.reset(CATALOGUE)
  await r2Server.route(context)
  await installUpstashMock(context, CATALOGUE)
})

test('migrates the id-only history and shows Jump back in before Favourites', async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem('sl_seeded')) return
    localStorage.setItem('sl_seeded', '1')
    localStorage.setItem('sl_recent_v1', JSON.stringify(['ch2.xx']))
    localStorage.setItem('sl_favourites_v1', JSON.stringify(['ch3.xx']))
  })
  await page.goto('/')
  const jump = page.locator('section', { has: page.getByText('Jump back in', { exact: false }) }).first()
  await expect(jump).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('Continue Watching')).toHaveCount(0)

  const migrated = await page.evaluate(() => JSON.parse(localStorage.getItem('sl_recent_v2') ?? 'null'))
  expect(migrated).toEqual([{ id: 'ch2.xx', t: 0 }])

  // Migrated entries have no known time, so no "watched" note is drawn.
  await expect(page.getByText(/watched .* ago/)).toHaveCount(0)
})

test('a timestamped entry shows a watched-ago note', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sl_recent_v2', JSON.stringify([{ id: 'ch2.xx', t: Date.now() - 2 * 3_600_000 }]))
  })
  await page.goto('/')
  await expect(page.getByText('watched 2h ago')).toBeVisible({ timeout: 60_000 })
})
