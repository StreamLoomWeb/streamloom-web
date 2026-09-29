/**
 * Safari's own HLS player as the fallback for a stream its MSE decoder rejects.
 *
 * Apple WebKit (desktop Safari, and iPhone/iPad since iOS 17.1 through ManagedMediaSource)
 * reports `Hls.isSupported()`, so hls.js is tried first there as everywhere else. Some
 * broadcast restreams carry field-coded (PAFF) interlaced H.264: each field is its own PES
 * packet, hls.js remuxes each into its own MP4 sample, and WebKit's MSE decoder fails the
 * first one with "Media failed to decode" (Chrome's decoder accepts it). The same stream
 * plays in Safari's native HLS engine, whose TS demuxer pairs the fields itself. So on a
 * decode failure, Apple WebKit reopens the same URL through `video.src` instead of giving
 * the candidate up; other browsers keep today's recovery ladder.
 */

const HLS_MIME = 'application/vnd.apple.mpegurl'

/**
 * Stream URLs (as listed in the catalogue) that need the native engine. Kept for 30 days in
 * localStorage so a return visit opens the native player at once instead of failing on
 * hls.js first; a stream whose encoding changes is re-tried through the same ladder
 * because the entry expires.
 */
const STORAGE_KEY = 'sl_native_hls_v1'
const TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_ENTRIES = 200

const nativeUrls = new Set<string>()

function readStored(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const now = Date.now()
    const out: Record<string, number> = {}
    for (const [url, at] of Object.entries(raw)) {
      if (typeof at === 'number' && now - at < TTL_MS) out[url] = at
    }
    return out
  } catch {
    return {}
  }
}

/** True on Apple WebKit with a native HLS engine: desktop Safari and every iOS/iPadOS browser. */
export function canUseNativeHls(video: HTMLVideoElement): boolean {
  if (typeof navigator === 'undefined') return false
  if (!(navigator.vendor ?? '').startsWith('Apple')) return false
  return video.canPlayType(HLS_MIME) !== ''
}

export function prefersNativeHls(url: string): boolean {
  return nativeUrls.has(url) || url in readStored()
}

export function markNeedsNativeHls(url: string): void {
  nativeUrls.add(url)
  try {
    const stored = readStored()
    stored[url] = Date.now()
    const newest = Object.entries(stored).sort((a, b) => b[1] - a[1]).slice(0, MAX_ENTRIES)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(newest)))
  } catch {
    // Storage unavailable (private mode): the in-memory mark still holds for this page.
  }
}

/**
 * True when an hls.js error means the media element could not decode what was appended,
 * as opposed to a network or playlist problem: the element holds MEDIA_ERR_DECODE, or hls.js
 * saw the MediaSource close under it (WebKit closes it on a decode failure).
 */
export function isMseDecodeFailure(details: string, mediaErrorCode: number | undefined): boolean {
  return details === 'mediaSourceRequiresReset' || mediaErrorCode === 3
}

/** Forgets every stream marked for the native engine (Settings → cache reset). */
export function clearNativeHlsMarks(): void {
  nativeUrls.clear()
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}
