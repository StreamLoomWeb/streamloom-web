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

/**
 * Returns the logo URL to render, or null when there is nothing to fetch.
 *
 * A null result means "render the local fallback immediately" — no request.
 */
export function logoUrl(logo: string | null | undefined): string | null {
  if (typeof logo !== 'string') return null
  const trimmed = logo.trim()
  return trimmed === '' ? null : trimmed
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
