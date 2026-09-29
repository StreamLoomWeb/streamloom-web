/**
 * Re-cuts MPEG-TS media segments so each one starts on an I-picture, without re-encoding.
 *
 * Some broadcast restreams cut their HLS segments on the clock, so a segment opens mid-GOP.
 * Safari's native HLS player (and its hardware decoder) cannot start there and drops every
 * frame; ffmpeg, which cuts HLS on key frames, produces segments Safari plays. `repackSegment`
 * does the same cut: the pictures that open a segment (and finish the previous GOP) move to
 * the end of the previous output segment, so nothing is lost.
 *
 * Pure and dependency-free so it runs in a Pages Function and in a plain Node test. Memory is
 * bounded by its input: it holds views over the input plus one output copy.
 */

const TS = 188

interface Packet {
  off: number
  pid: number
  pusi: boolean
  payload: number
}

function parsePackets(buf: Uint8Array): Packet[] {
  const out: Packet[] = []
  for (let o = 0; o + TS <= buf.length; o += TS) {
    if (buf[o] !== 0x47) return []
    const pusi = (buf[o + 1] & 0x40) !== 0
    const pid = ((buf[o + 1] & 0x1f) << 8) | buf[o + 2]
    const afc = (buf[o + 3] >> 4) & 3
    let payload = o + 4
    if (afc & 2) payload += 1 + buf[o + 4]
    out.push({ off: o, pid, pusi, payload: afc & 1 ? payload : o + TS })
  }
  return out
}

function readPts(buf: Uint8Array, p: number): number | null {
  // p is the start of a PES header (00 00 01 sid len len flags flags hdrlen ...)
  if (buf[p] !== 0 || buf[p + 1] !== 0 || buf[p + 2] !== 1) return null
  if ((buf[p + 7] & 0x80) === 0) return null
  const b = p + 9
  return (
    ((buf[b] & 0x0e) * 536870912) +
    (buf[b + 1] << 22) +
    ((buf[b + 2] & 0xfe) << 14) +
    (buf[b + 3] << 7) +
    (buf[b + 4] >> 1)
  )
}

/** Exp-Golomb reader over an H.264 NAL (bit 8 onwards, skipping the NAL header byte). */
function sliceIsIntra(nal: Uint8Array, at: number): boolean {
  let bit = (at + 1) * 8
  const limit = Math.min(nal.length, at + 16) * 8
  const rd = () => (nal[bit >> 3] >> (7 - (bit & 7))) & 1
  const ue = () => {
    let zeros = 0
    while (bit < limit && !rd()) {
      zeros++
      bit++
    }
    bit++
    let v = 1
    for (let i = 0; i < zeros; i++) {
      v = (v << 1) | rd()
      bit++
    }
    return v - 1
  }
  ue()
  const st = ue() % 5
  return st === 2 || st === 4
}

/** True when the PES payload (first ~600 bytes) holds an IDR or an I-slice. */
function startsIntra(pes: Uint8Array): boolean {
  const n = Math.min(pes.length, 600)
  for (let i = 0; i + 4 < n; i++) {
    if (pes[i] === 0 && pes[i + 1] === 0 && pes[i + 2] === 1) {
      const t = pes[i + 3] & 0x1f
      if (t === 5) return true
      if (t === 1 && sliceIsIntra(pes, i + 3)) return true
    }
  }
  return false
}

interface Analysis {
  pk: Packet[]
  pmtPid: number
  videoPid: number
  audioPids: Set<number>
  psi: Packet[]
  /** Packet index where the first video PES holding an I-picture starts, or -1. */
  cutIdx: number
  cutPts: number | null
}

function analyze(buf: Uint8Array): Analysis | null {
  const pk = parsePackets(buf)
  if (pk.length === 0) return null
  let pmtPid = -1
  let videoPid = -1
  const audioPids = new Set<number>()
  const psi: Packet[] = []
  for (const p of pk) {
    if (p.pid === 0 && pmtPid < 0 && p.pusi) {
      const s = p.payload + 1 + buf[p.payload]
      pmtPid = ((buf[s + 10] & 0x1f) << 8) | buf[s + 11]
      psi.push(p)
    } else if (p.pid === pmtPid && videoPid < 0 && p.pusi) {
      const s = p.payload + 1 + buf[p.payload]
      const secLen = ((buf[s + 1] & 0xf) << 8) | buf[s + 2]
      const infoLen = ((buf[s + 10] & 0xf) << 8) | buf[s + 11]
      let q = s + 12 + infoLen
      const end = s + 3 + secLen - 4
      while (q + 5 <= end) {
        const st = buf[q]
        const ep = ((buf[q + 1] & 0x1f) << 8) | buf[q + 2]
        const il = ((buf[q + 3] & 0xf) << 8) | buf[q + 4]
        if (st === 0x1b && videoPid < 0) videoPid = ep
        else if (st === 0x03 || st === 0x04 || st === 0x0f || st === 0x81) audioPids.add(ep)
        q += 5 + il
      }
      psi.push(p)
    }
    if (pmtPid >= 0 && videoPid >= 0) break
  }
  if (videoPid < 0) return null
  let cutIdx = -1
  let cutPts: number | null = null
  for (let i = 0; i < pk.length && cutIdx < 0; i++) {
    if (pk[i].pid !== videoPid || !pk[i].pusi) continue
    const hdr = pk[i].payload
    const dataStart = hdr + 9 + buf[hdr + 8]
    const chunk = new Uint8Array(600)
    let n = 0
    for (let j = i; j < pk.length && n < 600; j++) {
      if (j > i && pk[j].pid === videoPid && pk[j].pusi) break
      if (pk[j].pid !== videoPid) continue
      const from = j === i ? dataStart : pk[j].payload
      const take = Math.min(pk[j].off + TS - from, 600 - n)
      if (take > 0) {
        chunk.set(buf.subarray(from, from + take), n)
        n += take
      }
    }
    if (startsIntra(chunk.subarray(0, n))) {
      cutIdx = i
      cutPts = readPts(buf, hdr)
    }
  }
  return { pk, pmtPid, videoPid, audioPids, psi, cutIdx, cutPts }
}

/** Per audio packet: the PTS of the PES it belongs to (null for continuation packets of a PES begun earlier). */
function audioGroupPts(buf: Uint8Array, a: Analysis): (number | null)[] {
  const out: (number | null)[] = new Array(a.pk.length).fill(null)
  const cur = new Map<number, number | null>()
  a.pk.forEach((p, i) => {
    if (!a.audioPids.has(p.pid)) return
    if (p.pusi) cur.set(p.pid, readPts(buf, p.payload))
    out[i] = cur.has(p.pid) ? (cur.get(p.pid) ?? null) : null
  })
  return out
}

/**
 * Re-cuts segment `cur` so it runs from its own first I-picture up to the first I-picture of
 * `next`. Nothing is dropped: the pictures at the head of `cur` (which finish the previous GOP)
 * were appended to the previous output segment, and `cur` in turn takes the head of `next`.
 * Every output segment therefore starts on an I-picture, which Safari's native HLS needs, and
 * the stream stays continuous across segments.
 */
export function repackSegment(cur: Uint8Array, next: Uint8Array | null): Uint8Array {
  const a = analyze(cur)
  if (!a || a.cutIdx < 0 || a.cutPts === null) return cur
  const audioCur = audioGroupPts(cur, a)
  const keep: Uint8Array[] = []
  for (const p of a.psi) keep.push(cur.subarray(p.off, p.off + TS))
  a.pk.forEach((p, i) => {
    if (p.pid === 0 || p.pid === a.pmtPid) return
    if (p.pid === a.videoPid) {
      if (i >= a.cutIdx) keep.push(cur.subarray(p.off, p.off + TS))
    } else if (a.audioPids.has(p.pid)) {
      const g = audioCur[i]
      if (g !== null && g >= (a.cutPts as number)) keep.push(cur.subarray(p.off, p.off + TS))
    } else if (i >= a.cutIdx) keep.push(cur.subarray(p.off, p.off + TS))
  })
  if (next) {
    const b = analyze(next)
    if (b && b.cutIdx >= 0 && b.cutPts !== null && b.videoPid === a.videoPid) {
      const audioNext = audioGroupPts(next, b)
      b.pk.forEach((p, i) => {
        if (p.pid === b.videoPid) {
          if (i < b.cutIdx) keep.push(next.subarray(p.off, p.off + TS))
        } else if (b.audioPids.has(p.pid)) {
          const g = audioNext[i]
          if (g === null || g < (b.cutPts as number)) keep.push(next.subarray(p.off, p.off + TS))
        }
      })
    }
  }
  const out = new Uint8Array(keep.length * TS)
  keep.forEach((k, i) => out.set(k, i * TS))
  return out
}
