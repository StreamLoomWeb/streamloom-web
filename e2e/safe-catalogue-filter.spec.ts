import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { installUpstashMock } from './support/upstashMock'

/**
 * The default-safe filter and the full-catalogue unlock (ADR-0059/0060).
 *
 * `installUpstashMock`'s `unsafeChannels` option marks the last N synthetic channels
 * `safe: false`; every other spec leaves it at 0, so this is the only file exercising the
 * filter. `/api/unlock-validate` is intercepted rather than served — there is no secret
 * configured in this environment, same reasoning `admin-portal.spec.ts` gives for `/api/picks`.
 */

const UNLOCKED_KEY = 'sl_catalogue_unlocked_v1'

async function openHome(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Play Channel 0', exact: true }).first()).toBeVisible({
    timeout: 60_000,
  })
}

test('an unsafe channel is hidden by default, and reachable once unlocked', async ({ page, context }) => {
  await installUpstashMock(context, { totalChannels: 5, guideChannels: 5, unsafeChannels: 1 })
  await openHome(page)

  // Channel 4 (the last one) is the unsafe one; the rest are safe and visible as usual.
  await expect(page.getByRole('button', { name: 'Play Channel 4', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Play Channel 0', exact: true }).first()).toBeVisible()

  // A redemption on a previous visit (the endpoint itself is covered in
  // unlock-endpoint.spec.ts; an in-page redemption without a reload is covered in "the unlock
  // dialog" group below) lifts the filter everywhere once the module re-reads it from storage.
  await page.evaluate((key) => localStorage.setItem(key, 'true'), UNLOCKED_KEY)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Play Channel 4', exact: true })).toBeVisible({ timeout: 60_000 })
})

test('a direct link to an unsafe channel 404s until the catalogue is unlocked', async ({ page, context }) => {
  await installUpstashMock(context, { totalChannels: 5, guideChannels: 5, unsafeChannels: 1 })
  await page.goto('/watch/ch4.xx')
  await expect(page.locator('body')).toContainText(/not found|not available|no longer/i, { timeout: 60_000 })

  await page.evaluate((key) => localStorage.setItem(key, 'true'), UNLOCKED_KEY)
  await page.goto('/watch/ch4.xx')
  await expect(page.locator('body')).not.toContainText(/not found/i, { timeout: 60_000 })
})

test.describe('the unlock dialog', () => {
  test('seven taps on the version string open it, with a persisted client code', async ({ page, context }) => {
    await installUpstashMock(context, { totalChannels: 5, guideChannels: 5 })
    await page.goto('/settings')
    const version = page.getByText('Version').locator('..').locator('span[role="button"]')
    await expect(version).toBeVisible()

    for (let i = 0; i < 7; i++) await version.click()

    const dialog = page.getByRole('dialog', { name: 'Unlock full catalogue' })
    await expect(dialog).toBeVisible()
    const code = await dialog.locator('.unlock-dialog__code').textContent()
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/)

    const stored = await page.evaluate(() => localStorage.getItem('sl_unlock_client_code_v1'))
    expect(stored).toBe(code)
  })

  test('pausing more than the timeout resets the tap count', async ({ page, context }) => {
    await installUpstashMock(context, { totalChannels: 5, guideChannels: 5 })
    await page.goto('/settings')
    const version = page.getByText('Version').locator('..').locator('span[role="button"]')

    for (let i = 0; i < 4; i++) await version.click()
    await page.waitForTimeout(2200)
    for (let i = 0; i < 4; i++) await version.click()

    await expect(page.getByRole('dialog', { name: 'Unlock full catalogue' })).toHaveCount(0)
  })

  test('a wrong code shows an inline error and keeps the typed input', async ({ page, context }) => {
    await installUpstashMock(context, { totalChannels: 5, guideChannels: 5, unsafeChannels: 1 })
    await page.route('**/api/unlock-validate', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ valid: false }) }),
    )
    await page.goto('/settings')
    const version = page.getByText('Version').locator('..').locator('span[role="button"]')
    for (let i = 0; i < 7; i++) await version.click()

    const dialog = page.getByRole('dialog', { name: 'Unlock full catalogue' })
    await dialog.locator('#unlock-dialog-input').fill('ABCDEF')
    await dialog.getByRole('button', { name: 'Unlock' }).click()

    await expect(dialog.locator('.unlock-dialog__error')).toBeVisible()
    await expect(dialog.locator('#unlock-dialog-input')).toHaveValue('ABCDEF')
    await expect(dialog).toBeVisible()
  })

  test('a correct code closes the dialog and unlocks the catalogue', async ({ page, context }) => {
    await installUpstashMock(context, { totalChannels: 5, guideChannels: 5, unsafeChannels: 1 })
    await page.route('**/api/unlock-validate', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ valid: true }) }),
    )
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Play Channel 4', exact: true })).toHaveCount(0)

    await page.goto('/settings')
    const version = page.getByText('Version').locator('..').locator('span[role="button"]')
    for (let i = 0; i < 7; i++) await version.click()
    const dialog = page.getByRole('dialog', { name: 'Unlock full catalogue' })
    await dialog.locator('#unlock-dialog-input').fill('ABCDEF')
    await dialog.getByRole('button', { name: 'Unlock' }).click()
    await expect(dialog).toHaveCount(0, { timeout: 10_000 })

    const unlocked = await page.evaluate((key) => localStorage.getItem(key), UNLOCKED_KEY)
    expect(unlocked).toBe('true')

    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Play Channel 4', exact: true })).toBeVisible({ timeout: 60_000 })
  })
})
