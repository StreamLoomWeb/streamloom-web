/**
 * The custom-channels document: shape, limits and id assignment (WO-21).
 *
 * Wire shape the portal sends:
 *   { schema: 1, channels: [ { id?, name, streamUrl, iconUrl?, country? } ] }
 *
 * A new entry has no `id`: this module assigns one, always shaped `custom-<slug>-<hex>`,
 * because the backend's ingestion (`sync-worker/custom-channels.js`) treats the `custom-`
 * prefix as the one thing that tells a custom channel apart from an iptv-org one in every
 * code path (the prune, the vanished-channel sweep, `keptChannelIds`). The admin never types
 * it, so it can never be typed wrong — the same reason `updatedAt` and the identity snapshot
 * in `picksSchema.ts` are server-authored rather than accepted from the client. An id already
 * on the document is carried through unchanged, so an edit keeps its database row and its
 * `active-channel-ids.json` membership instead of the backend seeing a delete-then-add.
 *
 * `categories` is deliberately not a field here: the backend accepts one, but an unvalidated
 * category id reaches a live foreign-key constraint in `channel_categories` and can fail the
 * worker's whole batch for the run (flagged on backend PR #43's review). Until that path
 * validates its input, this portal never sends the field, so it cannot be the one to trigger it.
 *
 * Pure: no I/O, no environment, same posture as `picksSchema.ts`.
 */

import { hasForbiddenChar } from './picksSchema'

export const CUSTOM_CHANNELS_SCHEMA = 1

/**
 * Ceilings. `channels` mirrors `MAX_CUSTOM_CHANNELS` in `sync-worker/custom-channels.js`.
 *
 * `bodyBytes` has to hold `channels` entries anywhere near their own individual maxima —
 * `channels * (nameChars + 2*urlChars + countryChars + a ~150-byte id/JSON-overhead margin)`
 * is ~213 KB, and a real admin's stream/icon URLs (signed CDN URLs routinely run several
 * hundred characters) can approach `urlChars` well before `channels` is anywhere near 50.
 * 32 KB — copied from `/api/picks`'s own limit without re-deriving it for this shape, whose
 * per-entry URLs are far larger than a picks item's `note` — left every save failing on a
 * generic "too large" error once URLs stopped being tiny, with nothing to say which entry.
 */
export const LIMITS = {
  bodyBytes: 256 * 1024,
  channels: 50,
  nameChars: 100,
  urlChars: 2000,
  countryChars: 8,
} as const

export interface CustomChannelDraft {
  id?: string
  name: string
  streamUrl: string
  iconUrl?: string
  country?: string
}

export interface StoredCustomChannel {
  id: string
  name: string
  streamUrl: string
  iconUrl?: string
  country?: string
}

export interface CustomChannelsDocument {
  schema: number
  updatedAt: string
  channels: StoredCustomChannel[]
}

export type ValidationResult =
  | { ok: true; value: { schema: number; channels: CustomChannelDraft[] } }
  | { ok: false; errors: string[] }

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function unknownKeys(record: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(record).filter((k) => !allowed.includes(k))
}

/** A trimmed string of at most `max` code points, or null. Same rule as `picksSchema.ts`. */
function cleanString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (hasForbiddenChar(trimmed)) return null
  if ([...trimmed].length > max) return null
  return trimmed
}

/** `http://` or `https://` only: this is a URL the player or the icon pipeline fetches directly. */
function cleanHttpUrl(value: unknown): string | null {
  const s = cleanString(value, LIMITS.urlChars)
  if (s === null) return null
  let parsed: URL
  try {
    parsed = new URL(s)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return s
}

/**
 * Validates the wire shape.
 *
 * `existingIds` is every id already on the stored document. A client-sent `id` must name one of
 * them — an id it invents itself is refused outright, never silently accepted or reassigned,
 * the same posture `picksSchema.ts` takes on a client trying to set `updatedAt` or a snapshot
 * field. A draft with no `id` is a new entry; `assignIds` gives it one after this passes.
 */
export function validateCustomChannelsInput(
  raw: unknown,
  existingIds: ReadonlySet<string>,
): ValidationResult {
  const errors: string[] = []
  const push = (message: string) => {
    if (errors.length < 25) errors.push(message)
  }

  if (!isRecord(raw)) return { ok: false, errors: ['body must be a JSON object'] }

  for (const key of unknownKeys(raw, ['schema', 'channels'])) push(`unknown field "${key}"`)
  if (raw.schema !== CUSTOM_CHANNELS_SCHEMA) push(`schema must be ${CUSTOM_CHANNELS_SCHEMA}`)

  if (!Array.isArray(raw.channels)) {
    push('channels must be an array')
    return { ok: false, errors }
  }
  if (raw.channels.length > LIMITS.channels) push(`at most ${LIMITS.channels} custom channels`)

  const channels: CustomChannelDraft[] = []
  const seenIds = new Set<string>()

  raw.channels.forEach((rawChannel: unknown, i: number) => {
    const at = `channels[${i}]`
    if (!isRecord(rawChannel)) {
      push(`${at} must be an object`)
      return
    }
    for (const key of unknownKeys(rawChannel, ['id', 'name', 'streamUrl', 'iconUrl', 'country'])) {
      push(`${at}: unknown field "${key}"`)
    }

    let id: string | undefined
    if (rawChannel.id !== undefined) {
      if (typeof rawChannel.id !== 'string' || !existingIds.has(rawChannel.id)) {
        push(`${at}.id is not one of this document's existing custom channels`)
        return
      }
      if (seenIds.has(rawChannel.id)) {
        push(`${at}.id "${rawChannel.id}" is already used earlier in this document`)
        return
      }
      seenIds.add(rawChannel.id)
      id = rawChannel.id
    }

    const name = cleanString(rawChannel.name, LIMITS.nameChars)
    if (name === null) push(`${at}.name must be 1-${LIMITS.nameChars} printable characters`)

    const streamUrl = cleanHttpUrl(rawChannel.streamUrl)
    if (streamUrl === null) push(`${at}.streamUrl must be a http:// or https:// URL`)

    let iconUrl: string | undefined
    if (rawChannel.iconUrl !== undefined) {
      const cleaned = cleanHttpUrl(rawChannel.iconUrl)
      if (cleaned === null) push(`${at}.iconUrl must be a http:// or https:// URL, or omitted`)
      else iconUrl = cleaned
    }

    let country: string | undefined
    if (rawChannel.country !== undefined) {
      const cleaned = cleanString(rawChannel.country, LIMITS.countryChars)
      if (cleaned === null) push(`${at}.country must be 1-${LIMITS.countryChars} printable characters, or omitted`)
      else country = cleaned.toUpperCase()
    }

    if (name === null || streamUrl === null) return

    channels.push({
      ...(id !== undefined ? { id } : {}),
      name,
      streamUrl,
      ...(iconUrl !== undefined ? { iconUrl } : {}),
      ...(country !== undefined ? { country } : {}),
    })
  })

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { schema: CUSTOM_CHANNELS_SCHEMA, channels } }
}

function slug(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned.length > 0 ? cleaned.slice(0, 40) : 'channel'
}

function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes))
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Assigns a fresh, unique `custom-<slug>-<hex>` id to every draft that arrived without one.
 * Never touches a draft that already carries one — `validateCustomChannelsInput` has already
 * proven every one of those names an id already on this document.
 */
export function assignIds(drafts: CustomChannelDraft[]): StoredCustomChannel[] {
  const taken = new Set(drafts.map((d) => d.id).filter((id): id is string => id !== undefined))
  return drafts.map((draft) => {
    if (draft.id !== undefined) return draft as StoredCustomChannel
    let id: string
    do {
      id = `custom-${slug(draft.name)}-${randomHex(4)}`
    } while (taken.has(id))
    taken.add(id)
    return { ...draft, id }
  })
}
