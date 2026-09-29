import { test, expect } from '@playwright/test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { onRequest as proxyHandler } from '../functions/api/proxy'
import { onRequest as streamsHandler } from '../functions/api/streams/index'

/**
 * /api/proxy and /api/streams decide by content, not by label. Each case runs the real
 * Function handler against a real local HTTP origin, so the fetch, streaming and
 * cancellation behaviour is the runtime's own rather than a stub's.
 */

const ORIGIN = 'https://streamloom.example'
const PLAYLIST = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg0.ts\n#EXT-X-ENDLIST\n'

let server: http.Server
let base = ''
const seen: { path: string; ua: string; referer: string | undefined; range: string | undefined }[] = []
let endlessOpen = 0

function tsChunk(): Buffer {
  const b = Buffer.alloc(188 * 7, 0xff)
  for (let i = 0; i < 7; i++) b[i * 188] = 0x47
  return b
}

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const ua = String(req.headers['user-agent'] ?? '')
    seen.push({ path: url.pathname, ua, referer: req.headers.referer, range: req.headers.range })
    switch (url.pathname) {
      case '/octet.m3u8':
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
        return void res.end(PLAYLIST)
      case '/bom':
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        return void res.end('﻿' + PLAYLIST)
      case '/quotes.m3u8':
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
        return void res.end(
          "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI='key1.bin'\n#EXT-X-MAP:URI=init.mp4,BYTERANGE=\"5@0\"\n#EXT-X-KEY:METHOD=AES-128,URI=\"key2.bin\"\n#EXTINF:4,\nseg0.ts\n",
        )
      case '/vlc-only.m3u8':
      case '/seg0.ts':
        if (!ua.startsWith('VLC/') || req.headers.referer) {
          res.writeHead(403, { 'Content-Type': 'text/plain' })
          return void res.end('forbidden')
        }
        res.writeHead(200, { 'Content-Type': url.pathname.endsWith('.ts') ? 'video/mp2t' : 'application/vnd.apple.mpegurl' })
        return void res.end(url.pathname.endsWith('.ts') ? tsChunk() : PLAYLIST)
      case '/endless.ts': {
        res.writeHead(200, { 'Content-Type': 'video/mp2t' })
        endlessOpen++
        const timer = setInterval(() => res.write(tsChunk()), 20)
        res.on('close', () => {
          clearInterval(timer)
          endlessOpen--
        })
        return
      }
      case '/mp2t-octet':
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
        return void res.end(tsChunk())
      case '/audio':
        res.writeHead(200, { 'Content-Type': 'audio/aac' })
        return void res.end(Buffer.from([0xff, 0xf1, 0x50, 0x80]))
      case '/html':
        res.writeHead(200, { 'Content-Type': 'text/html' })
        return void res.end('<!doctype html><html></html>')
      default:
        res.writeHead(404)
        return void res.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

test.afterAll(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

const ctx = (request: Request) => ({ request, env: {}, waitUntil: (p: Promise<unknown>) => void p.catch(() => {}) }) as never

function proxy(target: string, extra = ''): Promise<Response> {
  return Promise.resolve(
    proxyHandler(ctx(new Request(`${ORIGIN}/api/proxy?url=${encodeURIComponent(target)}${extra}`))),
  ) as Promise<Response>
}

test('an octet-stream playlist is rewritten', async () => {
  const res = await proxy(`${base}/octet.m3u8`)
  expect(res.status).toBe(200)
  expect(res.headers.get('cache-control')).toBe('no-store')
  expect(res.headers.get('content-length')).toBeNull()
  const text = await res.text()
  expect(text).toContain(`${ORIGIN}/api/proxy?url=${encodeURIComponent(`${base}/seg0.ts`)}`)
  expect(text).not.toMatch(/^seg0\.ts$/m)
})

test('a playlist with a BOM and a text/plain label is rewritten', async () => {
  const res = await proxy(`${base}/bom`)
  const text = await res.text()
  expect(text.startsWith('#EXTM3U')).toBe(true)
  expect(text).toContain('/api/proxy?url=')
})

test('single-quoted and unquoted URI attributes are rewritten', async () => {
  const text = await (await proxy(`${base}/quotes.m3u8`)).text()
  const key1 = encodeURIComponent(`${base}/key1.bin`)
  expect(text).toContain(`URI="${ORIGIN}/api/proxy?url=${key1}`)
  expect(text).toContain(`URI="${ORIGIN}/api/proxy?url=${encodeURIComponent(`${base}/init.mp4`)}`)
  expect(text).toContain(`,BYTERANGE="5@0"`)
  expect(text).toContain(encodeURIComponent(`${base}/key2.bin`))
  expect(text).not.toContain("URI='")
})

test('a never-ending TS body returns headers within a second and streams', async () => {
  const started = Date.now()
  const res = await proxy(`${base}/endless.ts`)
  expect(Date.now() - started).toBeLessThan(1000)
  expect(res.status).toBe(200)
  const reader = res.body!.getReader()
  const first = await reader.read()
  expect(first.value![0]).toBe(0x47)
  let bytes = first.value!.length
  while (bytes < 188 * 30) bytes += (await reader.read()).value!.length
  await reader.cancel()
  await expect.poll(() => endlessOpen, { timeout: 3000 }).toBe(0)
})

test('403 to a browser UA is retried once as VLC, and child URLs keep that identity', async () => {
  seen.length = 0
  const res = await proxy(`${base}/vlc-only.m3u8`, `&ref=${encodeURIComponent('https://ref.example/')}`)
  expect(res.status).toBe(200)
  const text = await res.text()
  expect(text).toContain('ua=VLC')
  expect(text).not.toContain('ref=')
  const vlc = seen.filter((s) => s.path === '/vlc-only.m3u8')
  expect(vlc).toHaveLength(2)
  expect(vlc[0].ua).toContain('Mozilla')
  expect(vlc[1].ua).toMatch(/^VLC\//)
  expect(vlc[1].referer).toBeUndefined()

  const child = text.split('\n').find((l) => l.startsWith('http'))!
  const segRes = await Promise.resolve(proxyHandler(ctx(new Request(child)))) as Response
  expect(segRes.status).toBe(200)
  expect((await segRes.arrayBuffer()).byteLength).toBeGreaterThan(188)
})

test('a VLC identity given up front needs no retry; a 404 is a 502', async () => {
  const res = await proxy(`${base}/seg0.ts`, '&ua=VLC/9')
  expect(res.status).toBe(200) // VLC identity accepted directly, no retry needed
  const denied = await proxy(`${base}/nope`)
  expect(denied.status).toBe(502)
})

test('Range is forwarded upstream', async () => {
  seen.length = 0
  const req = new Request(`${ORIGIN}/api/proxy?url=${encodeURIComponent(`${base}/mp2t-octet`)}`, { headers: { Range: 'bytes=0-99' } })
  await (await Promise.resolve(proxyHandler(ctx(req))) as Response).arrayBuffer()
  expect(seen[0].range).toBe('bytes=0-99')
})

test('an unreachable origin is 523 with X-Proxy-Error', async () => {
  const res = await proxy('http://127.0.0.1:1/x.m3u8')
  expect(res.status).toBe(523)
  expect(res.headers.get('x-proxy-error')).toBe('unreachable')
})

test('sniff=1 classifies from the first bytes', async () => {
  const kind = async (p: string) => (await (await proxy(`${base}${p}`, '&sniff=1')).json()).kind
  expect(await kind('/octet.m3u8')).toBe('hls')
  expect(await kind('/bom')).toBe('hls')
  expect(await kind('/endless.ts')).toBe('ts')
  expect(await kind('/mp2t-octet')).toBe('ts')
  expect(await kind('/audio')).toBe('ts')
  expect(await kind('/quotes.m3u8')).toBe('hls')
})

test('/api/streams: repeated url params, octet-stream TS, endless body and HTML', async () => {
  const q = new URLSearchParams({ channelId: 'sniff-1' })
  for (const p of ['/html', '/mp2t-octet']) q.append('url', `${base}${p}`)
  const started = Date.now()
  const res = (await Promise.resolve(streamsHandler(ctx(new Request(`${ORIGIN}/api/streams?${q}`))))) as Response
  const data = await res.json()
  expect(data.deadCandidates).toEqual([`${base}/html`])
  expect(data.workingStream).toBe(`${base}/mp2t-octet`)

  const q2 = new URLSearchParams({ channelId: 'sniff-2' })
  q2.append('url', `${base}/endless.ts`)
  const res2 = (await Promise.resolve(streamsHandler(ctx(new Request(`${ORIGIN}/api/streams?${q2}`))))) as Response
  expect((await res2.json()).workingStream).toBe(`${base}/endless.ts`)
  expect(Date.now() - started).toBeLessThan(4000)
  await expect.poll(() => endlessOpen, { timeout: 3000 }).toBe(0)
})
