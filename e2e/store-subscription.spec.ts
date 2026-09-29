import { test, expect } from '@playwright/test'

/**
 * A store change that lands between a component's render and its commit must still
 * re-render it.
 *
 * Production regression (2026-09-29): opening /watch/<id> directly showed a blank
 * page with a dim "Loading…" about half the time. The catalogue came out of
 * IndexedDB while the lazy Watch route was rendering; `useChannels` subscribed in
 * `useEffect`, so the notification fired before anyone listened and Watch stayed on
 * the state it rendered with. The hooks now use `useSyncExternalStore`, which checks
 * the store again once subscribed. The harness (support/storeHarness.ts) makes the
 * change inside the first render, so the window is hit every time, not by chance.
 */

const CHANNEL = 'probe.xx'

test('store hooks re-render for a change made before they subscribed', async ({ page }) => {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => route.abort())
  await page.goto('/e2e/support/storeHarness.html')
  await page.waitForFunction(() => (window as unknown as { __harnessReady?: boolean }).__harnessReady === true)
  await page.evaluate(() => {
    localStorage.clear()
  })
  // The catalogue load (every host but this one is refused) fails and notifies once;
  // its next retry is 15 s away, so nothing but the probe's own change notifies after it.
  const settled = page.waitForEvent('console', (m) => m.text().includes('[catalogue] load failed'))
  await page.reload()
  await page.waitForFunction(() => (window as unknown as { __harnessReady?: boolean }).__harnessReady === true)
  await settled

  await page.evaluate((id) => {
    ;(window as unknown as { __mountProbes: (id: string) => void }).__mountProbes(id)
  }, CHANNEL)

  // Rendered first with the old value (0 hidden / not a favourite / nothing recent),
  // then again with the value set during that render.
  const within = { timeout: 5_000 }
  await expect(page.locator('[data-probe="catalogue"]')).toHaveText('1', within)
  await expect(page.locator('[data-probe="favourites"]')).toHaveText('yes', within)
  await expect(page.locator('[data-probe="recent"]')).toHaveText(CHANNEL, within)
})
