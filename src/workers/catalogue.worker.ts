/**
 * Catalogue worker.
 *
 * Fetches the catalogue (R2, then Redis), parses the payloads and joins channels
 * with their streams off the main thread. Parsing several MB of JSON and walking
 * ~40k rows was the largest main-thread cost on a cold load, so it happens here
 * and only the finished arrays are handed back.
 */

import { fetchCatalogue, fetchEpgIds } from '../api/catalogueSource'
import type { CatalogueGeneration, CatalogueSource } from '../api/catalogueSource'
import { enrichChannels } from '../util/enrich'
import type { WorkingRecord } from '../util/enrich'
import { buildSearchIndex, type SearchIndex } from '../util/searchText'
import type { Category, EnrichedChannel } from '../api/types'

export interface CatalogueWorkerRequest {
  working: Record<string, WorkingRecord>
  /** The generation the caller already read and chose to download; saves a second `meta` read. */
  meta: CatalogueGeneration
  /** Generation the caller already holds, so a fallback that finds the same one downloads nothing. */
  held: number | null
}

export interface CatalogueWorkerResponse {
  ok: boolean
  /** Generation the catalogue really is: Redis's when R2 could not serve the requested one. */
  generation: number
  source: CatalogueSource
  /** True when the store's generation is the held one and nothing was downloaded. */
  unchanged?: boolean
  channels: EnrichedChannel[]
  categories: Category[]
  /** Null when the schedule index could not be read. */
  epgIds: string[] | null
  searchIndex?: SearchIndex
  error?: string
}

// Typed via a narrow local shape so this file needs no webworker lib reference.
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<CatalogueWorkerRequest>) => void) | null
  postMessage: (message: CatalogueWorkerResponse) => void
}

ctx.onmessage = async (event: MessageEvent<CatalogueWorkerRequest>) => {
  const working = event.data.working ?? {}

  try {
    const catalogue = await fetchCatalogue(event.data.meta, event.data.held ?? null)

    if (catalogue && 'unchanged' in catalogue) {
      ctx.postMessage({
        ok: true,
        unchanged: true,
        generation: catalogue.generation,
        source: catalogue.source,
        channels: [],
        categories: [],
        epgIds: null,
      })
      return
    }

    if (!catalogue) {
      ctx.postMessage({
        ok: false,
        generation: event.data.meta.generation,
        source: event.data.meta.source,
        channels: [],
        categories: [],
        epgIds: null,
        error: 'Catalogue is not available',
      })
      return
    }

    const epgIds = await fetchEpgIds(catalogue.generation)
    const channels = enrichChannels(catalogue.channels, catalogue.streams, working)
    const searchIndex = buildSearchIndex(channels)

    ctx.postMessage({
      ok: true,
      generation: catalogue.generation,
      source: catalogue.source,
      channels,
      categories: catalogue.categories,
      epgIds,
      searchIndex,
    })
  } catch (e) {
    ctx.postMessage({
      ok: false,
      generation: event.data.meta.generation,
      source: event.data.meta.source,
      channels: [],
      categories: [],
      epgIds: null,
      error: (e as Error).message,
    })
  }
}
