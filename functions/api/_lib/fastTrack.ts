/**
 * Kicks off the backend's fast-track probe (ADR-0043, WO-19) for channels a save just pinned
 * that were not already pinned before it — the identity card (ADR-0042) already made them
 * visible; this is what makes them playable within seconds instead of waiting for the next
 * scheduled sync.
 *
 * Deliberately the only thing in this project that holds a GitHub credential, and deliberately
 * the *only* capability that credential has: `repository_dispatch` cannot read anything, write
 * anything in the repository, or trigger any workflow other than the one keyed to
 * `fast-track-pick`. It is not a Supabase or Upstash credential and cannot reach either.
 *
 * Never allowed to fail a save. The caller (`handleWrite`) runs this through `context.waitUntil`
 * after the picks write has already succeeded and already returned its response — a dispatch
 * that fails, times out, or the token being unset entirely all mean "this save's picks stay on
 * the identity card a little longer", never "the save did not happen".
 */

const REPO = 'StreamLoomBackEnd/streamloom-backend'
const DISPATCH_URL = `https://api.github.com/repos/${REPO}/dispatches`
const EVENT_TYPE = 'fast-track-pick'

/**
 * The real GitHub API by default; overridable only for the workerd smoke test
 * (`e2e/support/workerd-smoke/`), which has no way to reach api.github.com and instead
 * points this at a local stub to prove the `fetch` inside `waitUntil` actually completes
 * under real workerd — the one thing the Node-stubbed e2e suite cannot model. Mirrors
 * `IPTV_ORG_API_OVERRIDE` in the backend's `sync-worker/tools/fast-track.mjs`. Never set
 * in Cloudflare's dashboard; there is nothing there to override it with.
 */
function dispatchUrl(env: unknown): string {
  const override = (env as { FAST_TRACK_DISPATCH_URL_OVERRIDE?: unknown } | undefined)?.FAST_TRACK_DISPATCH_URL_OVERRIDE
  return typeof override === 'string' && override.trim().length > 0 ? override.trim() : DISPATCH_URL
}

/** Bounds one save's cost: a bulk-add pins many channels at once, this dispatches for at most this many. */
export const MAX_FAST_TRACK_IDS = 10

const FETCH_TIMEOUT_MS = 10_000

/**
 * True when `env` carries a token to dispatch with. Absent is a legitimate, quiet state — the
 * fast-track feature simply is not configured yet — never a reason to warn on every save.
 */
export function fastTrackConfigured(env: unknown): boolean {
  const token = (env as { GITHUB_DISPATCH_TOKEN?: unknown } | undefined)?.GITHUB_DISPATCH_TOKEN
  return typeof token === 'string' && token.trim().length > 0
}

/**
 * Dispatches one `repository_dispatch` naming up to [MAX_FAST_TRACK_IDS] channel ids. Resolves on
 * a 2xx, rejects otherwise (a non-2xx status, a network error, or a timeout) — the caller decides
 * what "otherwise" means, which is always "log it, never surface it to the save's own response".
 *
 * A no-op, resolving immediately, when the token is unset or `channelIds` is empty. The two are
 * NOT logged the same way: an empty `channelIds` is silent unconditionally (dispatching nothing
 * to fast-track would just be a GitHub Actions run that immediately does nothing, and this is the
 * common case on every save that only edits notes or reorders). A missing token with ids that
 * genuinely needed dispatching gets one low-volume warning instead — 2026-09-22 found, the hard
 * way, that "never configured" and "configured in Cloudflare but not yet reachable by this
 * deployment" (Cloudflare Pages snapshots secrets per deployment; see CLAUDE.md's Secrets section)
 * look identical from here, and the silence that was meant to spare an unconfigured project from
 * noise instead hid a real, fixable outage for hours with zero signal anywhere.
 */
export async function dispatchFastTrack(env: unknown, channelIds: readonly string[]): Promise<void> {
  if (channelIds.length === 0) return
  if (!fastTrackConfigured(env)) {
    console.warn(
      `[picks] fast-track not dispatched for ${channelIds.length} channel(s): no GITHUB_DISPATCH_TOKEN visible to this deployment. If one is configured in Cloudflare, a fresh Production deployment is needed for it to take effect.`,
    )
    return
  }
  const token = (env as { GITHUB_DISPATCH_TOKEN: string }).GITHUB_DISPATCH_TOKEN.trim()
  const ids = channelIds.slice(0, MAX_FAST_TRACK_IDS)

  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(dispatchUrl(env), {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'streamloom-web-picks-portal',
      },
      body: JSON.stringify({ event_type: EVENT_TYPE, client_payload: { channelIds: ids } }),
    })
    // A successful dispatch is 204 with no body (GitHub's own convention for this endpoint).
    if (!res.ok) throw new Error(`GitHub dispatch refused: ${res.status} ${await res.text().catch(() => '')}`)
  } finally {
    clearTimeout(timer)
  }
}
