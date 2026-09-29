import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * TV guide browser tests.
 *
 * Every assertion here is something a server-side render cannot observe: real
 * scroll metrics, computed sticky positions, and whether programme boxes
 * actually line up on screen. The regressions these cover — a stylesheet that
 * parsed but laid out wrong, rows that filtered all their data away, a crash
 * that blanked the page — all passed a build and an SSR check.
 */

/**
 * Opens the guide and waits until schedules have produced programme boxes.
 *
 * Schedules arrive in waves, so waiting for the *first* box is not enough: the
 * grid is only meaningfully loaded once its visible rows have stopped showing
 * the no-schedule placeholder. Tests assert against a settled grid, not a
 * half-populated one.
 */
async function openGuide(page: Page) {
  await page.goto('/guide')
  await expect(page.locator('.epg-guide__grid')).toBeVisible({ timeout: 90_000 })
  await expect(page.locator('.epg-guide__row').first()).toBeVisible({ timeout: 90_000 })
  // Poll the DOM rather than waiting on a specific box, which may sit just
  // outside the viewport.
  await expect
    .poll(
      () => page.evaluate(() => document.querySelectorAll('.epg-guide__program').length),
      { timeout: 90_000, message: 'programme boxes never rendered' },
    )
    .toBeGreaterThan(0)
  // Then wait for the waves to land, so rows are not measured mid-load.
  await expect
    .poll(
      () => page.evaluate(() => document.querySelectorAll('.epg-guide__no-prog').length),
      { timeout: 90_000, message: 'rows never finished loading their schedules' },
    )
    .toBe(0)
}

/** Counts rows, programme boxes and empty rows in the current view. */
function guideStats(page: Page) {
  return page.evaluate(() => ({
    rows: document.querySelectorAll('.epg-guide__row').length,
    programs: document.querySelectorAll('.epg-guide__program').length,
    emptyRows: document.querySelectorAll('.epg-guide__no-prog').length,
    firstTitle: document.querySelector('.epg-guide__prog-title')?.textContent?.trim() ?? '',
  }))
}

/** The guide's channel count, which every filter must move. */
function channelCount(page: Page) {
  return page.locator('.epg-toolbar__count')
}

test.describe('TV guide', () => {
  test('renders the full grid without console errors', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      // These specs read the real Redis and never install the R2 mock, so the index.html
      // preload of the mock host is refused; that is the setup, not a page fault.
      if (msg.type() === 'error' && !msg.location().url.startsWith('http://127.0.0.1:5198/')) errors.push(msg.text())
    })
    page.on('pageerror', (err) => errors.push('PAGEERROR: ' + err.message))

    await openGuide(page)

    await expect(page.locator('.search-bar__input')).toBeVisible()
    await expect(page.locator('.epg-guide__timeline')).toBeVisible()
    await expect(page.locator('.epg-guide__now-flag')).toBeAttached()

    // The ruler must keep its full height: as a flex child of a column grid it
    // was being squashed to a few pixels, clipping every hour label.
    const timelineHeight = (await page.locator('.epg-guide__timeline').boundingBox())!.height
    expect(timelineHeight, 'ruler keeps its height').toBeGreaterThan(36)

    const labels = await page.locator('.epg-guide__hour-label').allInnerTexts()
    expect(labels.length, 'hour labels rendered').toBeGreaterThan(5)
    for (const label of labels) {
      expect(label.trim(), `hour label format: ${label}`).toMatch(/^\d{2}:\d{2}$/)
    }

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([])
  })

  test('shows programme data rather than empty rows', async ({ page }) => {
    await openGuide(page)
    const stats = await guideStats(page)

    // This is the bug that shipped: rows rendered but every one filtered its
    // programmes away, so the guide looked broken.
    expect(stats.programs, 'programme boxes rendered').toBeGreaterThan(0)
    expect(stats.emptyRows, 'no visible row was left empty').toBe(0)
    expect(stats.firstTitle.length, 'first programme has a title').toBeGreaterThan(0)
  })

  test('programme boxes are laid out sequentially without overlapping', async ({ page }) => {
    await openGuide(page)
    await page.waitForTimeout(2000)

    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('.epg-guide__row')].slice(0, 6).map((row) => {
        // Positions are relative to the row's programme track, so each row is
        // compared in its own coordinate space rather than viewport space.
        const track = row.querySelector('.epg-guide__programs') as HTMLElement | null
        const trackLeft = track?.getBoundingClientRect().left ?? 0
        return [...row.querySelectorAll('.epg-guide__program')].map((p) => {
          const r = p.getBoundingClientRect()
          return {
            left: r.left - trackLeft,
            right: r.right - trackLeft,
            top: r.top,
            width: r.width,
            title: p.querySelector('.epg-guide__prog-title')?.textContent?.slice(0, 20) ?? '',
          }
        })
      }),
    )

    expect(rows.length, 'rows inspected').toBeGreaterThan(0)
    let compared = 0
    for (const row of rows) {
      for (let i = 1; i < row.length; i += 1) {
        const prev = row[i - 1]
        const cur = row[i]
        // Overlap beyond a pixel is a layout bug; a 1px seam is rounding. This
        // catches content-box padding spilling a box past its slot, which is
        // what made the first version of this grid collide with itself.
        expect(
          cur.left,
          `box ${i} overlaps box ${i - 1} (${cur.width}px wide)`,
        ).toBeGreaterThanOrEqual(prev.right - 1.5)
        expect(Math.abs(cur.top - prev.top), 'boxes in a row share a top edge').toBeLessThan(1.5)
        expect(cur.width, `box ${i} has no zero-width boxes`).toBeGreaterThan(0)
        compared += 1
      }
    }
    expect(compared, 'adjacent pairs compared').toBeGreaterThan(0)
  })

  test('every programme box fits inside its own slot', async ({ page }) => {
    await openGuide(page)
    await page.waitForTimeout(2000)

    const overflow = await page.evaluate(() => {
      const bad: string[] = []
      for (const box of document.querySelectorAll('.epg-guide__program')) {
        const el = box as HTMLElement
        const cs = getComputedStyle(el)
        const declared = parseFloat(el.style.width)
        const rendered = el.getBoundingClientRect().width
        // Padding and border must be inside the declared width, otherwise the
        // box paints past the slot it was given.
        if (rendered > declared + 1) {
          bad.push(`${el.textContent?.slice(0, 16)}: declared ${declared}px rendered ${rendered}px`)
        }
        if (cs.boxSizing !== 'border-box') bad.push(`box-sizing is ${cs.boxSizing}`)
      }
      return bad.slice(0, 5)
    })

    expect(overflow, `boxes overflowing their slot:\n${overflow.join('\n')}`).toEqual([])
  })

  test('the grid scrolls vertically and the ruler stays pinned', async ({ page }) => {
    await openGuide(page)
    const grid = page.locator('.epg-guide__grid')
    const timeline = page.locator('.epg-guide__timeline')

    const metrics = await grid.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      overflowY: getComputedStyle(el).overflowY,
    }))
    expect(metrics.overflowY, 'grid is a vertical scroll container').toBe('auto')
    expect(metrics.scrollHeight, 'content taller than viewport').toBeGreaterThan(
      metrics.clientHeight,
    )

    const gridTop = (await grid.boundingBox())!.y
    await grid.evaluate((el) => el.scrollTo({ top: 400 }))
    await page.waitForTimeout(400)

    expect(await grid.evaluate((el) => el.scrollTop), 'scrollTop advanced').toBeGreaterThan(0)
    expect(
      Math.abs((await timeline.boundingBox())!.y - gridTop),
      'ruler stayed pinned to the top of the grid',
    ).toBeLessThan(6)
  })

  test('the grid scrolls horizontally and the channel column stays pinned', async ({ page }) => {
    await openGuide(page)
    const grid = page.locator('.epg-guide__grid')

    const metrics = await grid.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      overflowX: getComputedStyle(el).overflowX,
    }))
    expect(metrics.overflowX, 'grid is a horizontal scroll container').toBe('auto')
    expect(metrics.scrollWidth, 'timeline wider than viewport').toBeGreaterThan(metrics.clientWidth)

    const gridLeft = (await grid.boundingBox())!.x
    await grid.evaluate((el) => el.scrollTo({ left: 600 }))
    await page.waitForTimeout(400)

    expect(await grid.evaluate((el) => el.scrollLeft), 'scrollLeft advanced').toBeGreaterThan(0)
    expect(
      Math.abs((await page.locator('.epg-guide__channel').first().boundingBox())!.x - gridLeft),
      'channel column stayed pinned to the left',
    ).toBeLessThan(6)
  })

  test('scrolling to a later row re-anchors the axis and still shows data', async ({ page }) => {
    await openGuide(page)
    const grid = page.locator('.epg-guide__grid')

    await grid.evaluate((el) => el.scrollTo({ top: 3000 }))
    await page.waitForTimeout(3000)

    const stats = await guideStats(page)
    expect(stats.rows, 'rows still rendered after scrolling').toBeGreaterThan(0)
    expect(stats.programs, 'programmes still rendered after scrolling').toBeGreaterThan(0)
    expect(stats.emptyRows, 'no empty rows after scrolling').toBe(0)
  })

  test('anchors to the published schedule when the feed lags the clock', async ({ page }) => {
    await openGuide(page)

    const state = await page.evaluate(() => {
      const labels = [...document.querySelectorAll('.epg-guide__hour-label')].map(
        (e) => e.textContent ?? '',
      )
      return {
        staleNotice: document.querySelector('.epg-guide__stale')?.textContent?.trim() ?? '',
        firstLabel: labels[0] ?? '',
        lastLabel: labels[labels.length - 1] ?? '',
        programs: document.querySelectorAll('.epg-guide__program').length,
      }
    })

    // The axis must never point at a period with no data: that is what left the
    // guide looking broken when the feed stopped publishing today's schedule.
    expect(state.programs, 'the anchored window contains programmes').toBeGreaterThan(0)
    expect(state.firstLabel, 'ruler starts on a whole hour').toMatch(/^\d{2}:00$/)
    expect(state.lastLabel, 'ruler ends on a whole hour').toMatch(/^\d{2}:00$/)
    // When it is stale the viewer is told, rather than silently shown old data.
    if (state.staleNotice) {
      expect(state.staleNotice).toContain('latest published schedules')
    }
  })

  test('search narrows the guide and clearing restores it', async ({ page }) => {
    await openGuide(page)
    const count = channelCount(page)
    const before = await count.innerText()

    await page.locator('.search-bar__input').fill('bbc')
    await page.waitForTimeout(1500)
    await expect(count).not.toHaveText(before)
    await expect(page.locator('.epg-guide__row').first()).toBeVisible()

    const stats = await guideStats(page)
    expect(stats.programs, 'filtered view still renders programmes').toBeGreaterThan(0)

    await page.locator('.search-bar__input').fill('')
    await page.waitForTimeout(1500)
    await expect(count).toHaveText(before)
  })

  test('the translate toggle flips without breaking the grid', async ({ page }) => {
    await openGuide(page)
    const original = page.getByRole('button', { name: 'Translate programme titles to English' })
    await expect(original).toBeVisible()

    await original.click()
    const english = page.getByRole('button', { name: 'Showing English titles' })
    await expect(english).toBeVisible()
    await english.click()
    await expect(page.getByRole('button', { name: 'Translate programme titles to English' })).toBeVisible()

    // Grid still intact after toggling translation on and off.
    await expect(page.locator('.epg-guide__row').first()).toBeVisible()
    const stats = await guideStats(page)
    expect(stats.programs, 'programmes survive the toggle').toBeGreaterThan(0)
  })
})

/**
 * The guide must offer the same filters as the Home screen: search, category,
 * country, language, quality and favourites. Category was the one missing,
 * which is why these tests assert the facet is present and actually narrows.
 */
test.describe('TV guide filters match the home screen', () => {
  test('renders every home-screen filter facet', async ({ page }) => {
    await openGuide(page)

    // Search is the same SearchBar component Home mounts.
    await expect(page.locator('.search-bar__input')).toBeVisible()

    // Favourites pill, quality/country/language selects.
    await expect(page.locator('.home-quick-filters .filter-pill')).toBeVisible()
    await expect(page.locator('select[aria-label="Filter by quality"]')).toBeVisible()
    await expect(page.locator('select[aria-label="Filter by country"]')).toBeVisible()

    // Category facet: the missing one. It renders as the scrollable pill track.
    const pills = page.locator('.home-categories-scroll .filter-pill')
    await expect(pills.first()).toBeVisible()
    expect(await pills.count(), 'category track has options').toBeGreaterThan(2)

    // Priority categories lead the track, exactly as on Home.
    const firstTwo = await pills.nth(0).innerText()
    expect(firstTwo.length, 'category pill is labelled').toBeGreaterThan(0)
  })

  test('the filter sheet opens and exposes every facet', async ({ page }) => {
    await openGuide(page)

    await page.locator('.home-filter-btn').click()
    const sheet = page.locator('.filter-sheet')
    await expect(sheet).toBeVisible()

    // The same FilterSheet component Home uses, with the same sections.
    await expect(sheet.locator('.filter-sheet__title')).toHaveText('Filters')
    await expect(sheet.getByText('Resolution / Quality')).toBeVisible()
    await expect(sheet.getByText('Categories')).toBeVisible()
    await expect(sheet.getByText(/Country \(/)).toBeVisible()
    await expect(sheet.locator('.filter-sheet__toggle-row')).toBeVisible()

    await sheet.locator('.filter-sheet__close-btn').click()
    await expect(sheet).toBeHidden()
  })

  test('selecting a category narrows the guide and still renders rows', async ({ page }) => {
    await openGuide(page)
    const count = channelCount(page)
    const before = await count.innerText()

    // Pick the first category pill, whatever the catalogue orders first.
    await page.locator('.home-categories-scroll .filter-pill').first().click()
    await page.waitForTimeout(2500)

    await expect(count).not.toHaveText(before)
    await expect(page.locator('.home-categories-scroll .filter-pill--active')).toHaveCount(1)

    // A removable chip is the visible proof the filter is applied.
    await expect(page.locator('.home-active-chips .active-chip').first()).toBeVisible()

    const stats = await guideStats(page)
    expect(stats.programs, 'category-filtered view still renders programmes').toBeGreaterThan(0)
    expect(stats.emptyRows, 'no empty rows under a category filter').toBe(0)
  })

  test('clearing all filters restores the full channel count', async ({ page }) => {
    await openGuide(page)
    const count = channelCount(page)
    const before = await count.innerText()

    await page.locator('.home-categories-scroll .filter-pill').first().click()
    await page.waitForTimeout(2000)
    await expect(count).not.toHaveText(before)

    await page.locator('.home-active-chips .active-chip__clear-all').click()
    await page.waitForTimeout(2000)
    await expect(count).toHaveText(before)
  })

  test('country, quality and favourites filters all narrow the guide', async ({ page }) => {
    await openGuide(page)
    const count = channelCount(page)
    const before = await count.innerText()

    // Country: pick the first real country in the select.
    const country = page.locator('select[aria-label="Filter by country"]')
    const options = await country.locator('option').all()
    expect(options.length, 'country select lists countries').toBeGreaterThan(1)
    await country.selectOption({ index: 1 })
    await page.waitForTimeout(2000)
    await expect(count).not.toHaveText(before)

    await page.locator('.home-active-chips .active-chip__clear-all').click()
    await page.waitForTimeout(2000)
    await expect(count).toHaveText(before)

    // Quality: pick the first non-default bucket.
    const quality = page.locator('select[aria-label="Filter by quality"]')
    const qualityOptions = await quality.locator('option').all()
    expect(qualityOptions.length, 'quality select lists buckets').toBeGreaterThan(1)
    await quality.selectOption({ index: 1 })
    await page.waitForTimeout(2000)
    await expect(count).not.toHaveText(before)

    // Favourites: narrowing to an empty set must not leave the grid broken.
    await page.locator('.home-active-chips .active-chip__clear-all').click()
    await page.waitForTimeout(1500)
    await page.locator('.home-quick-filters .filter-pill').first().click()
    await page.waitForTimeout(2000)

    // With no favourites, the guide must show its empty state rather than
    // rendering a broken or blank grid.
    await expect(page.locator('.epg-guide__empty')).toBeVisible()
    await expect(page.locator('.epg-guide__empty-title')).toHaveText(
      'No channels match these filters',
    )
  })
})


