import type { BrowserContext } from '@playwright/test'
import { DEFAULT_GENERATION, scheduleFor, syntheticCatalogue } from './catalogueData'
import type { CatalogueOptions } from './catalogueData'

/**
 * In-process stand-in for the Upstash REST endpoint.
 *
 * Every real Upstash read is metered, so tests that exist to *count* reads must
 * not spend them. The mock answers `GET /get/<key>` for the ADR-0015 key scheme
 * from a synthetic catalogue and records each request by key kind.
 *
 * Interception is by URL shape (`/get/catalogue%3A...`), not by host, so it works
 * whichever Upstash URL the dev server was started with.
 */

export type KeyKind = 'meta' | 'channels' | 'streams' | 'categories' | 'epgIds' | 'schedule'

export interface RequestLog {
  kind: KeyKind
  key: string
}

export interface MockOptions extends CatalogueOptions {
  generation?: number
  pageSize?: number
}

export interface UpstashMock {
  /** Every `GET` since the last `reset()`. */
  requests: RequestLog[]
  count(kind: KeyKind): number
  /** GETs for catalogue data (everything except `meta` and schedules). */
  catalogueDataCount(): number
  reset(): void
  /** Publishes a new generation, as the sync worker does. */
  setGeneration(generation: number): void
}

const ROUTE = /\/get\/catalogue%3A/

function classify(key: string): KeyKind | null {
  if (key === 'catalogue:meta') return 'meta'
  if (/:channels:page:\d+$/.test(key)) return 'channels'
  if (/:streams:page:\d+$/.test(key)) return 'streams'
  if (/:categories$/.test(key)) return 'categories'
  if (/:epg:ids$/.test(key)) return 'epgIds'
  if (/:epg:[^:]+$/.test(key)) return 'schedule'
  return null
}

export async function installUpstashMock(
  context: BrowserContext,
  options: MockOptions = {},
): Promise<UpstashMock> {
  const { channels, streams, epgIds } = syntheticCatalogue(options)
  const pageSize = options.pageSize ?? 100
  let generation = options.generation ?? DEFAULT_GENERATION
  const pages = <T>(rows: T[]) =>
    Array.from({ length: Math.ceil(rows.length / pageSize) }, (_, i) =>
      rows.slice(i * pageSize, (i + 1) * pageSize),
    )
  const channelPages = pages(channels)
  const streamPages = pages(streams)

  const mock: UpstashMock = {
    requests: [],
    count: (kind) => mock.requests.filter((r) => r.kind === kind).length,
    catalogueDataCount: () =>
      mock.requests.filter((r) => r.kind !== 'meta' && r.kind !== 'schedule').length,
    reset: () => { mock.requests.length = 0 },
    setGeneration: (g) => { generation = g },
  }

  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
  }

  await context.route(ROUTE, async (route) => {
    const request = route.request()
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors })
      return
    }

    const key = decodeURIComponent(new URL(request.url()).pathname.replace(/^.*\/get\//, ''))
    const kind = classify(key)
    if (!kind) {
      await route.fulfill({ status: 200, headers: cors, json: { result: null } })
      return
    }
    mock.requests.push({ kind, key })

    // Keys of an old generation stay readable, as they do in Redis until they expire.
    let value: unknown = null
    if (kind === 'meta') {
      value = {
        generation,
        version: 2,
        pages: { channels: channelPages.length, streams: streamPages.length },
        syncedAt: new Date().toISOString(),
      }
    } else if (kind === 'channels') {
      value = channelPages[Number(key.split(':').pop())] ?? null
    } else if (kind === 'streams') {
      value = streamPages[Number(key.split(':').pop())] ?? null
    } else if (kind === 'categories') {
      value = [{ id: 'news', name: 'News' }]
    } else if (kind === 'epgIds') {
      value = epgIds
    } else {
      value = scheduleFor(key.split(':epg:')[1], options.endedSchedules ?? false)
    }

    await route.fulfill({
      status: 200,
      headers: cors,
      json: { result: value === null ? null : JSON.stringify(value) },
    })
  })

  return mock
}
