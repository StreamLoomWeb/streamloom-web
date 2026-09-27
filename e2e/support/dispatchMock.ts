import http from 'node:http'

/**
 * A real local HTTP server standing in for `api.github.com` for the workerd smoke test
 * (`e2e/workerd-smoke.spec.ts`) only — nothing else points at this. `dispatchFastTrack`'s
 * `FAST_TRACK_DISPATCH_URL_OVERRIDE` is aimed here instead of the real GitHub API, which
 * this project's code never allows in production (see `functions/api/_lib/fastTrack.ts`'s
 * own comment on why the override exists at all).
 */

export const DISPATCH_MOCK_PORT = 5197
export const DISPATCH_MOCK_URL = `http://127.0.0.1:${DISPATCH_MOCK_PORT}/repos/StreamLoomBackEnd/streamloom-backend/dispatches`

export interface DispatchMockRequest {
  body: unknown
  headers: http.IncomingHttpHeaders
}

export interface DispatchMock {
  requests: DispatchMockRequest[]
  /** Delay, in ms, before responding to the next request(s) — proves a caller's own
   *  response doesn't wait for this one to finish. 0 (the default) responds immediately. */
  delayMs: number
  listen(): Promise<void>
  close(): Promise<void>
}

export function createDispatchMock(): DispatchMock {
  const requests: DispatchMockRequest[] = []
  const state = { delayMs: 0 }
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      requests.push({ body: raw ? JSON.parse(raw) : null, headers: req.headers })
      setTimeout(() => res.writeHead(204).end(), state.delayMs)
    })
  })
  return {
    requests,
    get delayMs() {
      return state.delayMs
    },
    set delayMs(value: number) {
      state.delayMs = value
    },
    listen: () =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(DISPATCH_MOCK_PORT, '127.0.0.1', resolve)
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
