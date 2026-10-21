/**
 * The client side of the full-catalogue unlock flow (ADR-0059/0060, streamloom-backend).
 *
 * By default the app shows only the admin-curated "safe" subset of the catalogue
 * (`Channel.safe`, see `src/api/types.ts`). A visitor who wants the full iptv-org catalogue
 * gets there with no account and no login: this device generates a random "client code",
 * reads it to the admin over phone/chat, the admin turns it into an "unlock code"
 * (`/api/picks/unlock-generate`, behind Cloudflare Access), and this device redeems that code
 * through the public `/api/unlock-validate` endpoint.
 *
 * Nothing here is a secret and nothing here is stored server-side — the HMAC that makes a
 * client code un-guessable lives only in `functions/api/_lib/unlockCode.ts`, on the server.
 * The alphabet mirrors that module exactly (Crockford base32, no `I`/`L`/`O`/`U`) so a code a
 * person reads aloud or types never contains a confusable character. Change the two together.
 *
 * The client code is persisted in `localStorage` (`sl_unlock_client_code_v1`) so it survives a
 * reload, and is naturally lost if the visitor clears site data — intended, per ADR-0060: a
 * cleared device has no identity to re-pair other than starting over with a fresh code.
 */

import { notifyStreamStateChange } from './stream'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32, no I/L/O/U
export const CODE_LENGTH = 6
const CODE_PATTERN = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`)

const CLIENT_CODE_KEY = 'sl_unlock_client_code_v1'
const UNLOCKED_KEY = 'sl_catalogue_unlocked_v1'

/** True iff `code` is exactly `CODE_LENGTH` characters, all from the shared alphabet. */
export function isWellFormedCode(code: string): boolean {
  return CODE_PATTERN.test(code)
}

/** Upper-cases and drops anything not in the shared alphabet — for sanitizing input as it is typed. */
export function sanitizeCodeInput(raw: string): string {
  return raw
    .toUpperCase()
    .split('')
    .filter((ch) => ALPHABET.includes(ch))
    .join('')
    .slice(0, CODE_LENGTH)
}

function randomCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH)
  crypto.getRandomValues(bytes)
  let out = ''
  // ALPHABET.length (32) divides 256 evenly, so this introduces no modulo bias.
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[bytes[i] % ALPHABET.length]
  return out
}

let _cachedClientCode: string | null = null

/** The device's client code, generating and persisting one on first use. */
export function getOrCreateClientCode(): string {
  if (_cachedClientCode) return _cachedClientCode
  try {
    const existing = localStorage.getItem(CLIENT_CODE_KEY)
    if (existing && isWellFormedCode(existing)) {
      _cachedClientCode = existing
      return existing
    }
  } catch {
    // fall through to generating one for this session
  }
  const code = randomCode()
  _cachedClientCode = code
  try {
    localStorage.setItem(CLIENT_CODE_KEY, code)
  } catch {
    // no persistence available: the code still works for this page lifetime
  }
  return code
}

let _cachedUnlocked: boolean | null = null

/** False until the owner's unlock code has been redeemed on this device. */
export function isUnlocked(): boolean {
  if (_cachedUnlocked !== null) return _cachedUnlocked
  try {
    _cachedUnlocked = localStorage.getItem(UNLOCKED_KEY) === 'true'
  } catch {
    _cachedUnlocked = false
  }
  return _cachedUnlocked
}

function setUnlocked(value: boolean) {
  _cachedUnlocked = value
  try {
    if (value) localStorage.setItem(UNLOCKED_KEY, 'true')
    else localStorage.removeItem(UNLOCKED_KEY)
  } catch {
    // stays unlocked for this session only
  }
  // Reuses the same change bus `useChannels` already listens to for hidden/broken state, so
  // every component reading the catalogue re-renders without a dedicated subscription here.
  notifyStreamStateChange()
}

// Another tab redeemed (or cleared) the unlock: drop the cache so the next read sees it.
try {
  window.addEventListener('storage', (e) => {
    if (e.key !== UNLOCKED_KEY) return
    _cachedUnlocked = null
    notifyStreamStateChange()
  })
} catch {
  // no window (SSR/test): nothing to listen to
}

/**
 * Redeems `unlockCode` against this device's client code via the public, unauthenticated
 * `/api/unlock-validate`. Returns whether it was valid; throws only on a network/HTTP failure
 * so the caller can distinguish "wrong code" (a normal, retryable outcome) from "could not
 * reach the server" (a different message is warranted).
 */
export async function redeemUnlockCode(unlockCode: string): Promise<boolean> {
  const clientCode = getOrCreateClientCode()
  const res = await fetch('/api/unlock-validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientCode, unlockCode }),
  })
  if (!res.ok) throw new Error(`unlock-validate failed (${res.status})`)
  const body = (await res.json().catch(() => null)) as { valid?: unknown } | null
  const valid = body?.valid === true
  if (valid) setUnlocked(true)
  return valid
}
