import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { installUpstashMock } from './support/upstashMock'
import type { UpstashMock } from './support/upstashMock'
import { DEFAULT_GENERATION } from './support/catalogueData'
import { createR2Server, readGolden } from './support/r2Mock'
import type { R2Kind } from './support/r2Mock'
import {
  decodeCatalogue,
  decodeEpg,
  decodeEpgIds,
  epgUrl,
  isSnapshotChannelId,
  parseMeta,
} from '../src/api/r2Contract'
import { enrichChannels } from '../src/util/enrich'

/**
 * Catalogue read path: R2 snapshots first, Redis as the fallback (ADR-0030).
 *
 * R2 is a real local HTTP server serving brotli (e2e/support/r2Mock.ts), Redis the
 * in-process Upstash mock, so every test can say which store answered from request
 * counts, and none touches a real bucket or spends metered Upstash reads.
 */

const r2Server = createR2Server()
/** The R2 mock; the server behind it is reset to a healthy synthetic catalogue before every test. */
const r2 = r2Server.mock

test.beforeAll(() => r2Server.listen())
test.afterAll(() => r2Server.close())
test.beforeEach(({ context }) => {
  r2Server.reset()
  return r2Server.route(context)
})

/** Generation the Redis mock publishes when a test wants it to differ from R2's. */
const REDIS_GENERATION = DEFAULT_GENERATION - 500

async function waitForChannels(page: Page) {
  await expect(page.locator('body')).toContainText('Channel', { timeout: 60_000 })
}

/** Resolves once no request has reached either store for `quietMs`. */
async function settle(page: Page, redis: UpstashMock, quietMs = 2_000) {
  let last = -1
  let stableSince = Date.now()
  for (let waited = 0; waited < 60_000; waited += 250) {
    const seen = r2.requests.length + redis.requests.length
    if (seen !== last) {
      last = seen
      stableSince = Date.now()
    } else if (Date.now() - stableSince >= quietMs) {
      return
    }
    await page.waitForTimeout(250)
  }
  throw new Error('catalogue reads never settled')
}

/** Generation of the catalogue record persisted in IndexedDB, once it lands. */
async function storedGeneration(page: Page): Promise<number | null> {
  return page.evaluate(
    () =>
      new Promise<number | null>((resolve) => {
        const open = indexedDB.open('streamloom')
        open.onerror = () => resolve(null)
        open.onsuccess = () => {
          const db = open.result
          if (!db.objectStoreNames.contains('catalogue')) {
            db.close()
            resolve(null)
            return
          }
          const req = db.transaction('catalogue').objectStore('catalogue').get('current')
          req.onsuccess = () => {
            db.close()
            resolve((req.result?.generation as number | undefined) ?? null)
          }
          req.onerror = () => {
            db.close()
            resolve(null)
          }
        }
      }),
  )
}

async function catalogueStoredAs(page: Page, generation: number) {
  await expect
    .poll(() => storedGeneration(page), { timeout: 30_000, message: 'catalogue never reached IndexedDB' })
    .toBe(generation)
}

function report(label: string, redis: UpstashMock) {
  const kinds = ['meta', 'channels', 'streams', 'categories', 'epgIds', 'schedule'] as const
  const parts = kinds.map((k) => `${k}=${r2.count(k)}`).join(' ')
  console.log(`[r2] ${label}: requests=${r2.requests.length} bytes=${r2.bytes()} ${parts} | redis=${redis.requests.length}`)
}

// ---- The golden fixture, through the real client code ----

test.describe('r2-golden.json', () => {
  const golden = readGolden()
  const body = (key: string): unknown => JSON.parse(golden['catalogue/' + key].body)

  test('decodes through the real DTOs and the real enrichment', () => {
    const meta = parseMeta(body('meta.json'))
    expect(meta).not.toBeNull()
    if (!meta) return
    expect(meta.generation).toBe(1757000000000)

    const dir = `g${meta.generation}/`
    const catalogue = decodeCatalogue(meta, {
      channels: body(dir + 'channels.json.br'),
      streams: body(dir + 'streams.json.br'),
      categories: body(dir + 'categories.json.br'),
    })
    expect(catalogue).not.toBeNull()
    if (!catalogue) return
    expect(catalogue.channels.map((c) => c.id)).toEqual(['AlphaNews.in', 'BetaSports.in', 'GammaWorld.uk'])
    expect(catalogue.categories).toEqual([
      { id: 'news', name: 'News' },
      { id: 'sports', name: 'Sports' },
    ])
    // Fields the UI reads, not merely the ids.
    expect(catalogue.channels[0]).toMatchObject({
      name: 'Alpha News',
      country: 'IN',
      is_active: true,
      languages: ['hin'],
      channel_categories: [{ category_id: 'news' }],
    })
    expect(catalogue.streams[0]).toMatchObject({
      channel_id: 'AlphaNews.in',
      url: 'https://example.test/alpha.m3u8',
      quality: '720p',
      status: 'active',
    })

    const enriched = enrichChannels(catalogue.channels, catalogue.streams, {})
    const alpha = enriched.find((c) => c.id === 'AlphaNews.in')
    expect(alpha?.streams.map((s) => s.url)).toEqual(['https://example.test/alpha.m3u8'])
    expect(alpha?.categoryIds).toEqual(['news'])

    const ids = decodeEpgIds(body(dir + 'epg/ids.json.br'))
    expect(ids).toEqual(['AlphaNews.in', 'GammaWorld.uk'])
    expect(meta.counts.epgChannels).toBe(ids?.length)
    for (const id of ids ?? []) {
      const programs = decodeEpg(body(dir + `epg/${id}.json.br`))
      expect(programs?.length).toBeGreaterThan(0)
      expect(programs?.every((p) => p.channel_id === id)).toBe(true)
    }
  })

  test('keeps the headers the client relies on, and only that contract', () => {
    for (const [key, object] of Object.entries(golden)) {
      if (key === 'catalogue/meta.json') {
        expect(object.contentEncoding).toBeNull()
        expect(object.cacheControl).toContain('max-age=60')
      } else {
        expect(object.contentEncoding).toBe('br')
        expect(object.cacheControl).toBe('public, max-age=31536000, immutable')
      }
      expect(object.contentType).toBe('application/json')
    }
  })

  test('refuses a meta of an unknown version or layout, and rows that disagree with its counts', () => {
    const good = body('meta.json') as Record<string, unknown>
    expect(parseMeta({ ...good, version: 3 })).toBeNull()
    expect(parseMeta({ ...good, layout: 2 })).toBeNull()
    expect(parseMeta({ ...good, generation: -1 })).toBeNull()
    expect(parseMeta({ ...good, counts: undefined })).toBeNull()
    expect(parseMeta('nope')).toBeNull()

    const meta = parseMeta(good)!
    const dir = `g${meta.generation}/`
    const channels = body(dir + 'channels.json.br') as unknown[]
    expect(
      decodeCatalogue(meta, {
        channels: channels.slice(0, -1),
        streams: body(dir + 'streams.json.br'),
        categories: body(dir + 'categories.json.br'),
      }),
    ).toBeNull()
    expect(
      decodeCatalogue(meta, {
        channels: [{ id: 1 }, ...channels.slice(1)],
        streams: body(dir + 'streams.json.br'),
        categories: body(dir + 'categories.json.br'),
      }),
    ).toBeNull()
  })

  test('builds a URL only for a channel id that can be an object key', () => {
    const base = 'https://cdn.example'
    expect(epgUrl(base, 5, 'AlphaNews.in')).toBe('https://cdn.example/catalogue/g5/epg/AlphaNews.in.json.br')
    expect(epgUrl(base, 5, 'Name.cc@HD')).toBe('https://cdn.example/catalogue/g5/epg/Name.cc@HD.json.br')
    for (const id of ['ids', 'a/b', 'a%2Fb', 'a b', 'a?b', '.hidden', '']) {
      expect(isSnapshotChannelId(id)).toBe(false)
      expect(epgUrl(base, 5, id)).toBeNull()
    }
  })
})

// ---- The browser, against the two stores ----

/**
 * Every Home load also reads `catalogue/picks.json` (ADR-0033): one small,
 * generation-independent object, 404 until the owner has ever saved. It is
 * counted here so the read budget stays honest, and excluded from the
 * generation assertions below, which are about the snapshot objects.
 */
const PLAIN_OBJECTS: R2Kind[] = ['meta', 'picks']
const generationKinds = () =>
  r2.requests.filter((r) => !PLAIN_OBJECTS.includes(r.kind))

test.describe('R2 first, then Redis', () => {
  test('cold load reads only R2: meta, three bulk objects and the guide index', async ({ page, context }) => {
    const redis = await installUpstashMock(context)
    await page.goto('/')
    await waitForChannels(page)
    await catalogueStoredAs(page, DEFAULT_GENERATION)
    await settle(page, redis)
    report('cold load', redis)

    expect(r2.count('meta')).toBe(1)
    expect(r2.count('channels')).toBe(1)
    expect(r2.count('streams')).toBe(1)
    expect(r2.count('categories')).toBe(1)
    expect(r2.count('epgIds')).toBe(1)
    expect(r2.count('schedule')).toBe(0)
    expect(r2.count('countries')).toBe(0)
    // One request for picks.json, which has never been published: a 404, not a failure.
    expect(r2.count('picks')).toBe(1)
    expect(r2.requests.length).toBe(6)
    expect(r2.requests.filter((r) => r.kind !== 'picks').every((r) => r.status === 200)).toBe(true)
    expect(redis.requests.length).toBe(0)
  })

  test('the browser decodes the brotli objects itself', async ({ page, context }) => {
    await installUpstashMock(context)
    await page.goto('/')
    await waitForChannels(page)
    const bulk = generationKinds()
    expect(bulk.length).toBeGreaterThan(0)
    // Every generation object went out brotli-encoded; the page rendered channels from them.
    expect(r2.bytes()).toBeGreaterThan(0)
    expect(bulk.every((r) => r.status === 200)).toBe(true)
  })

  test('a repeat load on an unchanged generation makes one small request', async ({ page, context }) => {
    const redis = await installUpstashMock(context)
    await page.goto('/')
    await waitForChannels(page)
    await catalogueStoredAs(page, DEFAULT_GENERATION)
    await settle(page, redis)

    r2.resetRequests()
    await page.reload()
    await waitForChannels(page)
    await settle(page, redis)
    report('repeat load, same generation', redis)

    expect(r2.requests.map((r) => r.kind).sort()).toEqual(['meta', 'picks'])
    expect(redis.requests.length).toBe(0)
  })

  test('a new generation downloads only the objects of that generation', async ({ page, context }) => {
    const redis = await installUpstashMock(context)
    await page.goto('/')
    await waitForChannels(page)
    await catalogueStoredAs(page, DEFAULT_GENERATION)
    await settle(page, redis)

    const next = DEFAULT_GENERATION + 999_999
    r2.setGeneration(next)
    r2.resetRequests()
    await page.reload()
    await waitForChannels(page)
    await catalogueStoredAs(page, next)
    await settle(page, redis)
    report('repeat load, new generation', redis)

    expect(generationKinds().every((r) => r.path.startsWith(`g${next}/`))).toBe(true)
    expect(r2.count('channels')).toBe(1)
    expect(r2.count('streams')).toBe(1)
    expect(r2.count('categories')).toBe(1)
    expect(redis.requests.length).toBe(0)
  })

  test('the guide reads schedules from R2, one object per visible channel', async ({ page, context }) => {
    const redis = await installUpstashMock(context)
    await page.goto('/guide')
    await expect(page.locator('.epg-guide__row').first()).toBeVisible({ timeout: 60_000 })
    await expect
      .poll(() => page.locator('.epg-guide__program').count(), { timeout: 60_000 })
      .toBeGreaterThan(0)
    await settle(page, redis)
    report('guide open', redis)

    expect(r2.count('schedule')).toBeGreaterThan(0)
    expect(r2.count('schedule')).toBeLessThan(526)
    expect(redis.requests.length).toBe(0)
  })

  test('R2 unreachable: the whole catalogue comes from Redis', async ({ page, context }) => {
    const redis = await installUpstashMock(context, { generation: REDIS_GENERATION })
    r2.fail('all', 'reset')
    await page.goto('/')
    await waitForChannels(page)
    await catalogueStoredAs(page, REDIS_GENERATION)
    await settle(page, redis)
    report('R2 down', redis)
    expect(r2.count('meta')).toBeGreaterThan(0)

    expect(redis.count('meta')).toBeGreaterThanOrEqual(1)
    expect(redis.count('channels')).toBe(6)
    expect(redis.count('streams')).toBe(9)
    expect(redis.count('categories')).toBe(1)
  })

  test('R2 answers 503: falls through to Redis', async ({ page, context }) => {
    const redis = await installUpstashMock(context, { generation: REDIS_GENERATION })
    r2.fail('all', 'status')
    await page.goto('/')
    await waitForChannels(page)
    await catalogueStoredAs(page, REDIS_GENERATION)
    expect(r2.count('meta')).toBeGreaterThan(0)
    expect(redis.count('channels')).toBe(6)
  })

  test('one R2 object failing mid-load restarts from Redis and never mixes generations', async ({ page, context }) => {
    const redis = await installUpstashMock(context, { generation: REDIS_GENERATION })
    r2.fail('streams', 'status')
    await page.goto('/')
    await waitForChannels(page)
    // The catalogue is Redis's, whole: R2 named a newer generation but nothing of it is kept.
    await catalogueStoredAs(page, REDIS_GENERATION)
    await settle(page, redis)

    expect(r2.count('meta')).toBe(1)
    expect(redis.count('channels')).toBe(6)
    expect(redis.count('streams')).toBe(9)
    // Schedules follow the generation that was loaded, not the one R2 named. A
    // schedule can still be *tried* on R2 first (isSnapshotChannelId, source
    // unresolved) before falling through, so the invariant is checked on
    // whichever store actually answered, not on redis alone.
    await page.goto('/guide')
    await expect
      .poll(() => page.locator('.epg-guide__program').count(), { timeout: 60_000 })
      .toBeGreaterThan(0)
    const scheduleRequests = [
      ...redis.requests.filter((r) => r.kind === 'schedule').map((r) => r.key),
      ...r2.requests.filter((r) => r.kind === 'schedule').map((r) => r.path),
    ]
    expect(scheduleRequests.length).toBeGreaterThan(0)
    expect(scheduleRequests.every((k) => k.includes(`g${REDIS_GENERATION}`))).toBe(true)
    expect(scheduleRequests.some((k) => k.includes(`g${DEFAULT_GENERATION}`))).toBe(false)
  })

  test('reopening the guide on a reload never mixes the cached generation with a background refresh', async ({
    page,
    context,
  }) => {
    // Same fallback as above, but this time the guide is opened on a *fresh page
    // load* that already has the Redis generation cached in IndexedDB. That load
    // renders the cached catalogue immediately while a background refresh reads
    // R2's meta.json (naming the newer, still-unreadable generation) before its
    // own fallback to Redis resolves. Schedules must still follow the generation
    // actually on screen, not whichever one the background refresh's pointer read
    // named in that window.
    const redis = await installUpstashMock(context, { generation: REDIS_GENERATION })
    r2.fail('streams', 'status')
    await page.goto('/')
    await waitForChannels(page)
    await catalogueStoredAs(page, REDIS_GENERATION)
    await settle(page, redis)

    redis.reset()
    r2.resetRequests()

    await page.goto('/guide')
    await expect
      .poll(() => page.locator('.epg-guide__program').count(), { timeout: 60_000 })
      .toBeGreaterThan(0)
    await settle(page, redis)

    // Whichever store actually answers a schedule request (R2 will still be tried
    // first when the ambient store-selection pointer hasn't caught up yet), the
    // generation named in every one of those requests must be the one on screen,
    // never the newer one the background refresh's meta read is chasing.
    const scheduleRequests = [
      ...redis.requests.filter((r) => r.kind === 'schedule').map((r) => r.key),
      ...r2.requests.filter((r) => r.kind === 'schedule').map((r) => r.path),
    ]
    expect(scheduleRequests.length).toBeGreaterThan(0)
    expect(scheduleRequests.every((k) => k.includes(`g${REDIS_GENERATION}`))).toBe(true)
    expect(scheduleRequests.some((k) => k.includes(`g${DEFAULT_GENERATION}`))).toBe(false)
  })

  for (const [label, fault] of [
    ['malformed brotli', 'garbage'],
    ['an object that disagrees with meta.counts', 'short'],
    ['a missing object (404)', 'notfound'],
  ] as const) {
    test(`${label}: falls through to Redis`, async ({ page, context }) => {
      const redis = await installUpstashMock(context, { generation: REDIS_GENERATION })
      r2.fail('channels', fault)
      await page.goto('/')
      await waitForChannels(page)
      await catalogueStoredAs(page, REDIS_GENERATION)
      expect(r2.count('channels')).toBeGreaterThan(0)
      expect(redis.count('channels')).toBe(6)
    })
  }

  for (const [label, patch] of [
    ['an unknown version', { version: 3 }],
    ['an unknown layout', { layout: 2 }],
  ] as const) {
    test(`${label} in meta.json is refused: falls through to Redis`, async ({ page, context }) => {
      const redis = await installUpstashMock(context, { generation: REDIS_GENERATION })
      r2.patchMeta(patch)
      await page.goto('/')
      await waitForChannels(page)
      await catalogueStoredAs(page, REDIS_GENERATION)
      expect(r2.count('meta')).toBeGreaterThan(0)
      // Nothing beyond meta and the generation-independent picks object was
      // downloaded from a snapshot this client cannot read.
      expect(generationKinds()).toEqual([])
      expect(redis.count('channels')).toBe(6)
    })
  }

  test('a fallback that finds the held generation downloads nothing on the next start', async ({ page, context }) => {
    // R2 names a generation whose objects cannot be read (say retired under a live meta),
    // while Redis is on an older one. The first load takes Redis's catalogue; every later
    // start must see that it already holds Redis's generation instead of re-reading it.
    const redis = await installUpstashMock(context, { generation: REDIS_GENERATION })
    r2.fail('streams', 'notfound')
    await page.goto('/')
    await waitForChannels(page)
    await catalogueStoredAs(page, REDIS_GENERATION)
    await settle(page, redis)
    expect(redis.count('channels')).toBe(6)

    redis.reset()
    r2.resetRequests()
    await page.reload()
    await waitForChannels(page)
    await settle(page, redis)
    report('repeat load, R2 generation unreadable', redis)

    expect(redis.catalogueDataCount()).toBe(0)
    expect(redis.count('meta')).toBe(1)
    expect(await storedGeneration(page)).toBe(REDIS_GENERATION)
  })

  test('one schedule object failing does not push the other rows to Redis', async ({ page, context }) => {
    const redis = await installUpstashMock(context)
    r2.failPath(/\/epg\/ch3\.xx\.json\.br$/, 'status')
    await page.goto('/guide')
    await expect(page.locator('.epg-guide__row').first()).toBeVisible({ timeout: 60_000 })
    await expect
      .poll(() => page.locator('.epg-guide__program').count(), { timeout: 60_000 })
      .toBeGreaterThan(0)
    await settle(page, redis)
    report('guide open, one bad schedule', redis)

    expect(r2.requests.some((r) => r.path.endsWith('/ch3.xx.json.br') && r.status === 503)).toBe(true)
    expect(r2.requests.filter((r) => r.kind === 'schedule' && r.status === 200).length).toBeGreaterThanOrEqual(10)
    // Only the failed channel is read from Redis (metered); the rest stay on R2.
    expect(redis.count('schedule')).toBeLessThanOrEqual(1)
  })

  test('a schedule missing from R2 is read from Redis for the same generation', async ({ page, context }) => {
    const redis = await installUpstashMock(context)
    r2.fail('schedule', 'notfound')
    await page.goto('/guide')
    await expect(page.locator('.epg-guide__row').first()).toBeVisible({ timeout: 60_000 })
    await expect
      .poll(() => page.locator('.epg-guide__program').count(), { timeout: 60_000 })
      .toBeGreaterThan(0)
    await settle(page, redis)

    expect(r2.count('schedule')).toBeGreaterThan(0)
    expect(redis.count('schedule')).toBeGreaterThan(0)
    expect(redis.requests.every((r) => r.kind !== 'schedule' || r.key.startsWith(`catalogue:g${DEFAULT_GENERATION}:`))).toBe(true)
  })

  test('R2 and Redis both down: the existing retry state, not a blank page', async ({ page, context }) => {
    // Registered after (and so ahead of) any Upstash mock: every Redis read fails.
    await context.route(/\/get\//, (route) => route.abort())
    r2.fail('all', 'reset')
    await page.goto('/')
    await expect(page.getByText(/couldn't load channels/i).first()).toBeVisible({ timeout: 60_000 })
    expect(r2.requests.length).toBeGreaterThan(0)
  })
})
