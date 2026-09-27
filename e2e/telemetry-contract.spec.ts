import { test, expect } from '@playwright/test'
import * as contract from '../functions/api/_lib/telemetryContract'
import { streamKey } from '../src/telemetry/streamKey'
import golden from './support/telemetry-golden.json' with { type: 'json' }

/**
 * The TypeScript port of `sync-worker/telemetry-contract.js`, checked constant by constant and
 * example by example against `telemetry-golden.json` — the fixture the backend emits from its
 * own copy of the contract (its `docs/telemetry/events.md`, "Copying the golden fixture"). A
 * port that drifts from the reference fails here, event by event, rather than silently changing
 * what `/api/t` accepts or what the dashboard prints.
 *
 * No browser is involved: these call the modules directly, the way `picks-endpoint.spec.ts`
 * does for the Function handlers.
 */

const constants = golden.constants as Record<string, unknown>

test.describe('constants and regexes match the golden fixture', () => {
  for (const [name, value] of Object.entries(constants)) {
    test(name, () => {
      const ours = (contract as unknown as Record<string, unknown>)[name]
      expect(ours, `${name} is exported`).not.toBeUndefined()
      expect(JSON.parse(JSON.stringify(ours))).toEqual(value)
    })
  }

  for (const [name, source] of Object.entries(golden.regexes)) {
    test(`${name} source`, () => {
      const ours = (contract as unknown as Record<string, RegExp>)[name]
      expect(ours).toBeInstanceOf(RegExp)
      expect(ours.source).toBe(source)
    })
  }
})

test.describe('validateBatch', () => {
  test('accepts the valid batch with every event intact', () => {
    const { batch, result } = golden.examples.validBatch
    expect(contract.validateBatch(batch)).toEqual(result)
    // The raw JSON text takes the same path a request body does.
    expect(contract.validateBatch(JSON.stringify(batch))).toEqual(result)
  })

  test('drops an unknown channel id and keeps the rest of the batch', () => {
    const { batch, activeChannelIds, result } = golden.examples.droppedChannel
    expect(contract.validateBatch(batch, { activeChannelIds: new Set(activeChannelIds) })).toEqual(result)
  })

  for (const { why, batch, result } of golden.examples.refusedBatches) {
    test(`refuses ${why}: ${result.reason}`, () => {
      expect(contract.validateBatch(batch)).toEqual(result)
    })
  }

  test('an over-size raw body is refused before it is parsed', () => {
    const text = '{"v":1,"p":"web","a":"1.0","b":[' + '{"e":"guide_open"},'.repeat(200) + '{"e":"guide_open"}]}'
    expect(contract.byteLength(text)).toBeGreaterThan(contract.MAX_BATCH_BYTES)
    expect(contract.validateBatch(text)).toEqual({ ok: false, reason: `over ${contract.MAX_BATCH_BYTES} bytes` })
  })

  test('text that is not JSON is refused as such', () => {
    expect(contract.validateBatch('{"v":1,')).toEqual({ ok: false, reason: 'not JSON' })
  })

  test('byteLength counts UTF-8 bytes, not code units', () => {
    expect(contract.byteLength('abc')).toBe(3)
    expect(contract.byteLength('é')).toBe(2)
    expect(contract.byteLength('€')).toBe(3)
    expect(contract.byteLength('😀')).toBe(4)
  })
})

test.describe('appOpenFlags', () => {
  for (const example of golden.examples.appOpenFlags) {
    test(`last=${JSON.stringify(example.last)} now=${example.now} → "${example.flags}"`, () => {
      expect(contract.appOpenFlags(example.last, example.now)).toEqual({ flags: example.flags, next: example.next })
    })
  }
})

test.describe('waePoint', () => {
  test('lays out every accepted event of the valid batch exactly as the fixture', () => {
    const verdict = contract.validateBatch(golden.examples.validBatch.batch)
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    const points = verdict.events.map((event) =>
      contract.waePoint(event, {
        platform: verdict.platform,
        appVersion: verdict.appVersion,
        country: 'IN',
        region: 'MH',
      }),
    )
    expect(points).toEqual(golden.examples.waePoints)
  })

  test('folds an unusable country or region into the markers rather than storing garbage', () => {
    const point = contract.waePoint(
      { e: 'guide_open' },
      { platform: 'web', appVersion: '1.0', country: 'T1', region: 'lower' },
    )
    expect(point.blobs[3]).toBe(contract.FOLDED_COUNTRY)
    expect(point.blobs[4]).toBe(contract.FOLDED_REGION)
    const missing = contract.waePoint({ e: 'guide_open' }, { platform: 'web', appVersion: '1.0', country: undefined, region: null })
    expect(missing.blobs[3]).toBe('ZZ')
    expect(missing.blobs[4]).toBe('*')
  })
})

test.describe('buckets and labels', () => {
  for (const [kind, labels] of Object.entries(golden.examples.bucketLabels)) {
    test(`${kind} labels`, () => {
      const ours = labels.map((_, i) => contract.bucketLabel(kind as contract.BucketKind, i))
      expect(ours).toEqual(labels)
    })
  }

  test('bucketOf follows the edges, below and above', () => {
    expect(contract.latencyBucket(0)).toBe(0)
    expect(contract.latencyBucket(99.9)).toBe(0)
    expect(contract.latencyBucket(100)).toBe(1)
    expect(contract.latencyBucket(15000)).toBe(8)
    expect(contract.watchBucket(0.5)).toBe(0)
    expect(contract.watchBucket(3600)).toBe(6)
    expect(contract.ratioBucket(0)).toBe(0)
    expect(contract.ratioBucket(0.25)).toBe(7)
    expect(() => contract.bucketOf(Number.NaN, contract.LATENCY_EDGES_MS)).toThrow(TypeError)
  })

  test('percentileFromBuckets returns an upper bound, Infinity past the last edge, null when empty', () => {
    const edges = contract.LATENCY_EDGES_MS
    expect(contract.percentileFromBuckets([0, 0, 0, 0, 0, 0, 0, 0, 0], edges, 0.5)).toBeNull()
    // 10 in bucket 0, 10 in bucket 3: p50 is reached in bucket 0 → 100; p95 in bucket 3 → 1000.
    expect(contract.percentileFromBuckets([10, 0, 0, 10, 0, 0, 0, 0, 0], edges, 0.5)).toBe(100)
    expect(contract.percentileFromBuckets([10, 0, 0, 10, 0, 0, 0, 0, 0], edges, 0.95)).toBe(1000)
    expect(contract.percentileFromBuckets([0, 0, 0, 0, 0, 0, 0, 0, 5], edges, 0.5)).toBe(Infinity)
  })
})

test.describe('foldGeo', () => {
  test('folds the fixture day into exactly the daily_geo rows the rollup wrote', () => {
    const rows = new Map<string, contract.GeoRow>()
    for (const r of golden.rollup.results.geo) {
      const key = `${r.platform}\t${r.country}\t${r.region}`
      const cur = rows.get(key) ?? {
        platform: r.platform,
        country: r.country,
        region: r.region,
        app_opens: 0,
        plays: 0,
        play_fails: 0,
      }
      if (r.event === 'app_open') cur.app_opens += r.n
      else if (r.event === 'play') cur.plays += r.n
      else if (r.event === 'play_fail') cur.play_fails += r.n
      rows.set(key, cur)
    }
    const folded = contract.foldGeo([...rows.values()])
    const expected = golden.rollup.tables.daily_geo.map(({ day: _day, ...rest }) => rest)
    expect(folded).toEqual(expected)
  })

  test('never leaves a region or country under K_ANON un-folded', () => {
    const folded = contract.foldGeo([
      { platform: 'web', country: 'FR', region: 'IDF', app_opens: 19, plays: 5, play_fails: 1 },
      { platform: 'web', country: 'DE', region: 'BE', app_opens: 21, plays: 0, play_fails: 0 },
      { platform: 'web', country: 'DE', region: 'BY', app_opens: 2, plays: 9, play_fails: 0 },
    ])
    for (const row of folded) {
      if (row.country !== contract.FOLDED_COUNTRY && row.region !== contract.FOLDED_REGION) {
        expect(row.app_opens).toBeGreaterThanOrEqual(contract.K_ANON)
      }
    }
    expect(folded).toEqual([
      { platform: 'web', country: 'DE', region: '*', app_opens: 2, plays: 9, play_fails: 0 },
      { platform: 'web', country: 'DE', region: 'BE', app_opens: 21, plays: 0, play_fails: 0 },
      { platform: 'web', country: 'ZZ', region: '*', app_opens: 19, plays: 5, play_fails: 1 },
    ])
  })
})

test.describe('healthReports', () => {
  test('lists the fixture day the way the rollup did', () => {
    const rows = golden.rollup.results.health.map((r) => ({
      streamKey: r.stream_key,
      channelId: r.channel_id,
      hour: r.hour,
      n: r.n,
    }))
    const reports = contract.healthReports(rows, {
      pinned: new Set(['PinnedOne.in']),
      now: golden.rollup.reports.generatedAt,
    })
    expect(reports).toEqual(golden.rollup.reports)
  })
})

test.describe('streamKey (the client side of the contract)', () => {
  for (const [url, key] of Object.entries(golden.examples.streamKeys)) {
    test(`${url} → ${key}`, async () => {
      expect(await streamKey(url)).toBe(key)
      expect(contract.STREAM_KEY_RE.test(key)).toBe(true)
    })
  }
})
