import channelFallback from '../assets/channel-fallback.svg'

/**
 * Channel icon helpers.
 *
 * Every `channels.logo` value is served from our own CDN as a 128px WebP:
 *   https://icons.softarchium.com/<channel-id>.webp
 *
 * The object name is the channel id and the CDN sends
 * `Cache-Control: public, max-age=31536000, immutable`, so:
 * - URLs are used verbatim — never append cache-busting params or timestamps.
 * - The 128px WebP is requested as-is and scaled by CSS; no larger variant.
 * - A null logo renders locally — it must never cost a network request.
 *
 * When the CDN has no object for a channel the bundled placeholder is shown.
 * The client never writes icons: hosting them is the backend pipeline's job
 * (ADR-0019), and a browser has no credentials with which to do it safely.
 */

/** Intrinsic size of the CDN WebP (long edge), used to reserve layout space. */
export const LOGO_SIZE = 128

/** Bundled placeholder swapped in when a request genuinely fails. */
export const FALLBACK_LOGO = channelFallback

/** Public origin of the `channel-icons` bucket. */
const ICON_CDN = 'https://icons.softarchium.com/'

/**
 * `<account>.r2.cloudflarestorage.com` is R2's authenticated S3 API endpoint, not a public
 * host: every unsigned GET answers 400. Catalogue generations have shipped logo URLs built on
 * it (over half of all channels as of 2026-10-03), which left those cards on the placeholder.
 * The object key is the same on the public CDN, so such a URL is mapped back onto it.
 */
const R2_S3_ENDPOINT = /^https?:\/\/[^/]+\.r2\.cloudflarestorage\.com\/(?:.*\/)?([^/?#]+)$/i

/**
 * Returns the logo URL to render, or null when there is nothing to fetch.
 *
 * A null result means "render the local fallback immediately" — no request.
 */
export function logoUrl(logo: string | null | undefined): string | null {
  if (typeof logo !== 'string') return null
  const trimmed = logo.trim()
  if (trimmed === '') return null
  const s3 = R2_S3_ENDPOINT.exec(trimmed)
  return s3 ? ICON_CDN + s3[1] : trimmed
}

/**
 * `onError` handler for channel logo images. Swaps in the bundled placeholder
 * once; subsequent errors on the same element are ignored (no loop, no blank
 * tile). The data flag keeps this allocation-free per render.
 */
export function handleLogoError(event: React.SyntheticEvent<HTMLImageElement>): void {
  const img = event.currentTarget
  if (img.dataset.fallbackApplied === '1') return
  img.dataset.fallbackApplied = '1'
  img.src = FALLBACK_LOGO
}
