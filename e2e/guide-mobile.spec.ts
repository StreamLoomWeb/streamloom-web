import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * Opens the guide and waits until schedules have produced programme boxes.
 *
 * Schedules arrive in waves, so the grid is only settled once its visible rows
 * have stopped showing the no-schedule placeholder.
 */
async function openGuide(page: Page) {
  await page.goto('/guide')
  await expect(page.locator('.epg-guide__grid')).toBeVisible({ timeout: 90_000 })
  await expect(page.locator('.epg-guide__row').first()).toBeVisible({ timeout: 90_000 })
  await expect
    .poll(
      () => page.evaluate(() => document.querySelectorAll('.epg-guide__program').length),
      { timeout: 90_000, message: 'programme boxes never rendered' },
    )
    .toBeGreaterThan(0)
  await expect
    .poll(
      () => page.evaluate(() => document.querySelectorAll('.epg-guide__no-prog').length),
      { timeout: 90_000, message: 'rows never finished loading their schedules' },
    )
    .toBe(0)
}

test.describe('TV guide on mobile', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('renders and scrolls on a phone viewport', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push('PAGEERROR: ' + err.message))
    page.on('console', (msg) => {
      // These specs read the real Redis and never install the R2 mock, so the index.html
      // preload of the mock host is refused; that is the setup, not a page fault.
      if (msg.type() === 'error' && !msg.location().url.startsWith('http://127.0.0.1:5198/')) errors.push(msg.text())
    })

    await openGuide(page)

    const metrics = await page.evaluate(() => {
      const grid = document.querySelector('.epg-guide__grid') as HTMLElement | null
      const row = document.querySelector('.epg-guide__row') as HTMLElement | null
      return {
        rowHeight: row?.clientHeight ?? 0,
        sidebarWidth: (document.querySelector('.epg-guide__channel') as HTMLElement)?.clientWidth ?? 0,
        scrollWidth: grid?.scrollWidth ?? 0,
        clientWidth: grid?.clientWidth ?? 0,
        programs: document.querySelectorAll('.epg-guide__program').length,
        emptyRows: document.querySelectorAll('.epg-guide__no-prog').length,
      }
    })

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([])
    expect(metrics.programs, 'programmes render on mobile').toBeGreaterThan(0)
    expect(metrics.emptyRows, 'no empty rows on mobile').toBe(0)
    expect(metrics.scrollWidth, 'grid scrolls horizontally on mobile').toBeGreaterThan(
      metrics.clientWidth,
    )
    // The narrow layout must actually shrink the sidebar and rows.
    expect(metrics.sidebarWidth, 'sidebar is the mobile width').toBeLessThan(160)
    expect(metrics.rowHeight, 'rows are the mobile height').toBeLessThan(60)

    // Scrolling still works with touch metrics applied.
    await page.locator('.epg-guide__grid').evaluate((el) => el.scrollTo({ top: 300, left: 300 }))
    await page.waitForTimeout(500)
    const scrolled = await page
      .locator('.epg-guide__grid')
      .evaluate((el) => ({ top: el.scrollTop, left: el.scrollLeft }))
    expect(scrolled.top, 'vertical scroll works on mobile').toBeGreaterThan(0)
    expect(scrolled.left, 'horizontal scroll works on mobile').toBeGreaterThan(0)
  })
})
