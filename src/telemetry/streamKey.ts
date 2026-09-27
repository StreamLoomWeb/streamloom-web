import { STREAM_KEY_ALGORITHM } from '../../functions/api/_lib/telemetryContract'

/**
 * The stream key (`s`): the first 16 hex characters of the SHA-256 of the stream's published
 * url (`STREAM_KEY_ALGORITHM`). Computed here in the browser with WebCrypto — the same API the
 * Function has — and checked against the golden fixture's worked example.
 *
 * Kept in its own module because the contract file imports nothing, and WebCrypto is the one
 * platform call the client side of the contract needs. Returns null where `crypto.subtle` is
 * absent (a plain-http origin on an old TV browser), in which case the event that needed the key
 * is simply not sent.
 */

const cache = new Map<string, Promise<string | null>>()

export async function streamKey(url: string): Promise<string | null> {
  let pending = cache.get(url)
  if (!pending) {
    pending = digest(url)
    cache.set(url, pending)
  }
  return pending
}

async function digest(url: string): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle
    if (!subtle) return null
    const hash = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(url)))
    let hex = ''
    for (let i = 0; i < 8; i += 1) hex += hash[i].toString(16).padStart(2, '0')
    return hex
  } catch {
    return null
  }
}

/** Re-exported so a reader of the client sees which algorithm the key is. */
export { STREAM_KEY_ALGORITHM }
