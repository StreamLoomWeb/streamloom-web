/**
 * Cloudflare Pages Function: /api/picks/unlock-generate — the admin side of the full-catalogue
 * unlock code (ADR-0060, streamloom-backend).
 *
 * POST { "clientCode": "ABCDEF" } -> { "unlockCode": "GHJKMN" }
 *
 * Placed under `/api/picks/` for the same reason `/api/picks/custom-channels` and
 * `/api/picks/safe-channels` are: the Access application already covers this path prefix, so
 * the admin "generate" screen is protected the moment it deploys. Nothing is read or written on
 * the catalogue bucket, or anywhere else — `deriveUnlockCode` is a pure function of
 * `UNLOCK_HMAC_SECRET` and the client code, so calling this twice for the same client code
 * returns the same unlock code (that is intended, see the ADR: the admin never needs to
 * remember anything, and a client that clears its storage needs a fresh pairing regardless).
 */

import { authoriseAccessRequest } from '../_lib/accessJwt'
import { json, refuse } from '../_lib/httpJson'
import { deriveUnlockCode, isWellFormedCode, readUnlockSecret } from '../_lib/unlockCode'

export const onRequest: PagesFunction = async (context) => {
  const { request, env } = context

  const auth = await authoriseAccessRequest(request, env)
  if (!auth.ok) return refuse('unlock-generate', auth)

  if (request.method.toUpperCase() !== 'POST') {
    return json({ error: 'method-not-allowed' }, 405, { Allow: 'POST' })
  }

  const secret = readUnlockSecret(env)
  if (!secret) {
    return json(
      { error: 'unlock-not-configured', detail: 'UNLOCK_HMAC_SECRET is not set on this deployment.' },
      503,
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: 'invalid-json' }, 400)
  }
  const clientCode = (body as { clientCode?: unknown } | null)?.clientCode
  if (!isWellFormedCode(clientCode)) {
    return json({ error: 'invalid-client-code', detail: 'clientCode must be 6 characters from the shared alphabet.' }, 400)
  }

  const unlockCode = await deriveUnlockCode(secret, clientCode)
  return json({ unlockCode }, 200)
}
