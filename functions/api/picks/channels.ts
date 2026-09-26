/**
 * Cloudflare Pages Function: /api/picks/channels — the picker's search (ADR-0033 §2).
 *
 * The picker chooses from the whole iptv-org list, which is ~7.9 MB of JSON
 * (measured 2026-09-22). Handing that to the browser would cost the owner a
 * multi-megabyte download on every visit to `/admin` and would still have to be
 * re-checked server-side at save time, so the list stays at the edge and the
 * browser asks for at most a page of matches.
 *
 * Read-only, and behind exactly the same Access gate as the write path: the list
 * itself is public, but an unauthenticated route here would advertise that the
 * portal exists and give a stranger a free 8 MB fetch on the project's account.
 *
 * `?live=true` (WO-21) narrows the match to channels in `catalogue/active-channel-ids.json` —
 * the ones with at least one working stream in the generation actually being served right now.
 * Read through the same `CATALOGUE_BUCKET` binding `/api/picks` writes through; a missing
 * binding or object is not an error here, it just means every result is shown, same as before
 * this existed (see `_lib/activeChannelIds.ts`).
 */

import { authoriseAccessRequest, type AccessFailure } from '../_lib/accessJwt'
import { loadActiveChannelIds } from '../_lib/activeChannelIds'
import { bindBucket } from '../_lib/catalogueBucket'
import { loadIptvIndex, searchChannels } from '../_lib/iptvOrg'

const DEFAULT_LIMIT = 40
const MAX_LIMIT = 100
/** Bounds the work one request can ask for; longer queries match nothing useful anyway. */
const MAX_QUERY_CHARS = 100

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })

/** Generic by design; see the same function in ./index.ts. The reason goes to the log. */
function refuse(failure: AccessFailure): Response {
  console.warn(`[picks/channels] request refused: ${failure.status} ${failure.reason}`)
  if (failure.status === 503) return json({ error: 'unavailable' }, 503)
  return json({ error: 'unauthorised' }, failure.status)
}

/** A bounded, control-character-free parameter, or undefined. */
function param(url: URL, name: string): string | undefined {
  const raw = url.searchParams.get(name)
  if (raw === null) return undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_QUERY_CHARS) return undefined
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return undefined
  }
  return trimmed
}

export const onRequest: PagesFunction = async (context) => {
  const { request, env } = context

  const auth = await authoriseAccessRequest(request, env)
  if (!auth.ok) return refuse(auth)

  if (request.method !== 'GET') {
    return json({ error: 'method-not-allowed' }, 405)
  }

  const index = await loadIptvIndex()
  if (!index) {
    return json(
      { error: 'upstream-unavailable', detail: 'The iptv-org channel list could not be read.' },
      503,
    )
  }

  const url = new URL(request.url)
  const rawLimit = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT)
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), MAX_LIMIT) : DEFAULT_LIMIT

  // Non-fatal both ways: no binding, no object yet, or a malformed one all mean "cannot filter
  // this time" (_lib/activeChannelIds.ts), never a reason to refuse the search itself.
  let liveIds: Set<string> | undefined
  let live = false
  if (param(url, 'live') === 'true') {
    const bucket = bindBucket(env)
    const ids = bucket ? await loadActiveChannelIds(bucket) : null
    if (ids) {
      liveIds = ids
      live = true
    }
  }

  const { total, results } = searchChannels(index, {
    text: param(url, 'q'),
    country: param(url, 'country'),
    category: param(url, 'category'),
    limit,
    liveIds,
  })

  return json({ total, limit, live, results, listFetchedAt: new Date(index.fetchedAt).toISOString() }, 200)
}
