import { test, expect } from '@playwright/test'
import net from 'node:net'
import { gzipSync } from 'node:zlib'
import { Readable, Writable } from 'node:stream'
import type { AddressInfo } from 'node:net'
import { MAX_REDIRECTS, blockedDestination, fetchUpstream, rawHttpRequest, socketEligible, type ConnectFn } from '../functions/api/_lib/rawHttp'

/**
 * The raw-socket HTTP/1.0 client behind /api/proxy for plain-http IP / non-standard-port origins.
 * `cloudflare:sockets` does not exist here, so a node:net adapter stands in for `connect`; the
 * parsing, dechunking, redirect and cancel behaviour under test is the module's own.
 */

const nodeConnect: ConnectFn = ({ hostname, port }) => {
  const sock = net.connect({ host: hostname, port })
  return {
    readable: Readable.toWeb(sock) as unknown as ReadableStream<Uint8Array>,
    writable: Writable.toWeb(sock) as unknown as WritableStream<Uint8Array>,
    close: () => void sock.destroy(),
  }
}

const PLAYLIST = '#EXTM3U\n#EXTINF:4,\nseg0.ts\n'
let server: net.Server
let port = 0
let endlessClosed = false
const requests: string[] = []

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test.beforeAll(async () => {
  server = net.createServer((sock) => {
    let data = ''
    sock.on('error', () => {})
    sock.on('data', async (d) => {
      data += d.toString('latin1')
      if (!data.includes('\r\n\r\n')) return
      const first = data.split('\r\n')[0]
      requests.push(data)
      const path = first.split(' ')[1].split('?')[0]
      data = ''
      switch (path) {
        case '/playlist':
          sock.end(`HTTP/1.0 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\n\r\n${PLAYLIST}`)
          return
        case '/chunked':
          sock.write('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: text/plain\r\n\r\n')
          sock.write('5\r\nhello\r\n')
          await sleep(20)
          sock.write('6;ext=1\r\n world\r\n')
          sock.write('0\r\nX-Trailer: 1\r\n\r\n')
          return // deliberately left open: the terminating chunk must end the body
        case '/split':
          sock.write('HTTP/1.0 200 OK\r\nContent-Ty')
          await sleep(20)
          sock.write('pe: text/plain\r\nX-A: b\r\n\r')
          await sleep(20)
          sock.write('\nHEAD')
          await sleep(20)
          sock.end('ER-SPLIT')
          return
        case '/redirect':
          sock.end(`HTTP/1.0 302 Found\r\nLocation: /playlist\r\n\r\n`)
          return
        case '/endless':
          sock.on('close', () => (endlessClosed = true))
          sock.write('HTTP/1.0 200 OK\r\nContent-Type: video/mp2t\r\n\r\n')
          for (;;) {
            if (sock.destroyed) return
            sock.write(Buffer.alloc(4096, 0x47))
            await sleep(5)
          }
        case '/silent':
          return
        case '/echo':
          // The raw request head as the body, so a test can see exactly what went on the wire.
          sock.end(`HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\n\r\n${first}`)
          return
        case '/gzip': {
          const gz = gzipSync(Buffer.from(PLAYLIST))
          sock.write(`HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ${gz.length}\r\n\r\n`)
          sock.end(gz)
          return
        }
        case '/short':
          sock.end('HTTP/1.0 200 OK\r\nContent-Length: 100\r\n\r\nonly-ten!!')
          return
        case '/long':
          sock.end('HTTP/1.0 200 OK\r\nContent-Length: 4\r\n\r\nfourEXTRA')
          return
        case '/nocontent':
          sock.end('HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n')
          return
        case '/range': {
          const rangeHeader = /\r\nrange: ([^\r]*)/i.exec(requests[requests.length - 1])?.[1] ?? ''
          sock.end(`HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-3/10\r\nContent-Length: 4\r\nX-Got-Range: ${rangeHeader}\r\n\r\nabcd`)
          return
        }
        case '/head':
          // Advertises a body a HEAD response must not wait for; the socket is left open.
          sock.write('HTTP/1.1 200 OK\r\nContent-Length: 999\r\nContent-Type: video/mp2t\r\n\r\n')
          return
        case '/fold':
          sock.end(
            'HTTP/1.0 200 OK\r\nX-Folded: one\r\n two\r\n\tInjected: evil\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n' +
              'Connection: keep-alive\r\nKeep-Alive: timeout=5\r\nBad Name: x\r\n\r\nok',
          )
          return
        case '/reason':
          sock.end('HTTP/1.1 200 \u00ff\u00fe weird\r\nContent-Length: 2\r\n\r\nok')
          return
      }
      sock.end('HTTP/1.0 404 Not Found\r\n\r\n')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
})
test.afterAll(() => void server.close())

const req = (path: string, extra: Record<string, string> = {}, opts: { headerTimeoutMs?: number } = {}) =>
  rawHttpRequest(nodeConnect, {
    url: new URL(`http://127.0.0.1:${port}${path}`),
    headers: new Headers({ 'User-Agent': 'unit', ...extra }),
    ...opts,
  })

test('reads status, headers and body; sends an HTTP/1.0 request with Host, UA and Range', async () => {
  const res = await req('/playlist?x=1', { Range: 'bytes=0-9', Referer: 'http://r.example/' })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('application/vnd.apple.mpegurl')
  expect(await res.text()).toBe(PLAYLIST)
  const sent = requests.find((r) => r.startsWith('GET /playlist?x=1 HTTP/1.0\r\n'))!
  expect(sent).toContain(`Host: 127.0.0.1:${port}\r\n`)
  expect(sent.toLowerCase()).toContain('user-agent: unit\r\n')
  expect(sent.toLowerCase()).toContain('range: bytes=0-9')
  expect(sent.toLowerCase()).toContain('referer: http://r.example/')
  expect(sent).toContain('Connection: close\r\n')
})

test('decodes a chunked body and stops at the terminating chunk', async () => {
  const res = await req('/chunked')
  expect(res.headers.get('transfer-encoding')).toBeNull()
  expect(await res.text()).toBe('hello world')
})

test('headers and body split across TCP packets', async () => {
  const res = await req('/split')
  expect(res.headers.get('content-type')).toBe('text/plain')
  expect(res.headers.get('x-a')).toBe('b')
  expect(await res.text()).toBe('HEADER-SPLIT')
})

test('redirects are followed by hand, per hop', async () => {
  const { response, finalUrl } = await fetchUpstream(new URL(`http://127.0.0.1:${port}/redirect`), {
    method: 'GET',
    headers: new Headers(),
    connect: nodeConnect,
    guard: () => null,
  })
  expect(finalUrl).toBe(`http://127.0.0.1:${port}/playlist`)
  expect(await response.text()).toBe(PLAYLIST)
})

test('cancelling the body closes the socket', async () => {
  endlessClosed = false
  const res = await req('/endless')
  const reader = res.body!.getReader()
  const { value } = await reader.read()
  expect(value!.length).toBeGreaterThan(0)
  await reader.cancel()
  await expect.poll(() => endlessClosed).toBe(true)
})

test('a server that never answers times out with TimeoutError', async () => {
  await expect(req('/silent', {}, { headerTimeoutMs: 150 })).rejects.toMatchObject({ name: 'TimeoutError' })
})

test('the destination guard refuses private, loopback, link-local and CGNAT targets', () => {
  for (const h of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.1.1', '0.0.0.0', '[::1]', '[::]', '[fc00::1]', '[fd12::1]', '[fe80::1]', '[::ffff:127.0.0.1]', '[::ffff:10.0.0.1]', 'localhost', 'x.localhost']) {
    expect(blockedDestination(new URL(`http://${h}:8000/`).hostname), h).not.toBeNull()
  }
  for (const h of ['59.103.38.46', '202.70.146.135', '172.32.0.1', '100.128.0.1', '[2001:db8::1]', 'example.com']) {
    expect(blockedDestination(new URL(`http://${h}:8000/`).hostname), h).toBeNull()
  }
})

test('fetchUpstream refuses a loopback target on the socket path without connecting', async () => {
  let called = false
  const connect: ConnectFn = () => {
    called = true
    throw new Error('should not connect')
  }
  await expect(
    fetchUpstream(new URL('http://127.0.0.1:8000/x'), { method: 'GET', headers: new Headers(), connect }),
  ).rejects.toThrow(/blocked/)
  expect(called).toBe(false)
})

test('socket eligibility: http with an IP literal or non-standard port only', () => {
  expect(socketEligible(new URL('http://59.103.38.46:8000/a'))).toBe(true)
  expect(socketEligible(new URL('http://1.2.3.4/a'))).toBe(true)
  expect(socketEligible(new URL('http://example.com:8080/a'))).toBe(true)
  expect(socketEligible(new URL('http://example.com/a'))).toBe(false)
  expect(socketEligible(new URL('https://1.2.3.4:8443/a'))).toBe(false)
})

test('CRLF in the URL cannot split the request: the URL parser removes or encodes it', async () => {
  const res = await rawHttpRequest(nodeConnect, {
    url: new URL(`http://127.0.0.1:${port}/crlf\r\nX-Injected: 1?q=a\r\nb%0d%0a`),
    headers: new Headers(),
  })
  await res.arrayBuffer()
  const sent = requests[requests.length - 1]
  expect(sent.split('\r\n')[0]).toBe('GET /crlfX-Injected:%201?q=ab%0d%0a HTTP/1.0')
  expect(sent).not.toMatch(/^X-Injected/im)
  // Header values with CR/LF never reach the wire either: Headers refuses them.
  expect(() => new Headers({ 'User-Agent': 'a\r\nX-Evil: 1' })).toThrow()
})

test('userinfo and fragment are not sent; the Host header keeps the port', async () => {
  const res = await rawHttpRequest(nodeConnect, {
    url: new URL(`http://user:pass@127.0.0.1:${port}/echo#frag`),
    headers: new Headers(),
  })
  expect(await res.text()).toBe('GET /echo HTTP/1.0')
  const sent = requests[requests.length - 1]
  expect(sent).toContain(`\r\nHost: 127.0.0.1:${port}\r\n`)
  expect(sent).not.toContain('user')
  expect(sent).not.toContain('frag')
  expect(sent.toLowerCase()).not.toContain('accept-encoding')
})

test('a gzip body is decoded like fetch() would, and its encoding headers dropped', async () => {
  const res = await req('/gzip')
  expect(res.headers.get('content-encoding')).toBeNull()
  expect(res.headers.get('content-length')).toBeNull()
  expect(await res.text()).toBe(PLAYLIST)
})

test('a body shorter than Content-Length fails rather than passing as complete', async () => {
  const res = await req('/short')
  await expect(res.arrayBuffer()).rejects.toThrow()
})

test('bytes beyond Content-Length are not passed on', async () => {
  expect(await (await req('/long')).text()).toBe('four')
})

test('204 has no body', async () => {
  const res = await req('/nocontent')
  expect(res.status).toBe(204)
  expect(res.body).toBeNull()
})

test('Range is forwarded and a 206 passes through with Content-Range', async () => {
  const res = await req('/range', { Range: 'bytes=0-3' })
  expect(res.status).toBe(206)
  expect(res.headers.get('x-got-range')).toBe('bytes=0-3')
  expect(res.headers.get('content-range')).toBe('bytes 0-3/10')
  expect(await res.text()).toBe('abcd')
})

test('HEAD resolves on the headers alone, without waiting for the advertised body', async () => {
  const res = await rawHttpRequest(nodeConnect, {
    url: new URL(`http://127.0.0.1:${port}/head`),
    method: 'HEAD',
    headers: new Headers(),
    headerTimeoutMs: 2000,
  })
  expect(res.status).toBe(200)
  expect(res.body).toBeNull()
  expect(res.headers.get('content-type')).toBe('video/mp2t')
})

test('folded headers stay in their header; hop-by-hop headers are dropped; bad names ignored', async () => {
  const res = await req('/fold')
  expect(res.headers.get('x-folded')).toBe('one two Injected: evil')
  expect(res.headers.get('injected')).toBeNull()
  expect(res.headers.get('connection')).toBeNull()
  expect(res.headers.get('keep-alive')).toBeNull()
  expect([...res.headers.keys()]).not.toContain('bad name')
  // Both cookies are parsed (the proxy then deletes Set-Cookie wholesale).
  expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2'])
  expect(await res.text()).toBe('ok')
})

test('an odd reason phrase does not break the response', async () => {
  const res = await req('/reason')
  expect(res.status).toBe(200)
  expect(await res.text()).toBe('ok')
})

test('a refused connection rejects cleanly (no unhandled rejection)', async () => {
  const closed = net.createServer()
  await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r))
  const deadPort = (closed.address() as AddressInfo).port
  await new Promise<void>((r) => closed.close(() => r()))
  const unhandled: unknown[] = []
  const onUnhandled = (e: unknown) => unhandled.push(e)
  process.on('unhandledRejection', onUnhandled)
  try {
    await expect(
      rawHttpRequest(nodeConnect, { url: new URL(`http://127.0.0.1:${deadPort}/`), headers: new Headers() }),
    ).rejects.toBeTruthy()
    await sleep(50)
    expect(unhandled).toEqual([])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('aborting the signal mid-body closes the socket', async () => {
  endlessClosed = false
  const ac = new AbortController()
  const res = await rawHttpRequest(nodeConnect, {
    url: new URL(`http://127.0.0.1:${port}/endless`),
    headers: new Headers(),
    signal: ac.signal,
  })
  const reader = res.body!.getReader()
  await reader.read()
  ac.abort()
  await expect.poll(() => endlessClosed).toBe(true)
  await reader.cancel().catch(() => {})
})

test('the guard cannot be bypassed by alternative IPv4 spellings, IPv6 embeddings or userinfo', () => {
  for (const u of [
    'http://2130706433:8000/', // decimal
    'http://0x7f.1:8000/', // hex + short form
    'http://017700000001:8000/', // octal
    'http://0177.0.0.1:8000/',
    'http://127.1:8000/',
    'http://127.0.0.1.:8000/', // trailing dot
    'http://evil.com@127.0.0.1:8000/', // userinfo
    'http://[::ffff:127.0.0.1]:8000/',
    'http://[::ffff:7f00:1]:8000/',
    'http://[0:0:0:0:0:ffff:a9fe:a9fe]:8000/', // mapped 169.254.169.254
    'http://[::127.0.0.1]:8000/', // IPv4-compatible
    'http://[64:ff9b::a00:1]:8000/', // NAT64 10.0.0.1
    'http://[2002:c0a8:101::1]:8000/', // 6to4 192.168.1.1
    'http://[ff02::1]:8000/',
    'http://LOCALHOST.:8000/',
  ]) {
    expect(blockedDestination(new URL(u).hostname), u).not.toBeNull()
  }
  for (const u of ['http://[64:ff9b::3b67:262e]:8000/', 'http://[2002:3b67:262e::1]:8000/', 'http://996615726:8000/']) {
    expect(blockedDestination(new URL(u).hostname), u).toBeNull()
  }
})

test('a redirect loop stops at the hop cap and does not leak the redirect bodies', async () => {
  let hops = 0
  const fetchImpl = (async () => {
    hops++
    return new Response('x', { status: 302, headers: { Location: '/again' } })
  }) as typeof fetch
  await expect(
    fetchUpstream(new URL('https://example.com/start'), { method: 'GET', headers: new Headers(), connect: null, fetchImpl }),
  ).rejects.toThrow(/too many redirects/)
  expect(hops).toBe(MAX_REDIRECTS + 1)
})

test('a redirect from https to a plain-http IP origin switches that hop to the socket path', async () => {
  const seen: string[] = []
  const fetchImpl = (async (u: string) => {
    seen.push(u)
    return new Response(null, { status: 302, headers: { Location: `http://127.0.0.1:${port}/playlist` } })
  }) as unknown as typeof fetch
  const { response, finalUrl, via } = await fetchUpstream(new URL('https://cdn.example/start'), {
    method: 'GET',
    headers: new Headers(),
    connect: nodeConnect,
    fetchImpl,
    guard: () => null,
  })
  expect(seen).toEqual(['https://cdn.example/start'])
  expect(via).toBe('socket')
  expect(finalUrl).toBe(`http://127.0.0.1:${port}/playlist`)
  expect(await response.text()).toBe(PLAYLIST)
})

test('303 turns a non-GET into GET; 307 keeps the method', async () => {
  const methods: string[] = []
  let n = 0
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    methods.push(String(init.method))
    n++
    if (n === 1) return new Response(null, { status: 307, headers: { Location: '/b' } })
    if (n === 2) return new Response(null, { status: 303, headers: { Location: '/c' } })
    return new Response('done')
  }) as unknown as typeof fetch
  const { response } = await fetchUpstream(new URL('https://cdn.example/a'), { method: 'POST', headers: new Headers(), connect: null, fetchImpl })
  expect(await response.text()).toBe('done')
  expect(methods).toEqual(['POST', 'POST', 'GET'])
})
