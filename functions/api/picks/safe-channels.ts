/**
 * Cloudflare Pages Function: /api/picks/safe-channels — the admin write path for the
 * safe-catalogue flag (ADR-0059, streamloom-backend).
 *
 *   GET        read the stored document and its ETag (for the editor)
 *   PUT | POST replace it whole, with an If-Match ETag
 *   anything else -> 405
 *
 * `catalogue/safe-channels.json` is read once a run by the sync worker; every channel whose id
 * is listed here is published with `safe: true` on its DTO, and every client defaults to
 * showing only `safe` channels until the owner's unlock code (ADR-0060) is entered. Placed under
 * `/api/picks/` for the same reason `/api/picks/custom-channels` is: the Access application
 * already covers that path prefix, so this route is protected the moment it deploys — no second
 * Access application for the owner to add. Every rule `/api/picks` documents for the same
 * reasons applies here too: Access-JWT-only authorisation, fail closed, no credential lives
 * here (same R2 binding, same `get`/`head`/`put`-only facade, no `delete`), nothing overwritten
 * without a matching `If-Match`, no CORS headers (same-origin only).
 */

import { authoriseAccessRequest } from '../_lib/accessJwt'
import { bindBucket, type CatalogueBucket } from '../_lib/catalogueBucket'
import { bareEtag, json, readStoredJson, refuse, stripWeak } from '../_lib/httpJson'
import {
  LIMITS,
  SAFE_CHANNELS_SCHEMA,
  validateSafeChannelsInput,
  type SafeChannelsDocument,
} from '../_lib/safeChannelsSchema'

const SAFE_CHANNELS_KEY = 'catalogue/safe-channels.json'

/** Matches the file's own read cadence in the sync worker: read once a run, so no urgency. */
const SAFE_CHANNELS_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300'

/** Same proof-of-bucket check `/api/picks` makes, and for the same reason (see that module). */
const BUCKET_PROOF_KEY = 'catalogue/meta.json'

async function handleGet(bucket: CatalogueBucket): Promise<Response> {
  const object = await bucket.get(SAFE_CHANNELS_KEY)
  if (!object) {
    return json({ ids: [], etag: null, limits: LIMITS }, 200)
  }
  const doc = await readStoredJson<SafeChannelsDocument>(object)
  return json({ ids: doc?.ids ?? [], etag: object.httpEtag, limits: LIMITS }, 200, {
    ETag: object.httpEtag,
  })
}

/** 412 with the copy the caller has not seen, so the editor can show it and merge. */
async function conflict(bucket: CatalogueBucket, message: string): Promise<Response> {
  const current = await bucket.get(SAFE_CHANNELS_KEY)
  return json(
    {
      error: 'conflict',
      detail: message,
      etag: current?.httpEtag ?? null,
      ids: current ? ((await readStoredJson<SafeChannelsDocument>(current))?.ids ?? []) : [],
    },
    412,
  )
}

async function handleWrite(request: Request, bucket: CatalogueBucket): Promise<Response> {
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
  if (new TextEncoder().encode(text).byteLength > LIMITS.bodyBytes) {
    return json({ error: 'too-large', detail: `body must be at most ${LIMITS.bodyBytes} bytes` }, 413)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return json({ error: 'invalid-json' }, 400)
  }

  const validated = validateSafeChannelsInput(parsed)
  if (!validated.ok) return json({ error: 'invalid-safe-channels', errors: validated.errors }, 400)

  // Same defence `/api/picks` and `/api/picks/custom-channels` apply, checked at the same point
  // (after validating the body, so a malformed request gets its 400 rather than a misdirecting
  // 503): a binding aimed at the wrong bucket must not be seeded with this object.
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

  const current = await bucket.get(SAFE_CHANNELS_KEY)
  const ifMatchRaw = request.headers.get('if-match')
  const ifMatch = ifMatchRaw === null ? null : stripWeak(ifMatchRaw)

  if (current) {
    if (ifMatch === null) {
      return conflict(bucket, 'safe-channels.json already exists; send If-Match with the ETag you read.')
    }
    if (ifMatch !== '*' && ifMatch !== stripWeak(current.httpEtag)) {
      return conflict(bucket, 'safe-channels.json changed since you read it.')
    }
  } else if (ifMatch !== null && ifMatch !== '*') {
    return conflict(bucket, 'safe-channels.json does not exist, but If-Match named a copy of it.')
  }

  const updatedAt = new Date().toISOString()
  const document: SafeChannelsDocument = {
    schema: SAFE_CHANNELS_SCHEMA,
    updatedAt,
    ids: validated.value.ids,
  }
  const body = JSON.stringify(document)

  const written = await bucket.put(SAFE_CHANNELS_KEY, body, {
    httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: SAFE_CHANNELS_CACHE_CONTROL },
    ...(current ? { onlyIf: { etagMatches: bareEtag(current.httpEtag) } } : {}),
  })
  if (!written) return conflict(bucket, 'safe-channels.json changed while it was being written.')

  return json(
    { ok: true, updatedAt, etag: written.httpEtag, ids: document.ids },
    200,
    { ETag: written.httpEtag },
  )
}

export const onRequest: PagesFunction = async (context) => {
  const { request, env } = context

  const auth = await authoriseAccessRequest(request, env)
  if (!auth.ok) return refuse('safe-channels', auth)

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
  return handleWrite(request, bucket)
}
