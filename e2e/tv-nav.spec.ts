import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { installUpstashMock } from './support/upstashMock'

/**
 * Phase 2 remote parity: D-pad reaches the hero and toolbar from the card grid, and the
 * player takes number entry, a last-channel key and consistent channel-up/down keys.
 */

const STREAM = /^https:\/\/streams\.invalid\//

async function go(page: Page, path: string) {
  await page.evaluate((to) => {
    history.pushState({}, '', to)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, path)
}
const watchId = (page: Page) => decodeURIComponent(new URL(page.url()).pathname.replace('/watch/', ''))

async function boot(page: Page, context: Parameters<typeof installUpstashMock>[0]) {
  await installUpstashMock(context, { totalChannels: 20, guideChannels: 10, withLogos: true })
  await page.route(/icons\.softarchium\.com/, (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>' }))
  await page.route(STREAM, () => {})
  await page.route(/\/api\/proxy/, () => {})
  await page.goto('/?tv=1')
  await expect(page.getByRole('button', { name: 'Play Channel 1', exact: true }).first()).toBeVisible({
    timeout: 60_000,
  })
}

test('D-pad Up climbs from the first card row to the toolbar, then the hero, and Down returns', async ({
  page,
  context,
}) => {
  await boot(page, context)
  await page.locator('[data-card="channel"] .channel-card__surface').first().focus()
  await page.keyboard.press('ArrowUp')
  await expect
    .poll(() => page.evaluate(() => !!document.activeElement?.closest('.home-toolbar')))
    .toBe(true)
  await page.keyboard.press('ArrowUp')
  await expect
    .poll(() => page.evaluate(() => !!document.activeElement?.closest('.hero')))
    .toBe(true)
  await page.keyboard.press('ArrowDown')
  await expect
    .poll(() => page.evaluate(() => !!document.activeElement?.closest('.home-toolbar')))
    .toBe(true)
})

test.describe('remote keys in the player', () => {
  test.beforeEach(async ({ page, context }) => {
    await boot(page, context)
    await go(page, '/watch/ch1.xx')
    await expect(page.locator('.player')).toBeVisible({ timeout: 30_000 })
  })

  test('digits enter a channel number that jumps after a pause', async ({ page }) => {
    await page.keyboard.press('3')
    await expect(page.locator('.player__chnum')).toContainText('3')
    await expect.poll(() => watchId(page), { timeout: 10_000 }).not.toBe('ch1.xx')
    const third = watchId(page)
    await page.keyboard.press('1')
    await page.keyboard.press('Enter')
    await expect.poll(() => watchId(page), { timeout: 10_000 }).not.toBe(third)
  })

  test('ChannelUp and ArrowUp go the same way; L returns to the previous channel', async ({ page }) => {
    const start = watchId(page)
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => watchId(page)).not.toBe(start)
    const down = watchId(page)
    await page.keyboard.press('l')
    await expect.poll(() => watchId(page)).toBe(start)
    // The URL changes a beat before the player re-renders on it; a human never presses that fast.
    await page.waitForTimeout(400)
    // ChannelDown matches ArrowDown, ChannelUp matches ArrowUp.
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ChannelDown' })))
    await expect.poll(() => watchId(page)).toBe(down)
    await page.waitForTimeout(400)
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ChannelUp' })))
    await expect.poll(() => watchId(page)).toBe(start)
  })
})
