/**
 * The author's-picks document: shape, limits and normalisation (ADR-0033 §1, ADR-0042).
 *
 * Wire shape the portal sends, exactly:
 *   { schema: 1, groups: [ { title, items: [ { channelId, note?, rank? } ] } ] }
 *
 * `updatedAt` is added by the server and is never read from the request: a client
 * that could set it would control the history key and could rewrite the past.
 * The stored document (`StoredPickItem`, ADR-0042) additionally carries a
 * `name`/`country`/`categories` snapshot per item, also server-authored — see
 * `snapshotItems` and its call site in `functions/api/picks/index.ts`, not here:
 * this module has no I/O, and the snapshot comes from the iptv-org index the
 * write path already fetches to validate the ids.
 *
 * Every rule here is a refusal, not a repair. Unknown keys are rejected rather
 * than dropped, so a field the portal stops sending cannot be smuggled past a
 * later reader that does understand it, and a typo in the portal shows up as a
 * 400 instead of silently losing a note.
 *
 * Pure: no I/O, no environment. The iptv-org checks live in `iptvOrg.ts` and run
 * after this one, because there is no point fetching 8 MB to validate a body that
 * is already malformed.
 */

export const PICKS_SCHEMA = 1

/** Ceilings. Chosen to be comfortably above any plausible curation and far below anything expensive. */
export const LIMITS = {
  /** Bytes of request body accepted before parsing. */
  bodyBytes: 64 * 1024,
  groups: 12,
  groupTitleChars: 60,
  /** Applied to a group that does not set its own `limit` — including every group saved before that field existed. */
  itemsPerGroup: 50,
  /**
   * The widest a single group's own `limit` may go (owner request, 2026-09-24: let the admin
   * size each list at creation instead of a fixed 50). Set to `totalItems` rather than a bigger
   * number of its own: one group already can't hold more than the whole document allows, so a
   * higher per-group ceiling would just be a limit nothing can ever reach.
   */
  itemsPerGroupCeiling: 200,
  /** Across all groups. This is also the cap on the probe-free pinned set (ADR-0033, WO-12). */
  totalItems: 200,
  noteChars: 140,
  channelIdChars: 128,
  rankMax: 9_999,
} as const

/**
 * Channel ids become R2 object path segments in the snapshot layout, so the
 * portal accepts only ids that can be one. This is the same rule as
 * `isSnapshotChannelId` in `src/api/r2Contract.ts` and `r2ChannelSegment` in the
 * sync worker (ADR-0034 §1): an id with `%`, `/`, `?` or a space has no URL that
 * reaches what was stored, so pinning one would publish something unreachable.
 */
const CHANNEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/

/**
 * True when a string carries a character that must not appear in a title or a
 * note. Written as a scan rather than a regular expression so the file contains
 * no literal control bytes of its own.
 *
 * Three families, all refused:
 *
 *  - **C0/C1 controls and the line separators** (U+0000–U+001F, U+007F–U+009F,
 *    U+2028, U+2029): they break a log line, a JSON pretty-print and a terminal.
 *  - **Bidirectional overrides** (U+202A–U+202E, U+2066–U+2069): "Trojan Source".
 *    They let the rendered order of a string differ from its stored order, so a
 *    group could read one way in the portal and another on the site, or a note
 *    could be made to display text it does not contain.
 *  - **Zero-width and invisible characters** (U+200B–U+200D, U+2060, U+FEFF):
 *    two groups could look identical while comparing unequal, which would defeat
 *    the duplicate-title check and leave an invisible difference the author
 *    cannot see or correct.
 *
 * Every one of these is BMP, so a UTF-16 unit scan sees them whole.
 */
export function hasForbiddenChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 0x20) return true
    if (code >= 0x7f && code <= 0x9f) return true
    if (code === 0x2028 || code === 0x2029) return true
    if (code >= 0x202a && code <= 0x202e) return true
    if (code >= 0x2066 && code <= 0x2069) return true
    if (code >= 0x200b && code <= 0x200d) return true
    if (code === 0x2060 || code === 0xfeff) return true
  }
  return false
}

export interface PickItem {
  channelId: string
  note?: string
  rank?: number
}

export interface PickGroup {
  title: string
  items: PickItem[]
  /**
   * How many items this group may hold, chosen by the admin when the group is created
   * (owner request, 2026-09-24). Absent means the default, `LIMITS.itemsPerGroup` — the
   * only value a group could ever have before this field existed, so an old document
   * reads exactly as it always did.
   */
  limit?: number
}

/** What the portal sends. */
export interface PicksInput {
  schema: number
  groups: PickGroup[]
}

/**
 * One item as stored in `picks.json` — the author's input plus a server-authored
 * snapshot of the channel's iptv-org identity at save time (ADR-0042).
 *
 * `name`/`country`/`categories` are never taken from the request, for the same
 * reason `updatedAt` isn't (a client that could set its own name could make a
 * card lie about what it is showing); the write path fills them in from the
 * same iptv-org index it already fetches to validate the id. Absent on an item
 * whose channel could not be resolved at save time, and on every item saved
 * before this field existed — both are handled by falling back to "pending"
 * exactly as an absent snapshot always has (`PicksRow.tsx`).
 */
export interface StoredPickItem extends PickItem {
  name?: string
  country?: string | null
  categories?: string[]
}

export interface StoredPickGroup {
  title: string
  items: StoredPickItem[]
  limit?: number
}

/** What is stored. */
export interface PicksDocument {
  schema: number
  updatedAt: string
  groups: StoredPickGroup[]
}

export type ValidationResult =
  | { ok: true; value: PicksInput }
  | { ok: false; errors: string[] }

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Rejects a record carrying any key outside `allowed`. */
function unknownKeys(record: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(record).filter((k) => !allowed.includes(k))
}

/**
 * A trimmed string of at most `max` characters, or null.
 *
 * Length is counted in code points, not UTF-16 units, so an emoji costs one
 * character rather than two and the limit means the same thing to the author as
 * it does here.
 */
function cleanString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (hasForbiddenChar(trimmed)) return null
  if ([...trimmed].length > max) return null
  return trimmed
}

/**
 * Validates a parsed request body.
 *
 * On success the value is normalised: strings trimmed, absent optionals absent
 * (never `undefined` keys), items in the order the author gave them.
 */
export function validatePicksInput(raw: unknown): ValidationResult {
  const errors: string[] = []
  const push = (message: string) => {
    if (errors.length < 25) errors.push(message)
  }

  if (!isRecord(raw)) return { ok: false, errors: ['body must be a JSON object'] }

  for (const key of unknownKeys(raw, ['schema', 'groups'])) push(`unknown field "${key}"`)

  if (raw.schema !== PICKS_SCHEMA) push(`schema must be ${PICKS_SCHEMA}`)

  if (!Array.isArray(raw.groups)) {
    push('groups must be an array')
    return { ok: false, errors }
  }
  if (raw.groups.length > LIMITS.groups) push(`at most ${LIMITS.groups} groups`)

  const groups: PickGroup[] = []
  const seenTitles = new Set<string>()
  let totalItems = 0

  raw.groups.forEach((rawGroup: unknown, gi: number) => {
    const where = `groups[${gi}]`
    if (!isRecord(rawGroup)) {
      push(`${where} must be an object`)
      return
    }
    for (const key of unknownKeys(rawGroup, ['title', 'items', 'limit'])) {
      push(`${where}: unknown field "${key}"`)
    }

    const title = cleanString(rawGroup.title, LIMITS.groupTitleChars)
    if (title === null) {
      push(`${where}.title must be 1-${LIMITS.groupTitleChars} printable characters`)
    } else if (seenTitles.has(title.toLowerCase())) {
      push(`${where}.title duplicates another group`)
    } else {
      seenTitles.add(title.toLowerCase())
    }

    // Absent means the default; present must be a sane integer, never trusted past that
    // (the same posture as `rank` below) — a client-chosen ceiling still has a ceiling.
    let limit: number | undefined
    if (rawGroup.limit !== undefined) {
      const rawLimit = rawGroup.limit
      if (
        typeof rawLimit !== 'number' ||
        !Number.isInteger(rawLimit) ||
        rawLimit < 1 ||
        rawLimit > LIMITS.itemsPerGroupCeiling
      ) {
        push(`${where}.limit must be an integer 1-${LIMITS.itemsPerGroupCeiling}, or omitted`)
      } else {
        limit = rawLimit
      }
    }
    const effectiveLimit = limit ?? LIMITS.itemsPerGroup

    if (!Array.isArray(rawGroup.items)) {
      push(`${where}.items must be an array`)
      return
    }
    if (rawGroup.items.length > effectiveLimit) {
      push(`${where}.items: at most ${effectiveLimit} items`)
    }

    const items: PickItem[] = []
    const seenIds = new Set<string>()

    rawGroup.items.forEach((rawItem: unknown, ii: number) => {
      const at = `${where}.items[${ii}]`
      if (!isRecord(rawItem)) {
        push(`${at} must be an object`)
        return
      }
      for (const key of unknownKeys(rawItem, ['channelId', 'note', 'rank'])) {
        push(`${at}: unknown field "${key}"`)
      }

      const channelId = cleanString(rawItem.channelId, LIMITS.channelIdChars)
      if (channelId === null || !CHANNEL_ID_RE.test(channelId)) {
        push(`${at}.channelId is not a usable channel id`)
        return
      }
      // The same channel may appear in two genres; twice in one group is a mistake.
      if (seenIds.has(channelId)) {
        push(`${at}.channelId "${channelId}" is already in this group`)
        return
      }
      seenIds.add(channelId)

      const item: PickItem = { channelId }

      if (rawItem.note !== undefined) {
        const note = cleanString(rawItem.note, LIMITS.noteChars)
        if (note === null) {
          push(`${at}.note must be 1-${LIMITS.noteChars} printable characters, or omitted`)
          return
        }
        item.note = note
      }

      if (rawItem.rank !== undefined) {
        const rank = rawItem.rank
        if (typeof rank !== 'number' || !Number.isInteger(rank) || rank < 0 || rank > LIMITS.rankMax) {
          push(`${at}.rank must be an integer 0-${LIMITS.rankMax}, or omitted`)
          return
        }
        item.rank = rank
      }

      items.push(item)
      totalItems += 1
    })

    groups.push({ title: title ?? '', items, ...(limit !== undefined ? { limit } : {}) })
  })

  if (totalItems > LIMITS.totalItems) {
    push(`at most ${LIMITS.totalItems} pinned channels in total (got ${totalItems})`)
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { schema: PICKS_SCHEMA, groups } }
}

/** Every channel id the document pins, in document order, without duplicates. */
export function pinnedIds(input: PicksInput): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const group of input.groups) {
    for (const item of group.items) {
      if (seen.has(item.channelId)) continue
      seen.add(item.channelId)
      out.push(item.channelId)
    }
  }
  return out
}

/**
 * An R2 key segment for a save instant: `2026-09-22T01-45-30-123Z`.
 *
 * ISO-8601's colons are legal in an R2 key but have to be percent-encoded in a
 * URL, which makes a history object awkward to open by hand. Dashes sort the same
 * way and need no encoding.
 */
export function historyKeySegment(updatedAt: string): string {
  return updatedAt.replace(/[:.]/g, '-')
}
