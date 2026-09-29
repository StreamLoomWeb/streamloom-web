/**
 * What a stream URL is, decided from the URL alone (no network), plus a proxy sniff for the
 * ambiguous ones. The player picks its engine from this: hls.js, mpegts.js, the video element.
 */
import type { Stream } from '../api/types'

export type StreamKind = 'hls' | 'ts' | 'mp4' | 'dash' | 'unsupported' | 'unknown'

const UNSUPPORTED_SCHEME = /^(rtmps?|rtsp|rtsps|udp|mms|mmsh|rtp|srt):/i

function pathOf(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase()
  } catch {
    return url.split(/[?#]/)[0].toLowerCase()
  }
}

/** Xtream Codes live path: /live/<user>/<pass>/<id> with an optional extension. */
const XTREAM_LIVE = /^(.*\/live\/[^/]+\/[^/]+\/[^/.]+)(\.[a-z0-9]+)?$/i

export function classifyStreamUrl(url: string): StreamKind {
  const trimmed = (url ?? '').trim()
  if (!trimmed) return 'unknown'
  if (UNSUPPORTED_SCHEME.test(trimmed)) return 'unsupported'
  const path = pathOf(trimmed)
  if (path.endsWith('.m3u8') || path.endsWith('.m3u') || /\/hls\//.test(path)) return 'hls'
  if (path.endsWith('.mpd')) return 'dash'
  if (path.endsWith('.mp4') || path.endsWith('.m4v')) return 'mp4'
  if (path.endsWith('.ts') || path.endsWith('.mpegts') || path.endsWith('.mts')) return 'ts'
  // Xtream without an extension serves a raw MPEG-TS stream.
  if (XTREAM_LIVE.test(path) && !/\.[a-z0-9]+$/.test(path)) return 'ts'
  return 'unknown'
}

/** True for kinds no browser engine here can open. */
export function isUnsupportedKind(kind: StreamKind): boolean {
  return kind === 'unsupported' || kind === 'dash'
}

export function isUnsupportedStreamUrl(url: string): boolean {
  return isUnsupportedKind(classifyStreamUrl(url))
}

/** The `.m3u8` twin of an Xtream `/live/u/p/id.ts` URL, else null. */
export function xtreamHlsVariant(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (!/^https?:$/.test(u.protocol)) return null
  const m = XTREAM_LIVE.exec(u.pathname)
  if (!m || (m[2] ?? '').toLowerCase() !== '.ts') return null
  u.pathname = `${m[1]}.m3u8`
  return u.toString()
}

/** Puts the synthesized HLS twin of each Xtream `.ts` candidate immediately before it. */
export function withXtreamHlsTwins(streams: Stream[]): Stream[] {
  if (!streams.some((s) => xtreamHlsVariant(s.url))) return streams
  const seen = new Set(streams.map((s) => s.url))
  const out: Stream[] = []
  for (const s of streams) {
    const twin = xtreamHlsVariant(s.url)
    if (twin && !seen.has(twin)) {
      seen.add(twin)
      out.push({ ...s, url: twin })
    }
    out.push(s)
  }
  return out
}

const sniffCache = new Map<string, StreamKind>()
const SNIFF_TIMEOUT_MS = 4000

/** Asks the edge proxy what the bytes are. Never throws; 'unknown' on any failure. */
export async function sniffStreamKind(url: string): Promise<StreamKind> {
  const hit = sniffCache.get(url)
  if (hit) return hit
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), SNIFF_TIMEOUT_MS)
  let kind: StreamKind = 'unknown'
  try {
    const res = await fetch(`/api/proxy?url=${encodeURIComponent(url)}&sniff=1`, { signal: ctl.signal })
    if (res.ok) {
      const body = (await res.json()) as { kind?: string }
      if (body.kind === 'hls' || body.kind === 'ts' || body.kind === 'mp4') kind = body.kind
    }
  } catch {
    kind = 'unknown'
  } finally {
    clearTimeout(timer)
  }
  sniffCache.set(url, kind)
  return kind
}
