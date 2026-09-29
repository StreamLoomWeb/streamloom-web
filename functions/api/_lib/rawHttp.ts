/**
 * A minimal HTTP/1.0 client over a raw TCP socket, for plain-`http:` origins that a
 * Cloudflare Pages Function's `fetch()` refuses (raw IP literals, non-standard ports).
 *
 * Pure: the socket comes from an injectable `connect` factory (`cloudflare:sockets` in
 * production, a `node:net` adapter in tests), so this module imports nothing platform-specific.
 *
 * Limits of this path: no TLS, no HTTP/2, no keep-alive (one connection per request, HTTP/1.0 +
 * `Connection: close`). Chunked bodies are still decoded defensively.
 */

export interface RawSocket {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
  close(): Promise<void> | void
  /** `cloudflare:sockets` exposes these; they reject on a failed connection and must be observed. */
  opened?: Promise<unknown>
  closed?: Promise<unknown>
}
export type ConnectFn = (address: { hostname: string; port: number }) => RawSocket

const MAX_HEAD_BYTES = 64 * 1024
export const HEADER_TIMEOUT_MS = 8000
/** fetch() follows 20; 10 keeps real CDN chains working while bounding a loop. */
export const MAX_REDIRECTS = 10

function named(name: string, message: string): Error {
  const e = new Error(message)
  e.name = name
  return e
}

// ---- destination guard ----

function ipv4Blocked(a: number, b: number): boolean {
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    a >= 224 // multicast + reserved
  )
}

/** Expands an IPv6 literal (no brackets) to 8 groups, or null if malformed. */
function ipv6Groups(host: string): number[] | null {
  let h = host
  let tail: number[] = []
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h)
  if (v4) {
    const o = v4.slice(1).map(Number)
    tail = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]]
    h = h.slice(0, v4.index) + '0:0'
  }
  const halves = h.split('::')
  if (halves.length > 2) return null
  const parse = (s: string) => (s === '' ? [] : s.split(':').map((g) => parseInt(g, 16)))
  const head = parse(halves[0])
  const rest = halves.length === 2 ? parse(halves[1]) : []
  let groups: number[]
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length
    if (fill < 0) return null
    groups = [...head, ...new Array(fill).fill(0), ...rest]
  } else {
    groups = head
  }
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null
  if (tail.length) groups.splice(6, 2, ...tail)
  return groups
}

/** True when `hostname` (as `URL.hostname` gives it) is an IP literal. */
export function isIpLiteral(hostname: string): boolean {
  if (hostname.startsWith('[')) return true
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)
}

/** Why a destination must not be reached through the socket path, or null when allowed. */
export function blockedDestination(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return 'blocked: local hostname'
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const [a, b] = host.split('.').map(Number)
    return ipv4Blocked(a, b) ? 'blocked: private or reserved address' : null
  }
  if (host.startsWith('[')) {
    const g = ipv6Groups(host.slice(1, -1))
    if (!g) return 'blocked: malformed address'
    if (g.every((x, i) => (i === 7 ? x <= 1 : x === 0))) return 'blocked: loopback address' // :: and ::1
    if ((g[0] & 0xfe00) === 0xfc00) return 'blocked: private address' // fc00::/7
    if ((g[0] & 0xffc0) === 0xfe80) return 'blocked: link-local address' // fe80::/10
    if (g[0] === 0xff00 || (g[0] & 0xff00) === 0xff00) return 'blocked: multicast address'
    // IPv4-mapped / compatible (::ffff:a.b.c.d, ::a.b.c.d) and NAT64 (64:ff9b::a.b.c.d): judge
    // the embedded IPv4 in the last two groups.
    const mapped = g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)
    const nat64 = g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)
    if (mapped || nat64) {
      return ipv4Blocked(g[6] >> 8, g[6] & 0xff) ? 'blocked: private or reserved address' : null
    }
    // 6to4 (2002:AABB:CCDD::/48) embeds the IPv4 in groups 1-2.
    if (g[0] === 0x2002 && ipv4Blocked(g[1] >> 8, g[1] & 0xff)) return 'blocked: private or reserved address'
  }
  return null
}

/** Should this http: URL go over a raw socket instead of `fetch()`? */
export function socketEligible(url: URL): boolean {
  if (url.protocol !== 'http:') return false
  if (isIpLiteral(url.hostname)) return true
  return url.port !== '' && url.port !== '80' && url.port !== '443'
}

// ---- response parsing ----

function findHeadEnd(buf: Uint8Array): { end: number; sep: number } | null {
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 0x0a) {
      if (buf[i + 1] === 0x0a) return { end: i, sep: 2 }
      if (buf[i + 1] === 0x0d && buf[i + 2] === 0x0a) return { end: i, sep: 3 }
    }
  }
  return null
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/** Streaming `Transfer-Encoding: chunked` decoder. `push` returns decoded data; `done` flips at the last chunk's trailer. */
export class Dechunker {
  done = false
  private state: 'size' | 'data' | 'crlf' | 'trailer' = 'size'
  private line = ''
  private remaining = 0

  push(buf: Uint8Array): Uint8Array[] {
    const out: Uint8Array[] = []
    let i = 0
    while (i < buf.length && !this.done) {
      if (this.state === 'data') {
        const n = Math.min(this.remaining, buf.length - i)
        out.push(buf.subarray(i, i + n))
        i += n
        this.remaining -= n
        if (this.remaining === 0) this.state = 'crlf'
        continue
      }
      const byte = buf[i++]
      if (this.state === 'crlf') {
        if (byte === 0x0a) this.state = 'size'
        continue
      }
      if (byte !== 0x0a) {
        if (this.line.length > 1024) throw named('Error', 'chunk framing too long')
        this.line += String.fromCharCode(byte)
        continue
      }
      const line = this.line.replace(/\r$/, '')
      this.line = ''
      if (this.state === 'size') {
        const hex = line.split(';')[0].trim()
        if (!/^[0-9a-fA-F]+$/.test(hex)) throw named('Error', 'invalid chunk size')
        this.remaining = parseInt(hex, 16)
        this.state = this.remaining === 0 ? 'trailer' : 'data'
      } else if (line === '') {
        this.done = true
      }
    }
    return out
  }
}

export interface RawRequest {
  url: URL
  method?: string
  headers: Headers
  signal?: AbortSignal
  headerTimeoutMs?: number
}

/**
 * One HTTP/1.0 exchange. Resolves once the status line and headers are in, with a Response
 * whose body streams the rest. No redirect handling. Cancelling the body (or aborting `signal`)
 * closes the socket.
 */
export async function rawHttpRequest(connect: ConnectFn, req: RawRequest): Promise<Response> {
  const { url } = req
  const method = (req.method || 'GET').toUpperCase()
  const port = url.port ? Number(url.port) : 80
  const hostname = url.hostname // IPv6 keeps its brackets; connect() wants them stripped.
  const socket = connect({ hostname: hostname.startsWith('[') ? hostname.slice(1, -1) : hostname, port })
  // A refused connection rejects these as well as the read below; unobserved, they would surface
  // as unhandled rejections in workerd.
  socket.opened?.catch(() => {})
  socket.closed?.catch(() => {})
  let closed = false
  const closeSocket = () => {
    if (closed) return
    closed = true
    try {
      void Promise.resolve(socket.close()).catch(() => {})
    } catch {}
  }

  let lines = `${method} ${url.pathname}${url.search} HTTP/1.0\r\nHost: ${url.host}\r\n`
  const sent = new Set<string>()
  req.headers.forEach((value, name) => {
    const n = name.toLowerCase()
    if (n === 'host' || n === 'connection') return
    sent.add(n)
    lines += `${name}: ${value}\r\n`
  })
  if (!sent.has('accept')) lines += 'Accept: */*\r\n'
  lines += 'Connection: close\r\n\r\n'

  const reader = socket.readable.getReader()
  const onAbort = () => closeSocket()
  if (req.signal) {
    if (req.signal.aborted) {
      closeSocket()
      throw named('AbortError', 'aborted')
    }
    req.signal.addEventListener('abort', onAbort, { once: true })
  }

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    closeSocket()
    void reader.cancel().catch(() => {})
  }, req.headerTimeoutMs ?? HEADER_TIMEOUT_MS)

  try {
    const writer = socket.writable.getWriter()
    try {
      await writer.write(new TextEncoder().encode(lines))
    } finally {
      try {
        writer.releaseLock()
      } catch {}
    }

    let buf: Uint8Array = new Uint8Array(0)
    let head: { end: number; sep: number } | null = null
    while (!head) {
      const { done, value } = await reader.read()
      if (done) {
        if (timedOut) throw named('TimeoutError', 'upstream header timeout')
        if (req.signal?.aborted) throw named('AbortError', 'aborted')
        throw named('Error', 'connection closed before response headers')
      }
      if (value) buf = concat(buf, value)
      head = findHeadEnd(buf)
      if (!head && buf.length > MAX_HEAD_BYTES) throw named('Error', 'response headers too large')
    }
    clearTimeout(timer)

    const headText = new TextDecoder('latin1').decode(buf.subarray(0, head.end))
    const leftover = buf.subarray(head.end + head.sep)
    const [statusLine, ...headerLines] = headText.split(/\r?\n/)
    const m = /^HTTP\/1\.[01]\s+(\d{3})(?:\s+(.*))?$/.exec(statusLine.trim())
    if (!m) throw named('Error', 'malformed status line')
    const status = Number(m[1])
    const headers = new Headers()
    let lastName = ''
    for (const l of headerLines) {
      if (/^[ \t]/.test(l)) {
        // obs-fold (RFC 9112 §5.2): a continuation of the previous value, never a new header.
        if (lastName) {
          const prev = headers.get(lastName) ?? ''
          try {
            headers.set(lastName, `${prev} ${l.trim()}`.trim())
          } catch {}
        }
        continue
      }
      const c = l.indexOf(':')
      const name = c > 0 ? l.slice(0, c) : ''
      // A field name is a token with no surrounding whitespace; anything else is dropped.
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
        lastName = ''
        continue
      }
      try {
        headers.append(name, l.slice(c + 1).trim())
        lastName = name
      } catch {
        lastName = ''
      }
    }

    const chunked = /chunked/i.test(headers.get('transfer-encoding') || '')
    const declared = headers.get('content-length')
    const limit = !chunked && declared !== null && /^\d+$/.test(declared) ? Number(declared) : null
    if (chunked) headers.delete('content-length')
    // Hop-by-hop: they describe this socket, not the response being handed on.
    for (const h of ['transfer-encoding', 'connection', 'keep-alive', 'proxy-connection']) headers.delete(h)
    const bodiless = method === 'HEAD' || status === 204 || status === 304 || (status >= 100 && status < 200)

    const finish = () => {
      req.signal?.removeEventListener('abort', onAbort)
      closeSocket()
    }

    let body: ReadableStream<Uint8Array> | null = null
    if (bodiless) {
      finish()
      void reader.cancel().catch(() => {})
    } else {
      const dechunk = chunked ? new Dechunker() : null
      let seen = 0
      let first: Uint8Array[] | null = null
      const decode = (bytes: Uint8Array): Uint8Array[] => {
        if (dechunk) return dechunk.push(bytes)
        if (limit !== null) {
          const room = Math.max(0, limit - seen)
          bytes = bytes.subarray(0, room)
        }
        seen += bytes.length
        return bytes.length ? [bytes] : []
      }
      const complete = () => (dechunk ? dechunk.done : limit !== null && seen >= limit)
      first = decode(leftover)
      body = new ReadableStream<Uint8Array>({
        async pull(c) {
          try {
            while (true) {
              if (first) {
                const queued = first
                first = null
                for (const b of queued) c.enqueue(b)
                if (complete()) {
                  finish()
                  c.close()
                  return
                }
                if (queued.length) return
              }
              const { done, value } = await reader.read()
              if (done) {
                finish()
                if (dechunk && !dechunk.done) c.error(named('Error', 'chunked body truncated'))
                // A short body must fail, not pass as a complete (and corrupt) segment.
                else if (limit !== null && seen < limit) c.error(named('Error', 'body shorter than Content-Length'))
                else c.close()
                return
              }
              const out = value ? decode(value) : []
              for (const b of out) c.enqueue(b)
              if (complete()) {
                finish()
                c.close()
                return
              }
              if (out.length) return
            }
          } catch (err) {
            finish()
            c.error(err)
          }
        },
        cancel() {
          finish()
          return reader.cancel().catch(() => {})
        },
      })
    }

    // fetch() decodes gzip/deflate transparently and callers rely on that (the proxy strips
    // Content-Encoding and sniffs playlist bytes). No Accept-Encoding is sent, but some origins
    // compress anyway. A 206 is a byte range of the encoded entity and is passed through as is.
    const encoding = (headers.get('content-encoding') || '').trim().toLowerCase()
    const format = encoding === 'gzip' || encoding === 'x-gzip' ? 'gzip' : encoding === 'deflate' ? 'deflate' : null
    if (body && format && status !== 206) {
      body = body.pipeThrough(new DecompressionStream(format) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
      headers.delete('content-encoding')
      headers.delete('content-length')
    }

    // The reason phrase is not forwarded: it is free text a Response constructor may reject.
    return new Response(body, { status, headers })
  } catch (err) {
    clearTimeout(timer)
    req.signal?.removeEventListener('abort', onAbort)
    closeSocket()
    void reader.cancel().catch(() => {})
    throw err
  }
}

// ---- socket-or-fetch decision, with manual redirects ----

let connectPromise: Promise<ConnectFn | null> | null = null

/** `connect` from `cloudflare:sockets`, or null where that module does not exist (Node, Vite dev, tests). */
export function loadCloudflareConnect(): Promise<ConnectFn | null> {
  connectPromise ??= import('cloudflare:sockets').then(
    (m) => m.connect as unknown as ConnectFn,
    () => null,
  )
  return connectPromise
}

export interface UpstreamInit {
  method: string
  headers: Headers
  signal?: AbortSignal
  /** Override for tests; defaults to `cloudflare:sockets`. `null` disables the socket path. */
  connect?: ConnectFn | null
  fetchImpl?: typeof fetch
  /** Test seam: replaces the destination guard (the loopback test origin would be refused). */
  guard?: (hostname: string) => string | null
}

/**
 * Fetches `url` following up to 5 redirects by hand, choosing socket or `fetch()` per hop.
 * `finalUrl` is the URL of the response returned (the base for relative playlist entries).
 */
export type Transport = 'socket' | 'fetch'

export async function fetchUpstream(
  url: URL,
  init: UpstreamInit,
): Promise<{ response: Response; finalUrl: string; via: Transport }> {
  const doFetch = init.fetchImpl ?? fetch
  let current = url
  let method = init.method
  for (let hop = 0; ; hop++) {
    const { response, via } = await fetchHop(current, { ...init, method }, doFetch)
    const loc = response.headers.get('location')
    if ([301, 302, 303, 307, 308].includes(response.status) && loc) {
      if (response.status === 303 && method !== 'HEAD') method = 'GET'
      if (hop >= MAX_REDIRECTS) {
        try {
          await response.body?.cancel()
        } catch {}
        throw named('Error', 'too many redirects')
      }
      let next: URL
      try {
        next = new URL(loc, current)
      } catch {
        return { response, finalUrl: current.toString(), via }
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        return { response, finalUrl: current.toString(), via }
      }
      try {
        await response.body?.cancel()
      } catch {}
      current = next
      continue
    }
    return { response, finalUrl: current.toString(), via }
  }
}

async function fetchHop(url: URL, init: UpstreamInit, doFetch: typeof fetch): Promise<{ response: Response; via: Transport }> {
  const guard = init.guard ?? blockedDestination
  const connect = init.connect === undefined ? await loadCloudflareConnect() : init.connect
  const viaSocket = async (): Promise<{ response: Response; via: Transport }> => {
    const why = guard(url.hostname)
    if (why) throw named('Error', why)
    const response = await rawHttpRequest(connect as ConnectFn, { url, method: init.method, headers: init.headers, signal: init.signal })
    return { response, via: 'socket' }
  }

  if (connect && socketEligible(url)) return viaSocket()

  let failure: unknown = null
  try {
    const res = await doFetch(url.toString(), {
      method: init.method,
      headers: init.headers,
      redirect: 'manual',
      signal: init.signal,
    })
    // Cloudflare's own refusal of a subrequest surfaces as its 502.
    if (!(res.status === 502 && url.protocol === 'http:' && connect && !guard(url.hostname))) return { response: res, via: 'fetch' }
    try {
      await res.body?.cancel()
    } catch {}
  } catch (err) {
    if (init.signal?.aborted || !connect || url.protocol !== 'http:' || guard(url.hostname)) throw err
    failure = err
  }
  try {
    return await viaSocket()
  } catch (err) {
    throw failure && (err as Error)?.name !== 'TimeoutError' ? failure : err
  }
}
