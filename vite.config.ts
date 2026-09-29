import { createServer, defineConfig } from 'vite'
import type { Connect, Plugin, ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'

type EdgeModule = { onRequest: (ctx: unknown) => Promise<Response> | Response }
type EdgeLoader = () => Promise<EdgeModule>

/**
 * Runs a Pages Function handler for a Node request, so dev and preview execute the
 * very code that ships (functions/api/proxy.ts, functions/api/streams/index.ts)
 * rather than a hand-kept copy that can drift from it.
 */
async function runEdgeFunction(load: EdgeLoader, req: any, res: any): Promise<void> {
  try {
    const mod = await load()
    const host = req.headers.host || 'localhost'
    const request = new Request(new URL(req.originalUrl ?? req.url ?? '/', `http://${host}`), {
      method: req.method || 'GET',
      headers: Object.fromEntries(
        Object.entries(req.headers).filter(([, v]) => typeof v === 'string') as [string, string][],
      ),
    })
    const response = await mod.onRequest({
      request,
      env: {},
      waitUntil: (p: Promise<unknown>) => {
        p.catch(() => {})
      },
    })
    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      headers[key] = value
    })
    res.writeHead(response.status, headers)
    if (!response.body) {
      res.end()
      return
    }
    const reader = response.body.getReader()
    res.on('close', () => {
      reader.cancel().catch(() => {})
    })
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (res.destroyed) break
      if (!res.write(value)) await new Promise((resolve) => res.once('drain', resolve))
    }
    res.end()
  } catch (err: any) {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' })
    }
    res.end(`Proxy Error: ${err?.message || err}`)
  }
}

function streamProxyPlugin(): Plugin {
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

  const install = (
    middlewares: Connect.Server,
    loadModule: (file: string) => Promise<EdgeModule>,
  ) => {
    middlewares.use('/api/streams', (req, res) => {
      void runEdgeFunction(() => loadModule('/functions/api/streams/index.ts'), req, res)
    })
    middlewares.use('/api/proxy', (req, res) => {
      void runEdgeFunction(() => loadModule('/functions/api/proxy.ts'), req, res)
    })
    middlewares.use('/api/icons', iconsHandler)
    middlewares.use('/api/t', telemetryDevSink)
  }

  return {
    name: 'stream-proxy-dev',
    configureServer(server) {
      install(server.middlewares, (file) => server.ssrLoadModule(file) as Promise<EdgeModule>)
    },
    configurePreviewServer(server) {
      // A preview server has no module loader, so borrow a private middleware-mode dev server.
      let loader: Promise<ViteDevServer> | null = null
      install(server.middlewares, async (file) => {
        loader ??= createServer({
          configFile: false,
          appType: 'custom',
          logLevel: 'silent',
          server: { middlewareMode: true, hmr: false, watch: null },
        })
        return (await loader).ssrLoadModule(file) as Promise<EdgeModule>
      })
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

/**
 * Local stand-in for POST /api/t (ADR-0032). The real Function writes to an Analytics Engine
 * binding the dev server does not have, so this answers the way the endpoint would to a client —
 * 204 for a GPC/DNT request, 202 otherwise — and keeps nothing: no body is read, nothing is
 * logged. Without it the SPA fallback would answer a beacon with index.html.
 */
const telemetryDevSink: Connect.NextHandleFunction = (req, res) => {
  const optedOut = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.trim() === '1'
  const status = optedOut(req.headers['sec-gpc']) || optedOut(req.headers['dnt']) ? 204 : req.method === 'POST' ? 202 : 405
  req.resume()
  res.statusCode = status
  res.setHeader('Cache-Control', 'no-store')
  res.end()
}

/**
 * The app version the telemetry batch carries (`a`, `APP_VERSION_RE`: a short token). The Pages
 * build exposes the commit as `CF_PAGES_COMMIT_SHA`; a local build falls back to package.json.
 */
function appVersion(): string {
  const sha = process.env.CF_PAGES_COMMIT_SHA
  if (typeof sha === 'string' && /^[0-9a-f]{7,40}$/.test(sha)) return sha.slice(0, 7)
  const version = process.env.npm_package_version
  return typeof version === 'string' && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/.test(version) ? version : 'dev'
}

export default defineConfig({
  envPrefix: ['VITE_', 'UPSTASH_'],
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
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
          if (id.includes('node_modules/mpegts.js')) return 'vendor-mpegts'
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
