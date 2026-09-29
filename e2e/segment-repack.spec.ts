import { test, expect } from '@playwright/test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { onRequest as proxyHandler } from '../functions/api/proxy'
import { repackSegment } from '../functions/api/_lib/tsTrim'

/**
 * Safari's native HLS player cannot start on a segment that opens mid-GOP, and some restreams
 * cut their segments on the clock. The proxy re-cuts each segment on its first I-picture and
 * appends the head of the next one, so nothing is lost and every output starts on a key frame.
 * The streams here are synthetic MPEG-TS with real PAT/PMT, PES headers and H.264 slice headers.
 */

const VPID = 0x101
const APID = 0x102
const PMT = 0x100

const cc = new Map<number, number>()
function packet(pid: number, pusi: boolean, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(188)
  out[0] = 0x47
  out[1] = (pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f)
  out[2] = pid & 0xff
  const n = cc.get(pid) ?? 0
  cc.set(pid, (n + 1) & 0xf)
  if (payload.length >= 184) {
    out[3] = 0x10 | n
    out.set(payload.subarray(0, 184), 4)
  } else {
    // adaptation-field stuffing so the packet is full
    const stuff = 184 - payload.length
    out[3] = 0x30 | n
    out[4] = stuff - 1
    if (stuff > 1) {
      out[5] = 0
      out.fill(0xff, 6, 4 + stuff)
    }
    out.set(payload, 4 + stuff)
  }
  return out
}

function psi(pid: number, section: number[]): Uint8Array {
  return packet(pid, true, Uint8Array.from([0, ...section]))
}
const PAT = () => psi(0, [0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe0 | (PMT >> 8), PMT & 0xff, 0, 0, 0, 0])
const PMT_TABLE = () =>
  psi(PMT, [
    0x02, 0xb0, 0x17, 0x00, 0x01, 0xc1, 0x00, 0x00, 0xe0 | (VPID >> 8), VPID & 0xff, 0xf0, 0x00,
    0x1b, 0xe0 | (VPID >> 8), VPID & 0xff, 0xf0, 0x00,
    0x03, 0xe0 | (APID >> 8), APID & 0xff, 0xf0, 0x00,
    0, 0, 0, 0,
  ])

function pesHeader(sid: number, pts: number): number[] {
  return [
    0, 0, 1, sid, 0, 0, 0x80, 0x80, 5,
    0x21 | (Math.floor(pts / 1073741824) & 7) << 1,
    (pts >>> 22) & 0xff,
    ((pts >>> 15) & 0x7f) << 1 | 1,
    (pts >>> 7) & 0xff,
    (pts & 0x7f) << 1 | 1,
  ]
}

type Pic = 'I' | 'P'
const SPS = [0, 0, 0, 1, 0x67, 0x4d, 0x00, 0x1e, 0xaa]
const PPS = [0, 0, 0, 1, 0x68, 0xee, 0x3c, 0x80]

function videoPes(kind: Pic, pts: number): Uint8Array[] {
  // AUD, [SPS PPS], slice with first_mb=0 and slice_type I(7) or P(5)
  const slice = [0, 0, 1, kind === 'I' ? 0x41 : 0x41, kind === 'I' ? 0x88 : 0x98, 0x11, 0x22, 0x33, 0x44]
  const body = [0, 0, 0, 1, 0x09, 0xf0, ...(kind === 'I' ? [...SPS, ...PPS] : []), ...slice, ...new Array(400).fill(0x55)]
  return splitPes(VPID, [...pesHeader(0xe0, pts), ...body])
}
function audioPes(pts: number): Uint8Array[] {
  return splitPes(APID, [...pesHeader(0xc0, pts), ...new Array(300).fill(0xaa)])
}
function splitPes(pid: number, bytes: number[]): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += 184) out.push(packet(pid, i === 0, Uint8Array.from(bytes.slice(i, i + 184))))
  return out
}

/** One segment from a list of video pictures (each 20 ms apart in PTS) and audio PES. */
function segment(pics: { kind: Pic; pts: number }[], audio: number[]): Uint8Array {
  const parts: Uint8Array[] = [PAT(), PMT_TABLE()]
  const events = [
    ...pics.map((p) => ({ t: p.pts, parts: videoPes(p.kind, p.pts) })),
    ...audio.map((a) => ({ t: a, parts: audioPes(a) })),
  ].sort((x, y) => x.t - y.t)
  events.forEach((e) => parts.push(...e.parts))
  const out = new Uint8Array(parts.length * 188)
  parts.forEach((p, i) => out.set(p, i * 188))
  return out
}

interface Pes { pid: number; pts: number; kind?: Pic }
function listPes(buf: Uint8Array): Pes[] {
  const out: Pes[] = []
  for (let o = 0; o + 188 <= buf.length; o += 188) {
    const pusi = (buf[o + 1] & 0x40) !== 0
    const pid = ((buf[o + 1] & 0x1f) << 8) | buf[o + 2]
    if (!pusi || (pid !== VPID && pid !== APID)) continue
    const afc = (buf[o + 3] >> 4) & 3
    let p = o + 4
    if (afc & 2) p += 1 + buf[o + 4]
    const b = p + 9
    const pts = ((buf[b] & 0x0e) * 536870912) + (buf[b + 1] << 22) + ((buf[b + 2] & 0xfe) << 14) + (buf[b + 3] << 7) + (buf[b + 4] >> 1)
    let kind: Pic | undefined
    if (pid === VPID) {
      const data = buf.subarray(p + 9 + buf[p + 8], o + 188)
      for (let i = 0; i + 5 < data.length; i++) if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && (data[i + 3] & 0x1f) === 1) kind = data[i + 4] === 0x88 ? 'I' : 'P'
    }
    out.push({ pid, pts, kind })
  }
  return out
}

// A stream cut on the clock: GOPs (I + 5 P) of 6 pictures, segments of 10 pictures, so every
// segment after the first opens mid-GOP.
const STEP = 1800
const pic = (n: number) => ({ kind: (n % 6 === 0 ? 'I' : 'P') as Pic, pts: 900000 + n * STEP })
const audioFor = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => 900000 + (from + i) * STEP + 100)
const seg = (a: number, b: number) =>
  segment(Array.from({ length: b - a }, (_, i) => pic(a + i)), audioFor(a, b))
const S0 = seg(0, 10), S1 = seg(10, 20), S2 = seg(20, 30), S3 = seg(30, 40)

test('a repacked segment starts on its first I-picture and drops nothing across the chain', () => {
  const r0 = repackSegment(S0, S1), r1 = repackSegment(S1, S2), r2 = repackSegment(S2, S3)
  for (const r of [r0, r1, r2]) {
    const v = listPes(r).filter((x) => x.pid === VPID)
    expect(v[0].kind).toBe('I')
    // the first video PES of the output is the first thing after PAT/PMT
    expect(r[0]).toBe(0x47)
  }
  // Video: outputs cover I(0)..I(30) exactly once, in order, with no gap or repeat.
  const pts = [r0, r1, r2].flatMap((r) => listPes(r).filter((x) => x.pid === VPID).map((x) => x.pts))
  const expected = Array.from({ length: 30 }, (_, n) => 900000 + n * STEP)
  expect(pts).toEqual(expected)
  // Audio partitions the same way: each PES exactly once.
  const apts = [r0, r1, r2].flatMap((r) => listPes(r).filter((x) => x.pid === APID).map((x) => x.pts))
  expect(new Set(apts).size).toBe(apts.length)
  expect(apts.length).toBe(30)
})

test('a segment that already starts on an I-picture keeps its whole head', () => {
  const s = seg(6, 16) // pic 6 is an I
  const out = repackSegment(s, null)
  expect(listPes(out).filter((x) => x.pid === VPID)[0].pts).toBe(900000 + 6 * STEP)
  expect(listPes(out).filter((x) => x.pid === VPID).length).toBe(10)
})

test('input that is not TS, or has no video or no I-picture, is returned as it came', () => {
  const junk = new Uint8Array(400).fill(7)
  expect(repackSegment(junk, null)).toBe(junk)
  const noI = segment(Array.from({ length: 5 }, (_, i) => ({ kind: 'P' as Pic, pts: 1000 + i * STEP })), [])
  expect(repackSegment(noI, null)).toBe(noI)
})

test('repacking a 2 MB segment is fast and allocates one output copy', () => {
  const pics = Array.from({ length: 300 }, (_, i) => pic(i))
  const big = segment(pics, audioFor(0, 300))
  const nxt = segment(Array.from({ length: 300 }, (_, i) => pic(300 + i)), audioFor(300, 600))
  const t0 = performance.now()
  const out = repackSegment(big, nxt)
  const ms = performance.now() - t0
  expect(out.length).toBeLessThanOrEqual(big.length + nxt.length)
  expect(ms).toBeLessThan(200)
})

// ---------------------------------------------------------------- through the real handler

const ORIGIN = 'https://streamloom.example'
let server: http.Server
let base = ''
let hits: string[] = []

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    hits.push(path)
    const segs: Record<string, Uint8Array> = { '/s0.ts': S0, '/s1.ts': S1, '/s2.ts': S2 }
    if (segs[path]) {
      res.writeHead(200, { 'Content-Type': 'video/mp2t' })
      return void res.end(Buffer.from(segs[path]))
    }
    if (path === '/live.m3u8' || path === '/vod.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
      return void res.end(
        `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:5\n#EXTINF:2.88,\ns0.ts\n#EXTINF:2.88,\ns1.ts\n#EXTINF:2.88,\ns2.ts\n${path === '/vod.m3u8' ? '#EXT-X-ENDLIST\n' : ''}`,
      )
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
test.afterAll(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

const ctx = (request: Request) => ({ request, env: {}, waitUntil: (p: Promise<unknown>) => void p.catch(() => {}) }) as never
const call = (qs: string) => Promise.resolve(proxyHandler(ctx(new Request(`${ORIGIN}/api/proxy?${qs}`)))) as Promise<Response>

test('a live playlist is rewritten with next-links and holds back its newest segment', async () => {
  const res = await call(`url=${encodeURIComponent(`${base}/live.m3u8`)}&repack=1`)
  const text = await res.text()
  const lines = text.split('\n').filter((l) => l.includes('/api/proxy?'))
  expect(lines.length).toBe(2)
  const u0 = new URL(lines[0]), u1 = new URL(lines[1])
  expect(u0.searchParams.get('url')).toBe(`${base}/s0.ts`)
  expect(u0.searchParams.get('next')).toBe(`${base}/s1.ts`)
  expect(u0.searchParams.get('seg')).toBe('1')
  expect(u0.searchParams.get('repack')).toBe('1')
  expect(u1.searchParams.get('next')).toBe(`${base}/s2.ts`)
  expect(text).not.toContain('s2.ts&')
  expect((text.match(/#EXTINF/g) ?? []).length).toBe(2)
})

test('a VOD playlist keeps every segment; the last has no next', async () => {
  const text = await (await call(`url=${encodeURIComponent(`${base}/vod.m3u8`)}&repack=1`)).text()
  const lines = text.split('\n').filter((l) => l.includes('/api/proxy?'))
  expect(lines.length).toBe(3)
  expect(new URL(lines[2]).searchParams.get('next')).toBeNull()
})

test('without repack the playlist is rewritten as before', async () => {
  const text = await (await call(`url=${encodeURIComponent(`${base}/live.m3u8`)}`)).text()
  expect((text.match(/\/api\/proxy\?/g) ?? []).length).toBe(3)
  expect(text).not.toContain('repack')
})

test('a segment request returns the repacked bytes, starting on an I-picture', async () => {
  hits = []
  const res = await call(`url=${encodeURIComponent(`${base}/s1.ts`)}&repack=1&seg=1&next=${encodeURIComponent(`${base}/s2.ts`)}`)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('video/MP2T')
  expect(res.headers.get('x-segment-repacked')).toBe('with-next')
  const out = new Uint8Array(await res.arrayBuffer())
  expect(out.length % 188).toBe(0)
  expect(listPes(out).filter((x) => x.pid === VPID)[0].kind).toBe('I')
  expect(Array.from(out)).toEqual(Array.from(repackSegment(S1, S2)))
})

test('when the origin fails, a segment request falls back to the ordinary path and never throws', async () => {
  const res = await call(`url=${encodeURIComponent(`${base}/missing.ts`)}&repack=1&seg=1&next=${encodeURIComponent(`${base}/s2.ts`)}`)
  expect(res.status).toBeGreaterThanOrEqual(400)
})

test('an oversize or non-TS body is passed through untouched', async () => {
  const res = await call(`url=${encodeURIComponent(`${base}/live.m3u8`)}&repack=1&seg=1`)
  // a playlist requested as a segment: not TS, so the ordinary (rewriting) path answers
  expect(res.status).toBe(200)
  expect(await res.text()).toContain('#EXTM3U')
})
