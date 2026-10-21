/**
 * The unlock-code derivation (ADR-0060, streamloom-backend): a stateless HMAC pairing between a
 * client-generated "client code" and the "unlock code" an admin reads back to them. Nothing here
 * stores anything — no database, no KV, no mapping — so this module is just a pure function of
 * `UNLOCK_HMAC_SECRET` and the client code, called identically by `/api/picks/unlock-generate`
 * (the admin side) and `/api/unlock-validate` (the public side): the same input always produces
 * the same output, which is the whole point — the admin never needs to remember a code, and a
 * client that cleared its storage naturally needs a fresh pairing (a new client code derives a
 * different unlock code).
 *
 * The alphabet is Crockford base32 (`0-9`, `A-Z` minus `I L O U`) so a code read aloud over a
 * phone call, or typed by hand, never turns on a confusable character. Clients generate their
 * client code from the same alphabet (see the app/web/Fire TV implementations) so both codes a
 * person ever has to transcribe look and behave the same way.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32, no I/L/O/U
export const CODE_LENGTH = 6
const CODE_PATTERN = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`)

/** True iff `code` is exactly `CODE_LENGTH` characters, all from the shared alphabet. */
export function isWellFormedCode(code: unknown): code is string {
  return typeof code === 'string' && CODE_PATTERN.test(code)
}

async function hmacSha256(secret: string, message: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
}

/**
 * `HMAC-SHA256(secret, "streamloom-unlock:v1:" + clientCode)`, re-encoded to `CODE_LENGTH`
 * characters of the shared alphabet (5 bits per character; `CODE_LENGTH * 5 = 30` bits taken
 * from the digest, far fewer than its 256, so no particular 30-bit window matters — any
 * fixed slice is as unpredictable as any other without the secret).
 */
export async function deriveUnlockCode(secret: string, clientCode: string): Promise<string> {
  const digest = new Uint8Array(await hmacSha256(secret, `streamloom-unlock:v1:${clientCode}`))
  let bits = 0
  let value = 0
  let out = ''
  for (let i = 0; i < digest.length && out.length < CODE_LENGTH; i++) {
    value = (value << 8) | digest[i]
    bits += 8
    while (bits >= 5 && out.length < CODE_LENGTH) {
      bits -= 5
      out += ALPHABET[(value >>> bits) & 0x1f]
    }
  }
  return out
}

/** Constant-time string compare, so a validate call cannot be timed into leaking a match. */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** The configured secret, or `null` if it is unset — callers must fail closed on `null`. */
export function readUnlockSecret(env: unknown): string | null {
  const value = (env as { UNLOCK_HMAC_SECRET?: unknown } | undefined)?.UNLOCK_HMAC_SECRET
  return typeof value === 'string' && value.trim() !== '' ? value : null
}
