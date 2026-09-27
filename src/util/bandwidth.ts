/**
 * The connection speed the player starts from.
 *
 * hls.js picks its first quality level from a bandwidth guess before it has measured
 * anything. A fixed 5 Mbps guess starts a slow link on a level it cannot sustain (the
 * first fragment then takes longer than the watchdog allows) and starts a fast link
 * below the best level. The estimate hls.js measured last time on this device is a far
 * better guess, so it is kept between sessions.
 */

const BANDWIDTH_KEY = 'sl_bandwidth_v1'
/** A measurement older than this may be from another network (phone off Wi-Fi). */
const MAX_AGE_MS = 24 * 60 * 60 * 1000
const DEFAULT_BPS = 5_000_000
const MIN_BPS = 300_000
/** A LAN or edge-cache burst must not start a later cellular session on the top level. */
const MAX_BPS = 25_000_000

interface NetworkInformation {
  downlink?: number
  effectiveType?: string
  saveData?: boolean
  type?: string
}

/** Which network a measurement was taken on, where the browser says (Chromium only). */
function networkKind(): string {
  const c = connectionInfo()
  return `${c?.type ?? ''}/${c?.effectiveType ?? ''}`
}

const clamp = (bps: number) => Math.min(MAX_BPS, Math.max(MIN_BPS, bps))

export function connectionInfo(): NetworkInformation | undefined {
  return (navigator as Navigator & { connection?: NetworkInformation }).connection
}

export function startingBandwidth(): number {
  try {
    const rec = JSON.parse(localStorage.getItem(BANDWIDTH_KEY) ?? 'null') as { bps?: unknown; ts?: unknown; net?: unknown } | null
    if (
      rec && typeof rec.bps === 'number' && typeof rec.ts === 'number' &&
      Date.now() - rec.ts < MAX_AGE_MS && rec.net === networkKind()
    ) {
      return clamp(rec.bps)
    }
  } catch {
    // unreadable: fall through
  }
  // Chromium's own reading (capped at 10 Mbps by the spec) only raises the guess: it is
  // coarse early in a page's life and would otherwise start fast links too low.
  const downlink = connectionInfo()?.downlink ?? 0
  return Math.max(DEFAULT_BPS, downlink * 1_000_000)
}

export function rememberBandwidth(bps: number) {
  if (!Number.isFinite(bps) || bps <= 0) return
  try {
    localStorage.setItem(BANDWIDTH_KEY, JSON.stringify({ bps: Math.round(clamp(bps)), ts: Date.now(), net: networkKind() }))
  } catch {
    // ignore quota
  }
}
