/**
 * Shared data types for catalogue and EPG payloads.
 *
 * Types are erased at build time, so this module adds nothing to the bundle. The
 * client reads everything from the Upstash Redis edge cache (ADR-0015) and never
 * calls Supabase directly, so these interfaces mirror what the sync worker
 * publishes there.
 */

export interface Channel {
  id: string
  name: string
  logo: string | null
  country: string | null
  is_active: boolean
  channel_categories: { category_id: string }[]
  /** ISO 639-2 codes published by the sync worker (e.g. [eng, hin]). */
  languages?: string[]
  /**
   * True when the admin has curated this channel as legally safe (streamloom-backend
   * ADR-0059). Additive on the published DTO; absent or false on everything else, which today
   * is almost everything since outreach has only just started. The client shows only `safe`
   * channels until the full-catalogue unlock (ADR-0060) is redeemed — see `src/util/unlock.ts`.
   */
  safe?: boolean
}

export interface Stream {
  channel_id: string | null
  url: string
  quality: string | null
  status: string | null
  /** Per-stream request identity some origins insist on; absent on most rows. */
  user_agent?: string | null
  referrer?: string | null
}

export interface Category {
  id: string
  name: string
}

export interface EpgProgram {
  id: string
  channel_id: string
  title: string
  description: string | null
  start_time: string
  end_time: string
}

/** A channel joined with its stream candidates and category ids. */
export interface EnrichedChannel extends Channel {
  stream: Stream | undefined
  streams: Stream[]
  categoryIds: string[]
}
