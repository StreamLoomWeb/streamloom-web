import fs from 'node:fs'
import { execSync } from 'node:child_process'
import { repackSegment } from '/Users/surajchavda/workspace/StreamLoomWeb/.claude/worktrees/web-channel-playback-97b552/functions/api/_lib/tsTrim.ts'
const P = 'https://streamloom.softarchium.com/api/proxy?url='
const O = 'http://59.103.38.46:8000/play/a052/index.m3u8'
const txt = async u => (await fetch(u)).text()
const bin = async u => new Uint8Array(await (await fetch(u)).arrayBuffer())
for (let attempt = 0; attempt < 6; attempt++) {
  const variant = (await txt(P + encodeURIComponent(O))).split('\n').find(l => l.startsWith('http'))
  const segs = (await txt(variant)).split('\n').filter(l => l.startsWith('http'))
  if (segs.length < 4) continue
  const first3 = await Promise.all(segs.slice(0, 3).map(bin))            // oldest three: already complete
  await new Promise(r => setTimeout(r, 3300))
  const p2 = (await txt(variant)).split('\n').filter(l => l.startsWith('http'))
  if (!p2.includes(segs[3])) { console.log('seg3 already gone'); continue }
  const fourth = await bin(segs[3])                                       // now finished
  const bufs = [...first3, fourth]
  bufs.forEach((b, i) => fs.writeFileSync(`g4/t${i}.ts`, b))
  const durs = bufs.map((b, i) => +execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 g4/t${i}.ts 2>/dev/null`).toString().trim())
  console.log('attempt', attempt, bufs.map(b => b.length), durs)
  if (!bufs.every(b => b.length > 250000)) continue
  const outs = [0, 1, 2].map(i => repackSegment(bufs[i], bufs[i + 1]))
  outs.forEach((o, i) => fs.writeFileSync(`g4/r${i}.ts`, o))
  const rd = outs.map((_, i) => { const d = execSync(`ffprobe -v error -select_streams v:0 -show_entries packet=pts_time -of csv=p=0 g4/r${i}.ts 2>/dev/null`).toString().trim().split('\n').map(Number).filter(x => !isNaN(x)); return Math.round((Math.max(...d) - Math.min(...d) + 0.02) * 100) / 100 })
  console.log('repacked durations', rd)
  const hdr = e => `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n${e}`
  const body = rd.map((d, i) => `#EXTINF:${d.toFixed(3)},\nr${i}.ts\n`).join('')
  fs.writeFileSync('g4/live.m3u8', hdr('') + body); fs.writeFileSync('g4/vod.m3u8', hdr('#EXT-X-PLAYLIST-TYPE:VOD\n') + body + '#EXT-X-ENDLIST\n')
  console.log('DONE'); process.exit(0)
}
process.exit(1)
