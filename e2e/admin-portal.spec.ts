import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'
import { installUpstashMock } from './support/upstashMock'
import { createR2Server } from './support/r2Mock'

/**
 * The picks portal at `/admin`.
 *
 * `/api/picks` is intercepted rather than served: there is deliberately no dev
 * stand-in for it in `vite.config.ts`, because a stand-in that answered without
 * an Access token would be exactly the "unauthenticated for now" route this work
 * order forbids. The endpoint's own behaviour is tested against the real handler
 * in `picks-endpoint.spec.ts`; what is tested here is what the page does with
 * each answer.
 */

const r2Server = createR2Server()

test.beforeAll(() => r2Server.listen())
test.afterAll(() => r2Server.close())

const CATALOGUE = { totalChannels: 20, guideChannels: 5 }

const CHANNELS_RESPONSE = {
  total: 3,
  limit: 40,
  results: [
    { id: 'ch1.xx', name: 'Channel 1', country: 'US', categories: ['news'], nsfw: false, closed: null, replacedBy: null, blocked: null },
    { id: 'Adult.xx', name: 'Adult Channel', country: 'US', categories: ['xxx'], nsfw: true, closed: null, replacedBy: null, blocked: null },
    { id: 'Blocked.us', name: 'Blocked Channel', country: 'US', categories: ['movies'], nsfw: false, closed: null, replacedBy: null, blocked: 'dmca' },
  ],
}

interface PortalState {
  /** Status for GET /api/picks. */
  readStatus: number
  readBody: unknown
  /** Status for PUT /api/picks. */
  writeStatus: number
  writeBody: unknown
  /** Every PUT the page made. */
  saves: { ifMatch: string | null; body: unknown }[]
}

/** Answers `/api/picks*` from `state`, and records what the page sent. */
async function installPortal(page: Page, state: PortalState) {
  await page.route('**/api/picks**', async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

    if (url.pathname === '/api/picks/channels') return respond(200, CHANNELS_RESPONSE)

    if (request.method() === 'GET') return respond(state.readStatus, state.readBody)

    state.saves.push({
      ifMatch: request.headers()['if-match'] ?? null,
      body: JSON.parse(request.postData() ?? 'null'),
    })
    return respond(state.writeStatus, state.writeBody)
  })
}

function freshState(overrides: Partial<PortalState> = {}): PortalState {
  return {
    readStatus: 200,
    readBody: { picks: null, etag: null },
    writeStatus: 200,
    writeBody: { ok: true, updatedAt: '2026-09-22T09:00:00.000Z', etag: '"new"', warnings: [], counts: { groups: 1, items: 1 } },
    saves: [],
    ...overrides,
  }
}

test.beforeEach(({ context }) => {
  r2Server.reset(CATALOGUE)
  return r2Server.route(context)
})

test('the portal is not linked from anywhere in the app', async ({ page, context }) => {
  await installUpstashMock(context, CATALOGUE)
  await page.goto('/')
  await expect(page.locator('body')).toContainText('Channel', { timeout: 60_000 })
  await expect(page.locator('a[href*="/admin"]')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('Picks portal')
})

test('the page asks a crawler not to index it', async ({ page, context }) => {
  await installUpstashMock(context, CATALOGUE)
  await installPortal(page, freshState())
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: 'Picks portal' })).toBeVisible()
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/)
})

test('a 401 says the browser is not signed in, and offers nothing else', async ({ page, context }) => {
  await installUpstashMock(context, CATALOGUE)
  await installPortal(page, freshState({ readStatus: 401, readBody: { error: 'unauthorised' } }))
  await page.goto('/admin')
  await expect(page.locator('body')).toContainText('not signed in through Cloudflare Access')
  await expect(page.getByRole('button', { name: 'Save picks' })).toHaveCount(0)
})

test('a 503 names what the owner has to configure', async ({ page, context }) => {
  await installUpstashMock(context, CATALOGUE)
  await installPortal(
    page,
    freshState({
      readStatus: 503,
      readBody: { error: 'storage-not-configured', detail: 'Bind the streamloom-catalogue R2 bucket as CATALOGUE_BUCKET.' },
    }),
  )
  await page.goto('/admin')
  await expect(page.locator('body')).toContainText('CATALOGUE_BUCKET')
  await expect(page.getByRole('button', { name: 'Save picks' })).toHaveCount(0)
})

test('build a group, add a channel, write a note, save', async ({ page, context }) => {
  await installUpstashMock(context, CATALOGUE)
  const state = freshState()
  await installPortal(page, state)
  await page.goto('/admin')

  await page.getByLabel('New group title').fill('Editor picks')
  await page.getByRole('button', { name: 'Add group' }).click()
  await expect(page.getByRole('heading', { name: 'Editor picks' })).toBeVisible()

  await page.getByLabel('Name or id').fill('channel')
  await page.getByRole('button', { name: 'Add', exact: true }).first().click()

  await page.getByPlaceholder('Note (optional)').fill('Always on')
  await page.getByRole('button', { name: 'Save picks' }).click()

  await expect(page.locator('body')).toContainText('Saved at')
  expect(state.saves).toHaveLength(1)
  expect(state.saves[0].body).toEqual({
    schema: 1,
    groups: [{ title: 'Editor picks', items: [{ channelId: 'ch1.xx', note: 'Always on', rank: 0 }] }],
  })
})

test('a blocklisted or NSFW channel is visible with its flags but cannot be pinned', async ({
  page,
  context,
}) => {
  await installUpstashMock(context, CATALOGUE)
  await installPortal(page, freshState())
  await page.goto('/admin')

  await page.getByLabel('New group title').fill('Any')
  await page.getByRole('button', { name: 'Add group' }).click()
  await page.getByLabel('Name or id').fill('channel')

  const nsfw = page.locator('.admin__result', { hasText: 'Adult Channel' })
  await expect(nsfw).toContainText('NSFW')
  await expect(nsfw.getByRole('button', { name: 'Not allowed' })).toBeDisabled()

  const blocked = page.locator('.admin__result', { hasText: 'Blocked Channel' })
  await expect(blocked).toContainText('blocklisted (dmca)')
  await expect(blocked.getByRole('button', { name: 'Not allowed' })).toBeDisabled()
})

test('a pick shows whether it is live or pending until the next sync', async ({ page, context }) => {
  await installUpstashMock(context, CATALOGUE)
  await installPortal(
    page,
    freshState({
      readBody: {
        picks: {
          schema: 1,
          updatedAt: '2026-09-01T00:00:00.000Z',
          groups: [
            { title: 'Mixed', items: [{ channelId: 'ch1.xx', rank: 0 }, { channelId: 'never-synced.zz', rank: 1 }] },
          ],
        },
        etag: '"current"',
      },
    }),
  )
  await page.goto('/admin')

  const live = page.locator('.admin__pick', { hasText: 'Channel 1' })
  await expect(live).toContainText('in the live generation')
  const pending = page.locator('.admin__pick', { hasText: 'never-synced.zz' })
  await expect(pending).toContainText('pending until the next sync')
})

test('the ETag read is sent back as If-Match, and removal is the only way a pin ends', async ({
  page,
  context,
}) => {
  await installUpstashMock(context, CATALOGUE)
  const state = freshState({
    readBody: {
      picks: {
        schema: 1,
        groups: [{ title: 'Mixed', items: [{ channelId: 'ch1.xx', rank: 0 }, { channelId: 'ch2.xx', rank: 1 }] }],
      },
      etag: '"current"',
    },
  })
  await installPortal(page, state)
  await page.goto('/admin')

  await page.locator('.admin__pick', { hasText: 'Channel 1' }).getByRole('button', { name: /^Remove/ }).click()
  await page.getByRole('button', { name: 'Save picks' }).click()
  await expect(page.locator('body')).toContainText('Saved at')

  expect(state.saves[0].ifMatch).toBe('"current"')
  expect(state.saves[0].body).toEqual({
    schema: 1,
    groups: [{ title: 'Mixed', items: [{ channelId: 'ch2.xx', rank: 0 }] }],
  })
})

test('a 412 loads the newer copy instead of overwriting it', async ({ page, context }) => {
  await installUpstashMock(context, CATALOGUE)
  const state = freshState({
    readBody: { picks: { schema: 1, groups: [{ title: 'Mine', items: [{ channelId: 'ch1.xx', rank: 0 }] }] }, etag: '"stale"' },
    writeStatus: 412,
    writeBody: {
      error: 'conflict',
      detail: 'picks.json changed since you read it.',
      etag: '"newer"',
      picks: { schema: 1, updatedAt: '2026-09-22T10:00:00.000Z', groups: [{ title: 'Theirs', items: [] }] },
    },
  })
  await installPortal(page, state)
  await page.goto('/admin')

  await page.getByRole('button', { name: 'Save picks' }).click()

  await expect(page.locator('body')).toContainText('changed since you read it')
  // The newer copy replaced the editor's, rather than the save silently winning.
  await expect(page.getByRole('heading', { name: 'Theirs' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Mine' })).toHaveCount(0)
  expect(state.saves).toHaveLength(1)
})

test('a warning from the server is shown after a save', async ({ page, context }) => {
  await installUpstashMock(context, CATALOGUE)
  await installPortal(
    page,
    freshState({
      readBody: { picks: { schema: 1, groups: [{ title: 'Old', items: [{ channelId: 'ch1.xx', rank: 0 }] }] }, etag: '"e"' },
      writeBody: {
        ok: true,
        updatedAt: '2026-09-22T09:00:00.000Z',
        etag: '"new"',
        warnings: ['"OldNews.us" is marked closed upstream (2024-01-01); pinning it anyway'],
        counts: { groups: 1, items: 1 },
      },
    }),
  )
  await page.goto('/admin')
  await page.getByRole('button', { name: 'Save picks' }).click()
  await expect(page.locator('body')).toContainText('marked closed upstream')
})
