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

test('a catalogue with no safe channel shows a message and a retry, not a blank page', async ({ page, context }) => {
  await installUpstashMock(context, { totalChannels: 3, guideChannels: 3, unsafeChannels: 3 })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'No channels available yet' })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('button', { name: 'Try again' })).toBeFocused()
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

test.describe('the live safe list overlay', () => {
  const overlay = (page: Page, status: number, ids: string[] = []) =>
    page.route('**/catalogue/safe-channels.json', (route) =>
      status === 200
        ? route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ schema: 1, updatedAt: 'x', ids }) })
        : route.fulfill({ status, body: '' }),
    )
  const play = (page: Page, n: number) => page.getByRole('button', { name: `Play Channel ${n}`, exact: true })

  test('a valid list decides what shows, either way round', async ({ page, context }) => {
    await installUpstashMock(context, { totalChannels: 5, guideChannels: 5, unsafeChannels: 1 })
    // Channel 4 is published unsafe and listed; channel 0 is published safe and not listed.
    await overlay(page, 200, ['ch1.xx', 'ch2.xx', 'ch3.xx', 'ch4.xx'])
    await page.goto('/')
    await expect(play(page, 4).first()).toBeVisible({ timeout: 60_000 })
    await expect(play(page, 0)).toHaveCount(0)
  })

  test('a 404 keeps the published flags', async ({ page, context }) => {
    await installUpstashMock(context, { totalChannels: 5, guideChannels: 5, unsafeChannels: 1 })
    await overlay(page, 404)
    await openHome(page)
    await expect(play(page, 4)).toHaveCount(0)
  })

  test('an unlocked device shows everything whatever the list says', async ({ page, context }) => {
    await installUpstashMock(context, { totalChannels: 5, guideChannels: 5, unsafeChannels: 1 })
    await overlay(page, 200, [])
    await page.addInitScript((key) => localStorage.setItem(key, 'true'), UNLOCKED_KEY)
    await page.goto('/')
    await expect(play(page, 4).first()).toBeVisible({ timeout: 60_000 })
    await expect(play(page, 0).first()).toBeVisible()
  })
})
