/**
 * Byte-level stream sniffing shared by /api/proxy and /api/streams.
 *
 * Servers routinely label playlists `application/octet-stream` or `text/plain`
 * and transport streams `video/mp2t`, `audio/*` or nothing at all, so neither
 * the URL nor the Content-Type can be trusted. The first bytes can.
 */

export type StreamKind = 'hls' | 'ts' | 'mp4' | 'unknown'

/** Bytes to read before deciding what a body is. */
export const PEEK_BYTES = 1024

const EXTM3U = [0x23, 0x45, 0x58, 0x54, 0x4d, 0x33, 0x55] // "#EXTM3U"

/** Index of the first byte after an optional UTF-8 BOM and leading whitespace. */
function contentStart(bytes: Uint8Array): number {
  let i = 0
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++
  return i
}

export function isPlaylistBytes(bytes: Uint8Array): boolean {
  const s = contentStart(bytes)
  if (bytes.length - s < EXTM3U.length) return false
  return EXTM3U.every((b, i) => bytes[s + i] === b)
}

export function looksLikeHtml(bytes: Uint8Array): boolean {
  const s = contentStart(bytes)
  const head = new TextDecoder().decode(bytes.subarray(s, s + 16)).toLowerCase()
  return head.startsWith('<!doctype') || head.startsWith('<html')
}

/** MPEG-TS: sync byte 0x47 repeating every 188 bytes (as far as the peek reaches). */
function isTransportStream(bytes: Uint8Array): boolean {
  if (bytes.length < 1 || bytes[0] !== 0x47) return false
  for (let off = 188; off < bytes.length && off <= 564; off += 188) {
    if (bytes[off] !== 0x47) return false
  }
  return true
}

export function sniffKind(bytes: Uint8Array): StreamKind {
  if (isPlaylistBytes(bytes)) return 'hls'
  if (isTransportStream(bytes)) return 'ts'
  if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return 'mp4'
  // ID3 tag or ADTS frame header: an audio elementary stream, served the same way as TS.
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return 'ts'
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return 'ts'
  return 'unknown'
}

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b
  if (b.length === 0) return a
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/**
 * Reads until at least `min` bytes have arrived or the body ends. Never reads
 * more than one chunk past `min`, so an endless body costs one read.
 */
export async function peekBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  min: number,
): Promise<{ bytes: Uint8Array; done: boolean }> {
  let bytes: Uint8Array = new Uint8Array(0)
  while (bytes.length < min) {
    const { done, value } = await reader.read()
    if (done) return { bytes, done: true }
    if (value) bytes = concatBytes(bytes, value)
  }
  return { bytes, done: false }
}
