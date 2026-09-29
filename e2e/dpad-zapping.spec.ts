import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { installUpstashMock } from './support/upstashMock'

/**
 * D-pad zapping on the watch route. While a zapped-to channel is still buffering
 * the HUD is showing, and Up/Down must keep changing channel rather than move
 * focus; Left/Right still enter the HUD.
 */

const STREAM = /^https:\/\/streams\.invalid\//

async function go(page: Page, path: string) {
  await page.evaluate((to) => {
    history.pushState({}, '', to)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, path)
}

const watchId = (page: Page) => decodeURIComponent(new URL(page.url()).pathname.replace('/watch/', ''))

test.describe('D-pad zapping while buffering', () => {
  test.beforeEach(async ({ page, context }) => {
    await installUpstashMock(context, { totalChannels: 20, guideChannels: 10 })
    // Never answered: the player stays in its buffering state (HUD shown).
    await page.route(STREAM, () => {})
    await page.route(/\/api\/proxy/, () => {})
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Play Channel 1', exact: true }).first()).toBeVisible({
      timeout: 60_000,
    })
    await go(page, '/watch/ch1.xx')
    await expect(page.locator('.player')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.player--hud-visible')).toBeVisible()
  })

  test('five consecutive ArrowDown presses change channel five times', async ({ page }) => {
    const seen = [watchId(page)]
    for (let i = 0; i < 5; i++) {
      const before = watchId(page)
      await page.keyboard.press('ArrowDown')
      await expect.poll(() => watchId(page), { timeout: 10_000 }).not.toBe(before)
      seen.push(watchId(page))
    }
    expect(new Set(seen).size).toBe(6)
  })

  test('ArrowLeft/ArrowRight enter the HUD without changing channel', async ({ page }) => {
    const before = watchId(page)
    await page.keyboard.press('ArrowRight')
    await expect
      .poll(() => page.evaluate(() => !!document.activeElement?.closest('.player__hud')))
      .toBe(true)
    await page.keyboard.press('ArrowLeft')
    expect(watchId(page)).toBe(before)
    expect(await page.evaluate(() => !!document.activeElement?.closest('.player__hud'))).toBe(true)
  })
})
