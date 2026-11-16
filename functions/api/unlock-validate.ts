/**
 * Cloudflare Pages Function: /api/unlock-validate — the public side of the full-catalogue
 * unlock code (ADR-0060, streamloom-backend).
 *
 * POST { "clientCode": "ABCDEF", "unlockCode": "GHJKMN" } -> { "valid": true | false }
 *
 * **Public on purpose — this is not a bug.** The whole flow has no accounts and no login
 * (ADR-0060, following `streamloom-backend` ADR-0005): the web app, the Android app and the
 * Fire TV app all call this directly, unauthenticated, after a person has entered the unlock
 * code an admin read back to them. The one-way HMAC (`_lib/unlockCode.ts`) is what keeps a
 * caller who only ever sees a clientCode from predicting its unlockCode — no stored session,
 * no per-request credential, nothing to leak.
 *
 * **Rate limiting is a known gap, not an oversight** (ADR-0060): there is no Cloudflare
 * rate-limiting rule or KV counter in front of this route yet. The 6-character space (32^6 ≈
 * 1.07 billion) is large enough that guessing isn't practical at a handful of requests a
 * second, but a dashboard rate-limiting rule on this path is the owner's to add before this is
 * watched for abuse — flagged here so it isn't missed, not built here because it needs no code
 * change.
 */

import { json } from './_lib/httpJson'
import { constantTimeEquals, deriveUnlockCode, isWellFormedCode, readUnlockSecret } from './_lib/unlockCode'

/** No admin JWT, no ETag, no bucket — nothing here is ever cached or stored. */
const NO_STORE = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }

export const onRequest: PagesFunction = async (context) => {
  const { request, env } = context

  if (request.method.toUpperCase() !== 'POST') {
    return json({ error: 'method-not-allowed' }, 405, { Allow: 'POST', ...NO_STORE })
  }

  const secret = readUnlockSecret(env)
  if (!secret) {
    // Fail closed: with no secret configured, every code is "invalid", never "valid".
    return json({ error: 'unlock-not-configured' }, 503, NO_STORE)
  }

  const contentType = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (contentType !== 'application/json') {
    return json({ error: 'unsupported-media-type', detail: 'Content-Type must be application/json' }, 415, NO_STORE)
  }
  // Generous but finite: the whole body is two 6-character fields.
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > 1024) {
    return json({ error: 'too-large' }, 413, NO_STORE)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: 'invalid-json' }, 400, NO_STORE)
  }

  const clientCode = (body as { clientCode?: unknown } | null)?.clientCode
  const unlockCode = (body as { unlockCode?: unknown } | null)?.unlockCode
  if (!isWellFormedCode(clientCode) || !isWellFormedCode(unlockCode)) {
    return json({ valid: false }, 200, NO_STORE)
  }

  const expected = await deriveUnlockCode(secret, clientCode)
  const valid = constantTimeEquals(expected, unlockCode)
  return json({ valid }, 200, NO_STORE)
}
