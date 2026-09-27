// Test-only Pages Function. This directory (`e2e/support/workerd-smoke/`) is never
// deployed — Cloudflare's Pages project builds from the repo root's own `public`/`dist`
// and `functions/`, and `wrangler pages dev` is pointed at THIS directory only from the
// smoke test itself (`e2e/workerd-smoke.spec.ts`). It exists to prove `dispatchFastTrack`'s
// `fetch` — URL, headers, JSON body — behaves correctly under a real workerd runtime, not
// just in the Node-stubbed e2e suite (`e2e/picks-endpoint.spec.ts`), which is the class of
// gap that let the picks-portal 503 bug ship (a real `redirect: 'error'`/`'manual'`
// divergence between Node's fetch and workerd's).
//
// What this does NOT prove, confirmed empirically while writing it: whether omitting
// `context.waitUntil` entirely would have been caught. It would not have been — local
// `wrangler pages dev` keeps its whole process alive across a request rather than tearing
// an isolate down once its response is sent, so an un-awaited, un-waitUntil'd promise still
// gets to run to completion locally regardless. That specific failure mode (the one this
// test was originally written to catch) needs a real deployed environment to reproduce —
// which is exactly why the 2026-09-22 incident needed live production tailing to find.
import { dispatchFastTrack } from '../../../../../functions/api/_lib/fastTrack'

export const onRequestPost: PagesFunction = async (context) => {
  context.waitUntil(
    dispatchFastTrack(context.env, ['SmokeTestChannel.zz']).catch((err) => {
      console.warn(`[smoke] dispatch failed: ${err instanceof Error ? err.message : String(err)}`)
    }),
  )
  // Respond immediately, the same way handleWrite does. The test's mock can add an
  // artificial delay to its own response to prove this one doesn't wait for it — a real,
  // locally-verifiable property, unlike the waitUntil-teardown question above.
  return new Response('ok', { status: 200 })
}
