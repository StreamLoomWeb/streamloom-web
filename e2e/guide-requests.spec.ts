import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { installUpstashMock } from './support/upstashMock'
import type { UpstashMock } from './support/upstashMock'

/**
 * Upstash read budget.
 *
 * Every Upstash read is metered, so the guide must read only the rows it shows
 * and a repeat visit on an unchanged catalogue generation must not re-download
 * the catalogue. These tests count requests against an in-process mock, so they
 * spend none of the real quota.
 *
 * No R2 snapshot host is started here, so the client's first choice refuses the
 * connection and every read falls through to Redis: this spec is the Redis
 * fallback's budget. The R2-first path is e2e/catalogue-r2.spec.ts.
 */

/** Ceiling for schedule reads on guide open ("about 50" in the work order). */
const GUIDE_OPEN_BUDGET = 50

/** Resolves once no new Upstash read has arrived for `quietMs`. */
async function settle(page: Page, mock: UpstashMock, quietMs = 2_000) {
  let last = -1
  let stableSince = Date.now()
  for (let waited = 0; waited < 60_000; waited += 250) {
    const seen = mock.requests.length
    if (seen !== last) {
      last = seen
      stableSince = Date.now()
    } else if (Date.now() - stableSince >= quietMs) {
      return
    }
    await page.waitForTimeout(250)
  }
  throw new Error('Upstash reads never settled')
}

async function openGuide(page: Page, mock: UpstashMock) {
  await page.goto('/guide')
  await expect(page.locator('.epg-guide__row').first()).toBeVisible({ timeout: 60_000 })
  await expect
    .poll(() => page.locator('.epg-guide__program').count(), { timeout: 60_000 })
    .toBeGreaterThan(0)
  await settle(page, mock)
}

/** Waits until the catalogue record has landed in IndexedDB. */
async function catalogueStored(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            new Promise<boolean>((resolve) => {
              const open = indexedDB.open('streamloom')
              open.onerror = () => resolve(false)
              open.onsuccess = () => {
                const db = open.result
                if (!db.objectStoreNames.contains('catalogue')) {
                  db.close()
                  resolve(false)
                  return
                }
                const req = db.transaction('catalogue').objectStore('catalogue').get('current')
                req.onsuccess = () => {
                  db.close()
                  resolve(Boolean(req.result))
                }
                req.onerror = () => {
                  db.close()
                  resolve(false)
                }
              }
            }),
        ),
      { timeout: 30_000, message: 'catalogue never reached IndexedDB' },
    )
    .toBe(true)
}

/** Keys of the persisted schedules, as `<generation>:<channelId>`. */
function storedScheduleKeys(page: Page) {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const open = indexedDB.open('streamloom')
        open.onerror = () => resolve([])
        open.onsuccess = () => {
          const db = open.result
          if (!db.objectStoreNames.contains('schedules')) {
            db.close()
            resolve([])
            return
          }
          const req = db.transaction('schedules').objectStore('schedules').getAllKeys()
          req.onsuccess = () => {
            db.close()
            resolve((req.result as IDBValidKey[]).map(String))
          }
          req.onerror = () => {
            db.close()
            resolve([])
          }
        }
      }),
  )
}

function report(label: string, mock: UpstashMock) {
  const kinds = ['meta', 'channels', 'streams', 'categories', 'epgIds', 'schedule'] as const
  const parts = kinds.map((k) => `${k}=${mock.count(k)}`).join(' ')
  console.log(`[reads] ${label}: total=${mock.requests.length} ${parts}`)
}

test.describe('Upstash read budget', () => {
  test('cold catalogue load', async ({ page, context }) => {
    const mock = await installUpstashMock(context)
    await page.goto('/')
    await expect(page.locator('body')).toContainText('Channel', { timeout: 60_000 })
    await settle(page, mock)
    report('cold catalogue load', mock)

    // One generation pointer, every page once, no schedules on the home page.
    expect(mock.count('schedule')).toBe(0)
    expect(mock.count('channels')).toBe(6)
    expect(mock.count('streams')).toBe(9)
  })

  test('repeat load on an unchanged generation skips the catalogue download', async ({ page, context }) => {
    const mock = await installUpstashMock(context)
    await page.goto('/')
    await expect(page.locator('body')).toContainText('Channel', { timeout: 60_000 })
    await catalogueStored(page)
    await settle(page, mock)

    mock.reset()
    await page.reload()
    await expect(page.locator('body')).toContainText('Channel', { timeout: 60_000 })
    await settle(page, mock)
    report('repeat load, same generation', mock)

    expect(mock.catalogueDataCount()).toBe(0)
    expect(mock.count('meta')).toBe(1)
    expect(mock.requests.length).toBe(1)
  })

  test('a new generation triggers a full download', async ({ page, context }) => {
    const mock = await installUpstashMock(context)
    await page.goto('/')
    await expect(page.locator('body')).toContainText('Channel', { timeout: 60_000 })
    await catalogueStored(page)
    await settle(page, mock)

    mock.setGeneration(1_790_000_999_999)
    mock.reset()
    await page.reload()
    await expect(page.locator('body')).toContainText('Channel', { timeout: 60_000 })
    await settle(page, mock)
    report('repeat load, new generation', mock)

    expect(mock.count('channels')).toBe(6)
    expect(mock.count('streams')).toBe(9)
    expect(mock.count('categories')).toBe(1)
  })

  test('guide open reads only the visible rows, and scrolling reads more', async ({ page, context }) => {
    const mock = await installUpstashMock(context)
    await openGuide(page, mock)
    const onOpen = mock.count('schedule')
    report('guide open', mock)

    // Scroll one viewport down: new rows are read, and only those.
    const viewportH = await page.locator('.epg-guide__grid').evaluate((el) => el.clientHeight)
    await page.locator('.epg-guide__grid').evaluate((el, dy) => el.scrollBy(0, dy), viewportH)
    await settle(page, mock)
    const afterScroll = mock.count('schedule')
    report('guide after scrolling one screen', mock)

    expect(onOpen).toBeGreaterThan(0)
    expect(onOpen).toBeLessThanOrEqual(GUIDE_OPEN_BUDGET)
    expect(afterScroll).toBeGreaterThan(onOpen)
    expect(afterScroll - onOpen).toBeLessThanOrEqual(GUIDE_OPEN_BUDGET)
    expect(afterScroll).toBeLessThan(526)
  })

  test('reopening the guide after a reload reads no schedules already stored', async ({ page, context }) => {
    const mock = await installUpstashMock(context)
    await openGuide(page, mock)
    expect(mock.count('schedule')).toBeGreaterThan(0)

    mock.reset()
    await page.reload()
    await expect(page.locator('.epg-guide__row').first()).toBeVisible({ timeout: 60_000 })
    await expect
      .poll(() => page.locator('.epg-guide__program').count(), { timeout: 60_000 })
      .toBeGreaterThan(0)
    await settle(page, mock)
    report('guide reopened after reload', mock)

    expect(mock.count('schedule')).toBe(0)
    expect(mock.catalogueDataCount()).toBe(0)
  })

  test('a new generation re-reads schedules and drops the old generation from storage', async ({ page, context }) => {
    const oldGeneration = 1_790_000_000_000
    const newGeneration = 1_790_000_999_999
    const mock = await installUpstashMock(context, { generation: oldGeneration })
    await openGuide(page, mock)
    await expect.poll(() => storedScheduleKeys(page)).not.toEqual([])
    expect((await storedScheduleKeys(page)).every((k) => k.startsWith(oldGeneration + ':'))).toBe(true)

    mock.setGeneration(newGeneration)
    mock.reset()
    await page.reload()
    await expect(page.locator('.epg-guide__row').first()).toBeVisible({ timeout: 60_000 })
    await expect
      .poll(() => page.locator('.epg-guide__program').count(), { timeout: 60_000 })
      .toBeGreaterThan(0)
    await settle(page, mock)
    report('guide reopened on a new generation', mock)

    expect(mock.count('schedule')).toBeGreaterThan(0)
    expect(mock.count('schedule')).toBeLessThanOrEqual(GUIDE_OPEN_BUDGET)
    await expect
      .poll(async () => {
        const keys = await storedScheduleKeys(page)
        return keys.length > 0 && keys.every((k) => k.startsWith(newGeneration + ':'))
      })
      .toBe(true)
  })

  test('schedules whose programmes have all ended are read again, not reused', async ({ page, context }) => {
    const mock = await installUpstashMock(context, { endedSchedules: true })
    await openGuide(page, mock)
    const first = mock.count('schedule')
    expect(first).toBeGreaterThan(0)
    expect(await storedScheduleKeys(page)).toEqual([])

    mock.reset()
    await page.reload()
    await expect(page.locator('.epg-guide__row').first()).toBeVisible({ timeout: 60_000 })
    await settle(page, mock)
    report('guide reopened, schedules ended', mock)

    expect(mock.count('schedule')).toBeGreaterThan(0)
  })
})
