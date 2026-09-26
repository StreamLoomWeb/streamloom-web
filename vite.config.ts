import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

interface EdgeStreamsPayload {
  channelId: string
  workingStream: string | null
  workingCandidates: string[]
  deadCandidates: string[]
  edgeNode: string
  timestamp: number
}

const edgeStreamCache = new Map<string, { payload: EdgeStreamsPayload; expiresAt: number }>()

async function probeStream(url: string, timeoutMs = 2500): Promise<boolean> {
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) return false

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    const res = await fetch(parsed.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Referer: parsed.origin,
        Range: 'bytes=0-2048',
      },
      signal: controller.signal,
      redirect: 'follow',
    })
    clearTimeout(timer)

    if (!res.ok && res.status !== 206) return false
    const ct = (res.headers.get('content-type') || '').toLowerCase()
    if (ct.includes('text/html')) return false

    const text = await res.text()
    const trimmed = text.trimStart().toLowerCase()
    return (
      trimmed.startsWith('#extm3u') ||
      ct.includes('mpegurl') ||
      ct.includes('video/')
    )
  } catch {
    return false
  }
}

function streamProxyPlugin(): Plugin {
  const streamsHandler = async (req: any, res: any) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        })
        res.end()
        return
      }

      const reqUrl = new URL(req.url ?? '', `http://${req.headers.host || 'localhost'}`)
      const channelId = reqUrl.searchParams.get('channelId') || 'unknown'
      const urlsParam = reqUrl.searchParams.get('urls') || ''
      const urlParams = reqUrl.searchParams.getAll('url')

      const rawList: string[] = []
      if (urlsParam) rawList.push(...urlsParam.split(',').map((u) => u.trim()))
      if (urlParams.length > 0) rawList.push(...urlParams.map((u) => u.trim()))
      const candidates = Array.from(new Set(rawList.filter((u) => u.length > 0)))

      if (candidates.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: 'Missing candidate stream URLs' }))
        return
      }

      // Check in-memory POP cache
      const now = Date.now()
      const cached = edgeStreamCache.get(channelId)
      if (cached && cached.expiresAt > now) {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'X-Cache': 'HIT',
          'X-Edge-POP': 'LOCAL-DEV',
        })
        res.end(JSON.stringify(cached.payload))
        return
      }

      // Synchronous probe on candidate 1 (and candidate 2 if first fails)
      const workingCandidates: string[] = []
      const deadCandidates: string[] = []

      const firstAlive = await probeStream(candidates[0], 2500)
      if (firstAlive) {
        workingCandidates.push(candidates[0])
      } else {
        deadCandidates.push(candidates[0])
        if (candidates.length > 1) {
          const secondAlive = await probeStream(candidates[1], 2500)
          if (secondAlive) {
            workingCandidates.push(candidates[1])
          } else {
            deadCandidates.push(candidates[1])
          }
        }
      }

      const payload: EdgeStreamsPayload = {
        channelId,
        workingStream: workingCandidates[0] || null,
        workingCandidates: [...workingCandidates],
        deadCandidates: [...deadCandidates],
        edgeNode: 'LOCAL-DEV',
        timestamp: now,
      }

      // Background job to probe remaining candidates and store in cache
      const remaining = candidates.filter(
        (u) => !workingCandidates.includes(u) && !deadCandidates.includes(u)
      )
      setTimeout(async () => {
        for (const url of remaining) {
          const ok = await probeStream(url, 3000)
          if (ok) {
            if (!payload.workingCandidates.includes(url)) payload.workingCandidates.push(url)
            if (!payload.workingStream) payload.workingStream = url
          } else {
            if (!payload.deadCandidates.includes(url)) payload.deadCandidates.push(url)
          }
        }
        edgeStreamCache.set(channelId, { payload, expiresAt: Date.now() + 2 * 3600 * 1000 })
      }, 0)

      edgeStreamCache.set(channelId, { payload, expiresAt: Date.now() + 2 * 3600 * 1000 })

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'X-Cache': 'MISS',
        'X-Edge-POP': 'LOCAL-DEV',
      })
      res.end(JSON.stringify(payload))
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ error: err.message || 'Internal error' }))
    }
  }

  /**
   * Local stand-in for /api/icons (:channelId).
   *
   * R2 only exists at the edge, and the edge route is read-only, so dev has
   * nothing to serve: reads answer 404 and every other method 405, exactly like
   * an empty bucket. Keeps the client's fallback path identical in dev.
   */
  const iconsHandler = (req: any, res: any) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      res.end()
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      res.writeHead(404, cors)
      res.end('Not found')
    } else {
      res.writeHead(405, { ...cors, Allow: 'GET, HEAD, OPTIONS' })
      res.end('Method not allowed')
    }
  }

  const proxyHandler = async (req: any, res: any) => {
    try {
      const reqUrl = new URL(req.url ?? '', `http://${req.headers.host || 'localhost'}`)
      const targetUrl = reqUrl.searchParams.get('url')

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        })
        res.end()
        return
      }

      if (!targetUrl) {
        res.writeHead(400, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' })
        res.end('Missing target url query parameter')
        return
      }

      const channelId = reqUrl.searchParams.get('channelId') || ''
      const rawFallbacks = reqUrl.searchParams.getAll('fallback')
        .flatMap((f) => f.split(','))
        .map((f) => f.trim())
        .filter(Boolean)

      let candidateUrls = Array.from(new Set([targetUrl, ...rawFallbacks]))

      if (channelId) {
        const cached = edgeStreamCache.get(channelId)
        if (cached && cached.payload.workingStream && candidateUrls.includes(cached.payload.workingStream)) {
          candidateUrls = [
            cached.payload.workingStream,
            ...candidateUrls.filter((u) => u !== cached.payload.workingStream),
          ]
        }
      }

      const customUa = reqUrl.searchParams.get('ua') || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      const customRef = reqUrl.searchParams.get('ref') || ''

      let lastError = ''

      for (let i = 0; i < candidateUrls.length; i++) {
        const candidate = candidateUrls[i]

        let parsedTarget: URL
        try {
          parsedTarget = new URL(candidate)
          if (!['http:', 'https:'].includes(parsedTarget.protocol)) continue
        } catch {
          continue
        }

        const headers: Record<string, string> = {
          'User-Agent': customUa,
          Referer: customRef || parsedTarget.origin,
        }
        if (req.headers.range) {
          headers.Range = req.headers.range as string
        }

        try {
          const controller = new AbortController()
          const timeoutMs = candidateUrls.length > 1 ? 5000 : 10000
          const timer = setTimeout(() => controller.abort(), timeoutMs)

          const upstream = await fetch(parsedTarget.toString(), {
            method: req.method || 'GET',
            headers,
            redirect: 'follow',
            signal: controller.signal,
          })
          clearTimeout(timer)

          const contentType = (upstream.headers.get('content-type') || '').toLowerCase()
          if (contentType.includes('text/html')) {
            const html = await upstream.text()
            if (html.trimStart().toLowerCase().startsWith('<!doctype') || html.trimStart().toLowerCase().startsWith('<html')) {
              lastError = `Candidate ${candidate} returned HTML error page`
              continue
            }
          }

          if (!upstream.ok && upstream.status !== 206) {
            lastError = `Candidate ${candidate} returned HTTP ${upstream.status}`
            continue
          }

          // Cache successful candidate for channel
          if (channelId) {
            const existing = edgeStreamCache.get(channelId)?.payload
            const workingCandidates = Array.from(new Set([candidate, ...(existing?.workingCandidates || [])]))
            const deadCandidates = (existing?.deadCandidates || []).filter((u) => u !== candidate)
            edgeStreamCache.set(channelId, {
              payload: {
                channelId,
                workingStream: candidate,
                workingCandidates,
                deadCandidates,
                edgeNode: 'LOCAL-DEV',
                timestamp: Date.now(),
              },
              expiresAt: Date.now() + 2 * 3600 * 1000,
            })
          }

          const resHeaders: Record<string, string> = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Expose-Headers': '*',
            'Accept-Ranges': 'bytes',
            'X-Stream-Resolved': candidate,
            'X-Edge-POP': 'LOCAL-DEV',
          }

          upstream.headers.forEach((value, key) => {
            const lower = key.toLowerCase()
            if (!['x-frame-options', 'content-security-policy', 'transfer-encoding', 'content-encoding'].includes(lower)) {
              resHeaders[key] = value
            }
          })

          const likelyM3U8 =
            contentType.includes('mpegurl') ||
            parsedTarget.pathname.toLowerCase().endsWith('.m3u8') ||
            candidate.toLowerCase().includes('.m3u8')

          if (likelyM3U8 || contentType.includes('text/') || contentType === '') {
            const text = await upstream.text()
            if (text.trimStart().startsWith('#EXTM3U')) {
              let baseStr = upstream.url
              if (!baseStr || baseStr === 'about:blank') {
                baseStr = parsedTarget.toString()
              }
              const baseUrl = new URL(baseStr)
              const proxyBase = '/api/proxy'

              const buildChildUrl = (raw: string) => {
                try {
                  const absolute = new URL(raw, baseUrl).toString()
                  const p = new URLSearchParams()
                  p.set('url', absolute)
                  if (customUa) p.set('ua', customUa)
                  if (customRef) p.set('ref', customRef)
                  return `${proxyBase}?${p.toString()}`
                } catch {
                  return raw
                }
              }

              const rewritten = text
                .split(/\r?\n/)
                .map((line) => {
                  const t = line.trim()
                  if (!t) return line
                  if (t.startsWith('#')) {
                    if (t.includes('URI="')) {
                      return t.replace(/URI="([^"]+)"/g, (_, uri) => {
                        return `URI="${buildChildUrl(uri)}"`
                      })
                    }
                    return line
                  }
                  return buildChildUrl(t)
                })
                .join('\n')

              resHeaders['Content-Type'] = 'application/vnd.apple.mpegurl; charset=utf-8'
              delete resHeaders['content-length']
              delete resHeaders['Content-Length']
              delete resHeaders['content-encoding']
              delete resHeaders['Content-Encoding']
              res.writeHead(upstream.status, resHeaders)
              res.end(rewritten)
              return
            }

            delete resHeaders['content-length']
            delete resHeaders['Content-Length']
            res.writeHead(upstream.status, resHeaders)
            res.end(text)
            return
          }

          if (upstream.headers.has('content-encoding')) {
            delete resHeaders['content-length']
            delete resHeaders['Content-Length']
          }
          res.writeHead(upstream.status, resHeaders)
          if (upstream.body) {
            const reader = upstream.body.getReader()
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              res.write(value)
            }
          }
          res.end()
          return
        } catch (err: any) {
          lastError = `Candidate ${candidate} error: ${err.message || err}`
          continue
        }
      }

      res.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' })
      res.end(`Proxy Error: All candidates failed. ${lastError}`)
    } catch (err: any) {
      res.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' })
      res.end(`Proxy Error: ${err.message || err}`)
    }
  }

  return {
    name: 'stream-proxy-dev',
    configureServer(server) {
      server.middlewares.use('/api/streams', streamsHandler)
      server.middlewares.use('/api/proxy', proxyHandler)
      server.middlewares.use('/api/icons', iconsHandler)
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/streams', streamsHandler)
      server.middlewares.use('/api/proxy', proxyHandler)
      server.middlewares.use('/api/icons', iconsHandler)
    },
  }
}

/**
 * Starts the catalogue pointer (`meta.json`, ADR-0030) downloading with the HTML.
 *
 * The client can only ask for it once its JavaScript has loaded and run, and every
 * catalogue object waits on it, so on a first visit it sat alone on the critical
 * path (measured ~0.5 s after the bundle). A preload lets it arrive while the bundle
 * downloads. Same URL, mode and credentials as the `fetch` in `src/api/r2.ts`, so the
 * browser hands that fetch the preloaded response instead of asking again.
 */
function cataloguePreloadPlugin(): Plugin {
  let base = ''
  return {
    name: 'catalogue-preload',
    configResolved(config) {
      base = String(config.env.VITE_CATALOGUE_R2_BASE_URL ?? '').trim().replace(/\/+$/, '')
    },
    transformIndexHtml() {
      let origin: string
      try {
        origin = new URL(base).origin
      } catch {
        return []
      }
      if (!/^https?:\/\//i.test(base)) return []
      return [
        { tag: 'link', attrs: { rel: 'preconnect', href: origin, crossorigin: 'anonymous' }, injectTo: 'head' },
        { tag: 'link', attrs: { rel: 'preload', as: 'fetch', href: `${base}/catalogue/meta.json`, crossorigin: 'anonymous' }, injectTo: 'head' },
      ]
    },
  }
}

export default defineConfig({
  envPrefix: ['VITE_', 'UPSTASH_'],
  plugins: [
    react(),
    streamProxyPlugin(),
    cataloguePreloadPlugin(),
  ],
  resolve: {
    alias: { '@': '/src' },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/hls.js')) return 'vendor-hls'
          if (
            id.includes('node_modules/react') ||
            id.includes('node_modules/react-dom') ||
            id.includes('node_modules/react-router')
          ) return 'vendor-react'
        },
      },
    },
  },
})
