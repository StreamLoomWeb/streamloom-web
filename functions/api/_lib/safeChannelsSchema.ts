/**
 * The safe-channels document: shape and limits (ADR-0059, streamloom-backend).
 *
 * Wire shape the portal sends and `catalogue/safe-channels.json` stores:
 *   { schema: 1, updatedAt: "<ISO>", ids: string[] }
 *
 * Deliberately the flattest shape that works: just the ids the sync worker should flag `safe`
 * on the published catalogue. No owner/evidence/scope/expiry fields — those belong to the real
 * rights register ADR-0059 defers until outreach produces enough real data to put in them; this
 * is the admin curating a list, same posture as `/api/picks/custom-channels`.
 *
 * Pure: no I/O, no environment, same posture as `picksSchema.ts` and `customChannelsSchema.ts`.
 */

import { hasForbiddenChar } from './picksSchema'

export const SAFE_CHANNELS_SCHEMA = 1

/** Mirrors `MAX_SAFE_CHANNELS` in `sync-worker/safe-channels.js`. */
export const LIMITS = {
  bodyBytes: 64 * 1024,
  ids: 2000,
  idChars: 200,
} as const

export interface SafeChannelsDocument {
  schema: typeof SAFE_CHANNELS_SCHEMA
  updatedAt: string
  ids: string[]
}

export type ValidationResult =
  | { ok: true; value: { ids: string[] } }
  | { ok: false; errors: string[] }

/** Accepts `{ ids: string[] }` (the portal never sends `schema` or `updatedAt`; those are server-authored). */
export function validateSafeChannelsInput(input: unknown): ValidationResult {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['body must be a JSON object'] }
  }
  const body = input as Record<string, unknown>
  if (!Array.isArray(body.ids)) {
    return { ok: false, errors: ['ids must be an array'] }
  }
  if (body.ids.length > LIMITS.ids) {
    errors.push(`ids must have at most ${LIMITS.ids} entries (got ${body.ids.length})`)
  }

  const ids: string[] = []
  const seen = new Set<string>()
  body.ids.forEach((raw, i) => {
    if (typeof raw !== 'string' || raw.trim() === '') {
      errors.push(`ids[${i}] must be a non-empty string`)
      return
    }
    const id = raw.trim()
    if (id.length > LIMITS.idChars) {
      errors.push(`ids[${i}] must be at most ${LIMITS.idChars} characters`)
      return
    }
    if (hasForbiddenChar(id)) {
      errors.push(`ids[${i}] contains a character that is not allowed`)
      return
    }
    if (seen.has(id)) return // de-duplicate, last-mention position kept, silently
    seen.add(id)
    ids.push(id)
  })

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { ids } }
}
