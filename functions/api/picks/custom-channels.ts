/**
 * Cloudflare Pages Function: /api/picks/custom-channels — the admin write path for hand-added
 * channels (WO-21; backend counterpart in `StreamLoomBackEnd/streamloom-backend` PR #43).
 *
 *   GET        read the stored document and its ETag (for the editor)
 *   PUT | POST replace it whole, with an If-Match ETag
 *   anything else -> 405
 *
 * `catalogue/custom-channels.json` is read once a run by the sync worker and merged into the
 * published catalogue, bypassing iptv-org and the probe entirely — the admin vouches for the
 * stream URL, which is why this route exists behind the same gate as `/api/picks` rather than
 * being open. Every rule that route documents for the same reasons applies here too:
 *
 *   1. **Authorisation is the Access JWT and nothing else** (`_lib/accessJwt.ts`).
 *   2. **Fail closed.** No Access configuration, or a `CATALOGUE_BUCKET` that is not the
 *      catalogue bucket, ends the request before a byte is written.
 *   3. **No credential lives here.** Same R2 binding as `/api/picks`, same `get`/`head`/`put`
 *      facade with no `delete` reachable from this module.
 *   4. **Nothing is overwritten by accident.** Written only when the caller's `If-Match` still
 *      names the live copy.
 *   5. **No CORS headers are emitted.** Same same-origin posture as `/api/picks`.
 *
 * Placed under `/api/picks/` on purpose: the Access application already covers `/api/picks` as
 * a path *prefix* (README.md, "The author's picks portal"), so this route is protected the
 * moment it deploys — no second Access application or path rule for the owner to add.
 *
 * Ids are never chosen by the client (`_lib/customChannelsSchema.ts`): a new entry is assigned
 * one here, and an edit must name an id already on the document. `categories` is not a field
 * this route accepts at all — see that module's doc comment for why.
 */

import { authoriseAccessRequest } from '../_lib/accessJwt'
import { bindBucket, type CatalogueBucket } from '../_lib/catalogueBucket'
import { bareEtag, json, readStoredJson, refuse, stripWeak } from '../_lib/httpJson'
import {
  assignIds,
  LIMITS,
  validateCustomChannelsInput,
  type CustomChannelsDocument,
} from '../_lib/customChannelsSchema'

const CUSTOM_CHANNELS_KEY = 'catalogue/custom-channels.json'

/** Matches the file's own read cadence in the sync worker: read once a run, so no urgency. */
const CUSTOM_CHANNELS_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300'

/** Same proof-of-bucket check `/api/picks` makes, and for the same reason (see that module). */
const BUCKET_PROOF_KEY = 'catalogue/meta.json'

async function handleGet(bucket: CatalogueBucket): Promise<Response> {
  const object = await bucket.get(CUSTOM_CHANNELS_KEY)
  if (!object) {
    return json({ channels: [], etag: null, limits: LIMITS }, 200)
  }
  const doc = await readStoredJson<CustomChannelsDocument>(object)
  return json({ channels: doc?.channels ?? [], etag: object.httpEtag, limits: LIMITS }, 200, {
    ETag: object.httpEtag,
  })
}

/** 412 with the copy the caller has not seen, so the editor can show it and merge. */
async function conflict(bucket: CatalogueBucket, message: string): Promise<Response> {
  const current = await bucket.get(CUSTOM_CHANNELS_KEY)
  return json(
    {
      error: 'conflict',
      detail: message,
      etag: current?.httpEtag ?? null,
      channels: current ? ((await readStoredJson<CustomChannelsDocument>(current))?.channels ?? []) : [],
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

  const current = await bucket.get(CUSTOM_CHANNELS_KEY)
  const currentDoc = current ? await readStoredJson<CustomChannelsDocument>(current) : null
  const existingIds = new Set((currentDoc?.channels ?? []).map((c) => c.id))

  const validated = validateCustomChannelsInput(parsed, existingIds)
  if (!validated.ok) return json({ error: 'invalid-custom-channels', errors: validated.errors }, 400)

  // Prove the binding points at the catalogue bucket before writing into it — same defence
  // `/api/picks` applies, checked at the same point in the sequence (validate the body first,
  // so a malformed request gets the 400 it deserves rather than a 503 that misdirects the
  // admin toward the bucket configuration): a binding aimed at `channel-icons` or an empty
  // bucket must not be seeded with a custom-channels object nothing reads.
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

  const ifMatchRaw = request.headers.get('if-match')
  const ifMatch = ifMatchRaw === null ? null : stripWeak(ifMatchRaw)

  if (current) {
    if (ifMatch === null) {
      return conflict(bucket, 'custom-channels.json already exists; send If-Match with the ETag you read.')
    }
    if (ifMatch !== '*' && ifMatch !== stripWeak(current.httpEtag)) {
      return conflict(bucket, 'custom-channels.json changed since you read it.')
    }
  } else if (ifMatch !== null && ifMatch !== '*') {
    return conflict(bucket, 'custom-channels.json does not exist, but If-Match named a copy of it.')
  }

  const updatedAt = new Date().toISOString()
  const document: CustomChannelsDocument = {
    schema: validated.value.schema,
    updatedAt,
    channels: assignIds(validated.value.channels),
  }
  const body = JSON.stringify(document)

  const written = await bucket.put(CUSTOM_CHANNELS_KEY, body, {
    httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: CUSTOM_CHANNELS_CACHE_CONTROL },
    ...(current ? { onlyIf: { etagMatches: bareEtag(current.httpEtag) } } : {}),
  })
  if (!written) return conflict(bucket, 'custom-channels.json changed while it was being written.')

  return json(
    { ok: true, updatedAt, etag: written.httpEtag, channels: document.channels },
    200,
    { ETag: written.httpEtag },
  )
}

export const onRequest: PagesFunction = async (context) => {
  const { request, env } = context

  const auth = await authoriseAccessRequest(request, env)
  if (!auth.ok) return refuse('custom-channels', auth)

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
