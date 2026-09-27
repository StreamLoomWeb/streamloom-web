/**
 * Cloudflare Pages Function: /api/picks — the author's-picks write path (ADR-0033).
 *
 *   GET        read the stored document and its ETag (for the editor)
 *   PUT | POST replace it, with an If-Match ETag and an append-only history object
 *   anything else -> 405
 *
 * This is the only route in the project that can write to the catalogue bucket,
 * so it is built to be attacked:
 *
 *   1. **Authorisation is the Access JWT and nothing else.** It is verified here
 *      (`_lib/accessJwt.ts`), not assumed from the presence of a header or from
 *      the fact that the request reached this path. Neither the URL, the `Origin`
 *      header, nor any other client-settable value takes part in the decision.
 *   2. **Fail closed.** No Access configuration, unreadable signing keys, or an
 *      unreachable iptv-org list all end the request before a byte is written.
 *   3. **No credential lives here.** The write capability is an R2 *binding*
 *      (`CATALOGUE_BUCKET`), scoped to `streamloom-catalogue` alone. There is no
 *      API token, no Supabase key and no Upstash token in this project, and
 *      nothing here is a `VITE_` variable, so nothing reaches the bundle.
 *      The binding is typed `get`/`head`/`put` only: there is deliberately no
 *      `delete`, so no future edit can retire an object from this route
 *      (backend CLAUDE.md, "retire by flag, never delete").
 *   4. **Nothing is overwritten by accident.** `picks.json` is written only when
 *      the caller's `If-Match` still names the live copy, and the conditional put
 *      re-checks it at the store. History objects are never overwritten at all.
 *   5. **No CORS headers are emitted.** The portal is same-origin. A cross-origin
 *      page therefore cannot read a response, its preflight is refused (405 on
 *      OPTIONS), and the JSON content type it would need for a write is one a
 *      form post cannot produce without that preflight.
 */

import { authoriseAccessRequest } from '../_lib/accessJwt'
import { bindBucket, type CatalogueBucket } from '../_lib/catalogueBucket'
import { bareEtag, json, readStoredJson, refuse, stripWeak } from '../_lib/httpJson'
import { indexAgeMinutes, isIndexStale, judgeChannel, loadIptvIndex, type IptvChannel } from '../_lib/iptvOrg'
import { dispatchFastTrack } from '../_lib/fastTrack'
import {
  historyKeySegment,
  LIMITS,
  PICKS_SCHEMA,
  pinnedIds,
  validatePicksInput,
  type PicksDocument,
  type PicksInput,
  type StoredPickGroup,
} from '../_lib/picksSchema'

/** The one object clients read (ADR-0030: generation-independent, outside `catalogue/g<N>/`). */
const PICKS_KEY = 'catalogue/picks.json'
const HISTORY_PREFIX = 'picks-history/'

/** Matches ADR-0033 §7: a published pick appears within the object's short cache lifetime. */
const PICKS_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300'

/** If a history key is somehow taken, try this many suffixes before giving up. Never overwrite. */
const HISTORY_SUFFIX_TRIES = 5

/**
 * One object the bucket the portal is allowed to write must already contain.
 *
 * Before any write, the binding is asked for this key. A bucket that does not
 * hold it is not the catalogue bucket — it is `channel-icons`, or an empty
 * bucket created by a typo — and the portal refuses rather than seeding
 * `catalogue/picks.json` into it. The sync worker writes `meta.json` last on
 * every publish (ADR-0034 §3), so its presence is exactly "this bucket has had a
 * catalogue published into it".
 */
const BUCKET_PROOF_KEY = 'catalogue/meta.json'

// `bindBucket` moved to `_lib/catalogueBucket.ts` (WO-21) once `picks/custom-channels.ts` needed
// the same facade; re-exported here so this route's own tests, which import it from this module,
// keep working unchanged.
export { bindBucket }

/**
 * Attaches each item's iptv-org identity snapshot, from `snapshotById` (ADR-0042).
 *
 * An item whose id is not in the map (it was refused — unreachable, since a
 * refusal already returned 400 above — or, defensively, simply absent) is
 * stored with no snapshot, exactly as every item was before this existed: the
 * reader falls back to "pending" either way, never to a guess.
 *
 * Pure and total: every input item produces exactly one output item, in order.
 */
function snapshotGroups(
  groups: PicksInput['groups'],
  snapshotById: ReadonlyMap<string, IptvChannel>,
): StoredPickGroup[] {
  return groups.map((group) => ({
    title: group.title,
    ...(group.limit !== undefined ? { limit: group.limit } : {}),
    items: group.items.map((item) => {
      const snapshot = snapshotById.get(item.channelId)
      return snapshot
        ? { ...item, name: snapshot.name, country: snapshot.country, categories: snapshot.categories }
        : { ...item }
    }),
  }))
}

async function handleGet(bucket: CatalogueBucket): Promise<Response> {
  const object = await bucket.get(PICKS_KEY)
  if (!object) {
    // Not an error: nothing has been published yet. The editor starts empty.
    return json({ picks: null, etag: null, limits: LIMITS, schema: PICKS_SCHEMA }, 200)
  }
  const picks = await readStoredJson<PicksDocument>(object)
  return json(
    { picks, etag: object.httpEtag, limits: LIMITS, schema: PICKS_SCHEMA },
    200,
    { ETag: object.httpEtag },
  )
}

/** 412 with the copy the caller has not seen, so the editor can show it and merge. */
async function conflict(bucket: CatalogueBucket, message: string): Promise<Response> {
  const current = await bucket.get(PICKS_KEY)
  return json(
    {
      error: 'conflict',
      detail: message,
      etag: current?.httpEtag ?? null,
      picks: current ? await readStoredJson<PicksDocument>(current) : null,
    },
    412,
  )
}

async function handleWrite(
  request: Request,
  bucket: CatalogueBucket,
  env: unknown,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<Response> {
  // A cross-origin page cannot send this content type without a preflight, and the
  // preflight is refused. This is a CSRF defence, not authorisation: the JWT above
  // is what decides whether the caller may write.
  const contentType = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (contentType !== 'application/json') {
    return json({ error: 'unsupported-media-type', detail: 'Content-Type must be application/json' }, 415)
  }
  const fetchSite = request.headers.get('sec-fetch-site')
  if (fetchSite !== null && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return json({ error: 'cross-site-write-refused' }, 403)
  }

  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > LIMITS.bodyBytes) {
    return json({ error: 'too-large', detail: `body must be at most ${LIMITS.bodyBytes} bytes` }, 413)
  }

  const text = await request.text()
  // Re-checked after reading: `content-length` may be absent on a chunked body.
  if (new TextEncoder().encode(text).byteLength > LIMITS.bodyBytes) {
    return json({ error: 'too-large', detail: `body must be at most ${LIMITS.bodyBytes} bytes` }, 413)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return json({ error: 'invalid-json' }, 400)
  }

  const validated = validatePicksInput(parsed)
  if (!validated.ok) return json({ error: 'invalid-picks', errors: validated.errors }, 400)

  // Every id is checked against the public list. If the list cannot be read the
  // save is refused: accepting it would be the one way a blocklisted or NSFW id
  // could reach picks.json (ADR-0033 §4).
  const index = await loadIptvIndex()
  if (!index) {
    return json(
      {
        error: 'validation-unavailable',
        detail: 'The iptv-org channel list could not be read, so no id could be checked. Nothing was written.',
      },
      503,
    )
  }

  // Prove the binding points at the catalogue bucket before writing into it.
  // A binding aimed at `channel-icons` (whose route is public) or at an empty
  // bucket would otherwise be seeded with a picks object nothing reads.
  let proof: { key: string } | null
  try {
    proof = await bucket.head(BUCKET_PROOF_KEY)
  } catch {
    proof = null
  }
  if (!proof) {
    return json(
      {
        error: 'wrong-bucket',
        detail:
          `CATALOGUE_BUCKET does not contain ${BUCKET_PROOF_KEY}, so it is not the catalogue bucket ` +
          '(or no catalogue has been published to it yet). Nothing was written.',
      },
      503,
    )
  }

  const refusals: string[] = []
  const warnings: string[] = []
  // Every resolved channel's iptv-org identity, kept alongside the refusal scan
  // (ADR-0042) rather than a second pass over the same ids: `judgeChannel` is a
  // pure in-memory lookup against `index`, already fetched above, so keeping the
  // result costs a Map entry, not a second read of anything.
  const snapshotById = new Map<string, IptvChannel>()
  if (isIndexStale(index)) {
    const minutes = indexAgeMinutes(index)
    warnings.push(
      `The iptv-org list could not be refreshed; these ids were checked against a copy ${Math.floor(minutes / 60)}h ${minutes % 60}m old.`,
    )
  }
  for (const channelId of pinnedIds(validated.value)) {
    const verdict = judgeChannel(index, channelId)
    if (verdict.verdict === 'refuse') {
      refusals.push(verdict.reason)
      continue
    }
    if (verdict.verdict === 'warn') warnings.push(verdict.warning)
    snapshotById.set(channelId, verdict.channel)
  }
  if (refusals.length > 0) return json({ error: 'invalid-channels', errors: refusals }, 400)

  // `updatedAt` is the server's, never the client's: it is the history key, and a
  // client that could choose it could rewrite the past.
  const updatedAt = new Date().toISOString()
  const document: PicksDocument = {
    schema: PICKS_SCHEMA,
    updatedAt,
    groups: snapshotGroups(validated.value.groups, snapshotById),
  }
  const body = JSON.stringify(document)

  const current = await bucket.get(PICKS_KEY)
  // What was pinned before this save, so a fast-track dispatch (ADR-0043, WO-19) below only
  // ever names ids this save is the first to pin — never one already sitting on the identity
  // card from an earlier save, which would just be a redundant probe.
  const previousIds = new Set(
    current ? pinnedIds((await readStoredJson<PicksDocument>(current)) ?? { schema: PICKS_SCHEMA, groups: [] }) : [],
  )
  const ifMatchRaw = request.headers.get('if-match')
  const ifMatch = ifMatchRaw === null ? null : stripWeak(ifMatchRaw)

  if (current) {
    if (ifMatch === null) {
      return conflict(bucket, 'picks.json already exists; send If-Match with the ETag you read.')
    }
    if (ifMatch !== '*' && ifMatch !== stripWeak(current.httpEtag)) {
      return conflict(bucket, 'picks.json changed since you read it.')
    }
  } else if (ifMatch !== null && ifMatch !== '*') {
    return conflict(bucket, 'picks.json does not exist, but If-Match named a copy of it.')
  }

  const written = await bucket.put(PICKS_KEY, body, {
    httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: PICKS_CACHE_CONTROL },
    // Re-checks the precondition at the store, closing the window between the read
    // above and this write. A first write has no ETag to match on; two simultaneous
    // first saves are the one race this cannot close, and both are kept in history.
    ...(current ? { onlyIf: { etagMatches: bareEtag(current.httpEtag) } } : {}),
  })
  if (!written) return conflict(bucket, 'picks.json changed while it was being written.')

  // Append-only (ADR-0033 §6). Written after the live object so history never
  // records a save that did not happen; a history failure does not undo the save,
  // it is reported instead.
  const historyKey = await writeHistory(bucket, updatedAt, body)

  // Fast-track (ADR-0043, WO-19): only ids this save is the first to pin, and never allowed to
  // affect this response — `waitUntil` runs it after the response below has already gone out,
  // and a failure is logged, never thrown. The save already succeeded; nothing past this point
  // may un-succeed it.
  const freshIds = pinnedIds(validated.value).filter((channelId) => !previousIds.has(channelId))
  if (freshIds.length > 0) {
    waitUntil(
      dispatchFastTrack(env, freshIds).catch((err) => {
        console.warn(
          `[picks] fast-track dispatch failed (save already succeeded): ${err instanceof Error ? err.message : String(err)}`,
        )
      }),
    )
  }

  return json(
    {
      ok: true,
      updatedAt,
      etag: written.httpEtag,
      warnings,
      historyKey,
      counts: {
        groups: document.groups.length,
        items: document.groups.reduce((n, g) => n + g.items.length, 0),
      },
    },
    200,
    { ETag: written.httpEtag },
  )
}

/**
 * Writes `picks-history/<updatedAt>.json` without ever overwriting.
 *
 * The write is conditional — `If-None-Match: *`, which R2 spells
 * `onlyIf: { etagDoesNotMatch: '*' }` — so the store itself refuses a key that
 * already exists. A head-then-put would have been a check and a write with a gap
 * between them: two saves in the same millisecond both see "absent" and the
 * second silently replaces the first, which is precisely what "append-only"
 * must not allow. Here the loser gets null back and retries under a suffix.
 *
 * Returns the key written, or null if every candidate was taken or the store
 * refused. Nothing is deleted and nothing is replaced under any outcome.
 */
export async function writeHistory(
  bucket: CatalogueBucket,
  updatedAt: string,
  body: string,
): Promise<string | null> {
  const base = HISTORY_PREFIX + historyKeySegment(updatedAt)
  for (let attempt = 0; attempt < HISTORY_SUFFIX_TRIES; attempt += 1) {
    const key = attempt === 0 ? `${base}.json` : `${base}-${attempt + 1}.json`
    try {
      const written = await bucket.put(key, body, {
        httpMetadata: {
          contentType: 'application/json; charset=utf-8',
          cacheControl: 'public, max-age=31536000, immutable',
        },
        onlyIf: { etagDoesNotMatch: '*' },
      })
      // Null means the key already existed: try the next suffix, never replace.
      if (written) return key
    } catch {
      return null
    }
  }
  return null
}

export const onRequest: PagesFunction = async (context) => {
  const { request, env, waitUntil } = context

  // Authorisation first, before the method, the body or anything else is looked
  // at: an unauthenticated request learns nothing about this route.
  const auth = await authoriseAccessRequest(request, env)
  if (!auth.ok) return refuse('picks', auth)

  const method = request.method.toUpperCase()
  if (method !== 'GET' && method !== 'PUT' && method !== 'POST') {
    return json({ error: 'method-not-allowed' }, 405, { Allow: 'GET, PUT, POST' })
  }

  const bucket = bindBucket(env)
  if (!bucket) {
    return json(
      {
        error: 'storage-not-configured',
        detail:
          'CATALOGUE_BUCKET is not an R2 bucket binding on this project (a plain variable of that ' +
          'name is not one). Nothing was written.',
      },
      503,
    )
  }

  if (method === 'GET') return handleGet(bucket)
  return handleWrite(request, bucket, env, waitUntil)
}
