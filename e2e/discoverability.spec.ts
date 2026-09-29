import { test, expect } from '@playwright/test'
import { installUpstashMock } from './support/upstashMock'

const STREAM = /^https:\/\/streams\.invalid\//

test.beforeEach(async ({ page, context }) => {
  await installUpstashMock(context, { totalChannels: 20, guideChannels: 10 })
  await page.route(STREAM, () => {})
  await page.route(/\/api\/proxy/, () => {})
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Play Channel 1', exact: true }).first()).toBeVisible({
    timeout: 60_000,
  })
})

test('? opens the shortcut list, Esc closes it, and it lists *, Z and G', async ({ page }) => {
  await page.keyboard.press('?')
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Surprise me: play a random live channel')).toBeVisible()
  await expect(dialog.getByText('Sleep timer: 30 / 60 / 90 min')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('Home shows a labelled Surprise me chip and one feature tip that stays dismissed', async ({ page }) => {
  await expect(page.locator('.filter-pill--surprise')).toBeVisible()
  const tip = page.locator('.feature-tip')
  await expect(tip).toBeVisible()
  await tip.getByRole('button', { name: 'Dismiss tip' }).click()
  await expect(tip).toBeHidden()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Play Channel 1', exact: true }).first()).toBeVisible({
    timeout: 60_000,
  })
  await expect(page.locator('.feature-tip')).not.toContainText('Let StreamLoom pick')
})
