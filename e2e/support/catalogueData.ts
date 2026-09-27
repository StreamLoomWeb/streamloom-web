/**
 * One synthetic catalogue shared by the Upstash and R2 mocks, so a test can serve
 * the same rows from either store and tell which one answered by request counts.
 */

/** The generation both mocks publish unless a test says otherwise. */
export const DEFAULT_GENERATION = 1_790_000_000_000

export interface CatalogueOptions {
  /** Channels published with a schedule (and a stream), i.e. rows in the guide. */
  guideChannels?: number
  totalChannels?: number
  /** Publish schedules whose programmes have all ended, as a lagging feed does. */
  endedSchedules?: boolean
  /**
   * Channels at the end of the list published with no stream at all. The sync
   * worker publishes a pinned channel whatever the publish filters say, including
   * one with no stream (ADR-0033), so the picks row has to cope with it.
   */
  streamlessChannels?: number
}

export function scheduleFor(channelId: string, ended: boolean): unknown[] {
  // One-hour programmes from four hours ago to twenty hours ahead, so the guide
  // shows a live "now" and the schedule stays unexpired for the whole test. An
  // ended schedule runs from thirty hours ago to six hours ago instead.
  const hour = 3_600_000
  const base = Math.floor((Date.now() - (ended ? 30 : 4) * hour) / hour) * hour
  return Array.from({ length: 24 }, (_, i) => ({
    id: `${channelId}:${i}`,
    channel_id: channelId,
    title: `Show ${i}`,
    description: null,
    start_time: new Date(base + i * hour).toISOString(),
    end_time: new Date(base + (i + 1) * hour).toISOString(),
  }))
}

export function syntheticCatalogue(options: CatalogueOptions = {}) {
  const guideChannels = options.guideChannels ?? 526
  const totalChannels = options.totalChannels ?? 600

  const channels = Array.from({ length: totalChannels }, (_, i) => ({
    id: `ch${i}.xx`,
    name: `Channel ${i}`,
    logo: null,
    country: 'US',
    is_active: true,
    channel_categories: [{ category_id: 'news' }],
    languages: ['eng'],
  }))
  // Every second channel has a backup candidate: 900 streams, which at 100 a page
  // gives the nine stream pages production publishes today.
  const streamless = options.streamlessChannels ?? 0
  const streams = channels.slice(0, totalChannels - streamless).flatMap((c, i) =>
    Array.from({ length: i % 2 === 0 ? 2 : 1 }, (_, n) => ({
      channel_id: c.id,
      url: `https://streams.invalid/${c.id}-${n}.m3u8`,
      quality: n === 0 ? '1080p' : '720p',
      status: 'working',
    })),
  )
  const categories = [{ id: 'news', name: 'News' }]
  const epgIds = channels.slice(0, guideChannels).map((c) => c.id)
  return { channels, streams, categories, epgIds }
}
