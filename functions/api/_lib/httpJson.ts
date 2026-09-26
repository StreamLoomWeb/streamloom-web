/**
 * The handful of lines every write route on the catalogue bucket needs the same way
 * (`picks/index.ts`, `picks/custom-channels.ts`): the JSON response shape, ETag comparison,
 * and reading a stored document defensively.
 *
 * Extracted for the same reason `catalogueBucket.ts` was — two routes carrying independent
 * copies of the same handful of lines is exactly the kind of drift `_lib/` exists to prevent.
 * A fix that only lands in one copy (like the `onlyIf.etagMatches` quoting bug `bareEtag` exists
 * to avoid — see its own comment below) would leave the other route's saves broken.
 */

import type { AccessFailure } from './accessJwt'
import type { R2Object } from './catalogueBucket'

export const json = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Neither route's response may be cached anywhere: it is authenticated, and the
      // editor must never be served a stale document.
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  })

/**
 * Turns an authorisation failure into a response.
 *
 * The body is deliberately generic. Everyone who reaches this branch is
 * *unauthenticated* — they have not proved they are the owner — so they are told
 * only that the request was refused, never which check refused it, which
 * environment variable is missing, or that the project runs on Pages at all. The
 * precise reason goes to the log, tagged with which route refused it, where the
 * owner can read it and a stranger cannot; the setup guidance lives in README.md.
 */
export function refuse(tag: string, failure: AccessFailure): Response {
  console.warn(`[${tag}] request refused: ${failure.status} ${failure.reason}`)
  if (failure.status === 503) return json({ error: 'unavailable' }, 503)
  return json({ error: 'unauthorised' }, failure.status)
}

/** `W/"abc"` and `"abc"` name the same object; compare them the same way. */
export const stripWeak = (etag: string): string => etag.replace(/^W\//, '').trim()

/**
 * The bare hash inside an ETag: no weak marker, no surrounding quotes.
 *
 * `stripWeak` above is for comparing two *header-shaped* values to each other
 * (the client's `If-Match` against the stored `httpEtag`), where both sides
 * carry quotes and the comparison is unaffected either way. R2's own
 * `onlyIf.etagMatches`/`etagDoesNotMatch`, passed straight to the binding
 * rather than compared here, is not header-shaped: it throws `TypeError:
 * Conditional ETag should not be wrapped in quotes` if given the quoted form
 * (found live, 2026-09-22 — every save after the first one hit this, because
 * only a second save has a `current` object to build `onlyIf` from at all).
 */
export const bareEtag = (etag: string): string => stripWeak(etag).replace(/^"|"$/g, '')

/** The stored document, or null when the object is absent, unreadable, or not a plain object. */
export async function readStoredJson<T>(object: R2Object): Promise<T | null> {
  try {
    const value = (await object.json()) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    return value as T
  } catch {
    return null
  }
}
