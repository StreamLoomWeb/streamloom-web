# StreamLoom Web — Claude Code Instructions

**StreamLoom Web** is the high-performance browser-native Progressive Web App (PWA) companion to the [StreamLoom](https://github.com/SoftArchium/streamloom) Android/TV app. It delivers full live-TV streaming and EPG guide navigation across desktop, mobile, and smart TV browsers.

---

## The Four Core Rules

1. **User experience is the most important thing.**
   - Desktop and Smart TV browsers must be supported equally.
   - Every state must be actionable: no dead ends, no infinite blank loading screens.
   - Keyboard & TV remote navigation must never drop keys or lock up.

2. **Streaming resilience is non-negotiable.**
   - Plain HTTP streams must work on HTTPS deployments without mixed-content errors.
   - Multi-stream channels must automatically shuffle to alternate candidates if a stream is dead or stalls.
   - Working streams must be cached so channels load instantly on return.

3. **Verify locally before concluding.**
   - Always run the gate: `npm run lint` (`oxlint`) and `npm run build` (`tsc -b && vite build`).
   - Zero lint errors and zero lint warnings.
   - Clean production build with no TypeScript discrepancies.

4. **Token & performance discipline.**
   - Do not serialize 11,000-channel arrays to `sessionStorage` or history state on every channel change.
   - Clean up HLS instances and event listeners on unmount.
   - Never commit `.env`, private keys, or API tokens.

---

## Quick Reference Commands

```bash
npm run dev          # Start local Vite dev server with built-in M3U8 stream proxy (default: http://localhost:5173 or 5174)
npm run build        # Typecheck and build production bundle to dist/
npm run lint         # Run oxlint (zero warnings required)
npm run preview      # Preview production build locally
```

---

## Architectural Overview

```
streamloom-web/
├── functions/api/            # Cloudflare Pages Functions (the only server-side code)
│   ├── proxy.ts              # M3U8 rewriting & CORS proxying
│   ├── streams/              # Edge stream verification (resolution-ranked probe)
│   ├── icons/[channelId].ts  # READ-ONLY view of the channel-icons bucket (WO-01 closed its write path)
│   ├── picks/index.ts        # Author's picks: GET / PUT, behind a verified Access JWT (ADR-0033)
│   ├── picks/channels.ts     # Picker search over the iptv-org list, same Access gate
│   └── _lib/                 # Shared, non-routed: accessJwt.ts, picksSchema.ts, iptvOrg.ts
├── public/
│   └── _headers              # Security & cache headers; /admin is noindex + no-store
├── src/
│   ├── api/
│   │   ├── r2.ts             # R2 snapshot client — the PRIMARY catalogue read path (ADR-0030)
│   │   ├── r2Contract.ts     # Object layout, meta/row/picks decoding (pure; shared with the golden test)
│   │   ├── catalogueSource.ts# Picks the store: R2 first, Redis on any miss or timeout
│   │   ├── redis.ts          # Upstash Redis REST read-only client — the FALLBACK (ADR-0015)
│   │   └── types.ts          # Catalogue + EPG payload types (erased at build)
│   ├── components/
│   │   ├── ChannelCard.tsx   # Channel card with thumbnail, country, resolution badges
│   │   ├── CategoryRow.tsx   # Horizontal genre rail with deferred card mounting
│   │   ├── PicksRow.tsx      # Author's picks rail; never filtered by a broken mark (ADR-0033)
│   │   ├── HeroSection.tsx   # Featured banner with instant playback
│   │   ├── Navbar.tsx        # Top navigation, search, and category filters
│   │   └── VideoPlayer.tsx   # HLS.js video engine, failover watchdog, TV remote navigation
│   ├── hooks/
│   │   └── useChannels.ts    # Catalogue loader, in-memory cache, working stream prioritization
│   ├── pages/
│   │   ├── Home.tsx          # Channel grid, category rails, continue watching
│   │   ├── Guide.tsx         # EPG timeline guide
│   │   ├── Watch.tsx         # Video playback route with playlist memory
│   │   ├── Settings.tsx      # Low-latency, auto-skip, hide-broken toggles, cache reset
│   │   └── Admin.tsx         # UNLISTED picks portal at /admin (lazy chunk, behind Cloudflare Access)
│   ├── util/
│   │   ├── resolution.ts     # Resolution ranking + resolution-first candidate ordering
│   │   ├── stream.ts         # Edge proxy URL generator, working stream cache, broken stream registry
│   │   ├── streamFailure.ts  # Classifies a failed attempt: stream / network / inconclusive
│   │   ├── catalogueStore.ts # IndexedDB persistence of the catalogue and schedules by generation
│   │   ├── country.ts        # Country code to flag/name formatting
│   │   └── shortcuts.ts      # Keyboard navigation helpers
│   └── vite.config.ts        # Vite config with dev streamProxyPlugin mirroring Cloudflare Edge Function
```

### Where the data comes from

| | Store | Written by | Read by the browser |
|---|---|---|---|
| Catalogue, EPG | **R2 snapshots** (`catalogue/g<N>/…`, ADR-0030/0034) | the sync worker, from the backend repo | `src/api/r2.ts`, first |
| Catalogue, EPG | Upstash Redis (ADR-0015) | the same worker | `src/api/redis.ts`, only when R2 cannot serve |
| Author's picks | **R2** (`catalogue/picks.json`, ADR-0033) | **this project**, through the `CATALOGUE_BUCKET` binding | `fetchPicksFromR2` |
| Icons | R2 (`channel-icons`) | the backend icon pipeline (ADR-0019) | `/api/icons/:id`, read-only |

Supabase is never called from the browser, and **no Supabase key or Upstash write token
belongs in this repository** (backend `CLAUDE.md`, "Secrets"). The project's only write
capability is the R2 binding on `/api/picks` — never an API token, never a `VITE_` variable.

### How this project is deployed

It is a **Cloudflare Pages** project. `wrangler.jsonc` here has no `pages_build_output_dir`,
which is what would make it the source of truth, so it applies to `wrangler pages dev` only:
**the deployed project reads its bindings and variables from the Cloudflare dashboard**
(Workers & Pages → `streamloomweb` → Settings). A binding added to `wrangler.jsonc` has no
effect on production until it is added in the dashboard as well, and adding
`pages_build_output_dir` would discard every setting currently held there.

---

## Key Technical Patterns

### 1. Edge Proxy & M3U8 Rewriting
- **Problem**: Browsers on HTTPS block plain `http://` streams (mixed content); direct TLS connections to raw stream IPs fail with SSL handshake errors; stream servers omit CORS headers.
- **Solution**: Cloudflare Pages Edge Function (`functions/api/proxy.ts`) and Vite dev plugin (`vite.config.ts`) rewrite `#EXTM3U` playlists to route sub-playlists and media chunks through `/api/proxy?url=...`.
- **Crucial Rule**: When modifying text bodies in the proxy, **always delete `content-length` and `content-encoding` headers**. Otherwise, the browser cuts off the rewritten M3U8 mid-URL, resulting in `Manifest parsing error: invalid M3U8`.
- Preserve `ua` and `ref` query params on child chunk URLs for authenticated streams.

### 2. Multi-Stream Candidate Shuffling & Caching
- Channels in Supabase often provide multiple stream candidates (`channel.streams`).
- `VideoPlayer.tsx` features a **progress-aware watchdog** (`START_IDLE_MS`, `START_CAP_MS`, `STALL_IDLE_MS`, `STALL_CAP_MS`): an attempt that receives no media bytes for the idle window fails over; one whose bytes are still arriving on a slow link is left to finish, up to the cap. Media bytes are fragment (`arraybuffer`) XHR progress with a 2xx status, or native-HLS buffer growth, never playlist refreshes or error bodies, so a stuck live stream still fails over as fast as before.
  - If a stream stalls or errors, it tries edge proxy (if direct) or advances to the next stream candidate.
  - When a candidate works (`MANIFEST_PARSED` / `FRAG_BUFFERED`), it is cached via `cacheWorkingStream(channel.id, url, isProxied)` in `sl_working_streams_v1` (7-day TTL).
  - `enrichChannels` in `useChannels.ts` unshifts cached working streams to index 0 so subsequent visits load instantly.
  - If a cached stream fails in the future, candidate shuffling automatically finds a new working stream and updates the cache (self-healing).

### 2b. Resolution-First Selection
- **Rule**: `Stream.quality` (`"4K"`, `"FHD"`, `"1080p"`, `"HD"`, `"SD"`, ...) decides candidate order. The highest resolution candidate is always index 0.
- `src/util/resolution.ts` owns `rankResolution()` and `orderStreamsForPlayback()`; `enrich.ts`, `VideoPlayer.tsx` and `functions/api/streams.ts` all use the same ranking so client and edge never disagree.
- A cached working stream keeps the front position **only** while no higher resolution candidate exists, so a previously cached 360p stream cannot pin a channel away from its 1080p feed.
- `/api/streams` accepts `qualities` aligned positionally with `urls`, ranks candidates by resolution before probing, and caches the highest resolution candidate that verified live.
- `cacheWorkingStream(channelId, url, useProxy, quality?)` persists the resolution label alongside the URL.

### 2c. Broken-Stream Marks (the hide/skip rule)
- **Rule**: a channel is hidden or skipped only when the user explicitly turns that setting on (`sl_hide_broken`, `sl_auto_skip`; both default off), and a failure caused by the user's own network must never change what is shown.
- `VideoPlayer.tsx` classifies every failed attempt (`src/util/streamFailure.ts`): `stream` (origin 4xx/5xx except 408/425/429, manifest/level/frag parse, codec, native decode/unsupported), `network` (no response), `inconclusive` (timeouts, the watchdogs, aborts, unknown).
- On exhaustion, `recordStreamFailure()` calls `markStreamBroken` only when `navigator.onLine`, a same-origin probe (`/favicon.svg?probe=`) succeeds, and **every** candidate's last attempt was `stream`. Auto-skip also requires the probe to pass.
- Never call `markStreamBroken` from a player error path directly. Marks written before this rule are purged once (`sl_broken_reset_v1`).
- Hangs are never marked, so the user can hide a channel themselves (player HUD 🚫, slow-connecting and error overlays). `sl_hidden_channels_v1` holds their choice: no TTL, applies regardless of hide-broken, untouched by the mark purge and cache reset, undone per channel or all at once in Settings → Hidden Channels. It filters `channels` in `useChannels` and the playlists in `Watch.tsx`.
- `e2e/stream-failure.spec.ts` covers offline, probe failure, timeout, origin 404, voluntary hide, defaults and migration.

### 3. Startup & Channel-Switch Latency
- HLS runs with `enableWorker: false` — worker spawn costs 100–300 ms on low-end TV browsers while the parse work is negligible.
- `testBandwidth: false` plus `startFragPrefetch`, with `abrEwmaDefaultEstimate` seeded from the speed hls.js measured last time on this device and network (`src/util/bandwidth.ts`, `sl_bandwidth_v1`; saved only from a teardown while playing). A fast link starts on its best level with no ramp-up; a slow one never starts on a level it cannot sustain.
- `App.tsx` prefetches the player chunk (hls.js) once a catalogue is on screen and the page is idle (skipped under Save-Data and on 2G), so the first channel opened does not wait on it.
- `vite.config.ts` injects a preload of `catalogue/meta.json` into `index.html`, so the catalogue pointer arrives while the bundle downloads rather than after it runs.
- `src/util/preconnect.ts` opens the connection (DNS, TCP, TLS; no bytes, no Function invocation) to the stream server the player will try first: for a card after a short focus/hover dwell, and for both neighbours once the current channel plays. Proxied streams are skipped (same origin, already connected); so is Save-Data. Live playlists are not cacheable, so fetching a neighbour's manifest ahead of time warmed nothing and is no longer done.
- Opening a channel (card, guide row, hero) fetches its first playlist at once (`src/util/playlistPrefetch.ts`), and the player's playlist loader (`HandoffLoader`) takes it in place of its own first request: the request starts ~100 ms sooner (measured). Direct streams on the hls.js path only; a failed, stale (>5 s) or overdue prefetch falls through to an ordinary request, and retries never use it.
- The search index is keyed on the catalogue array itself (`searchIndexFor` in `searchText.ts`), so a background refresh can never leave a memoised search on the previous generation. The catalogue worker ships it ready-built; otherwise (a return visit, or the main-thread fallback) it is built at idle after the grid paints, or on the first search if that comes sooner.

### 4. Catalogue Read Path & Read Budget
- **Rule**: **R2 first, Redis only as a fallback** (ADR-0030). `catalogueSource.ts` asks `r2.ts`
  for `catalogue/meta.json` and the generation's objects; on any miss, malformed object, 5xx or
  timeout it falls through to `redis.ts` and puts R2 into a 30-second cooldown so a dead CDN
  costs one timeout rather than one per request. Nothing in `r2.ts` throws.
- **Rule**: every Upstash read is metered, and the read-only token is public. Read only what is on screen, and never re-download what has not changed. R2 reads are not metered per request, but the generation comparison below applies to both stores.
- `VITE_CATALOGUE_R2_BASE_URL` is required: `scripts/check-env.mjs` fails the build without it, because Vite inlines it and a missing value ships a bundle that silently reads nothing.
- The catalogue is compared by generation first: `loadData` reads the meta object (one small GET, concurrent callers share it) and skips the download when the stored generation matches. The stored record carries its `generation`; the worker receives the `meta` already read, so it does not read it again.
- The guide (`EpgGuide.tsx`) fetches schedules only for rows in or just beyond the viewport, after scrolling settles. Never re-introduce a timer that prefetches every guide channel.
- Schedules are persisted in the `schedules` object store of the same IndexedDB (`catalogueStore.ts`), keyed by `<generation>:<channelId>`, and read by `scheduleLoader.ts` before Redis. An entry expires when every programme has ended or the generation changes; a write also drops other generations.
- `e2e/guide-requests.spec.ts` counts reads against an in-process Upstash mock (`e2e/support/upstashMock.ts`) and fails on a regression. Do not use `MGET` until it is confirmed to bill as one command.

### 5. The Author's Picks and the Only Write Path

- **Rule**: a pinned channel is shown **whether or not it plays** (ADR-0033 §3). `PicksRow` reads
  `allChannels` — the list *before* the hidden and broken filters — and never consults
  `getBrokenSet`, `getHiddenSet` or the hide-broken / auto-skip settings. **The pin wins.** A pin
  with no stream shows "No stream available"; a group is hidden only when it is empty. Any read
  error renders the row not at all. The WO-11 failure rules are untouched: a pinned channel still
  records and marks its failures, the mark simply does not remove it from this row.
- **Rule**: `/api/picks` verifies the `Cf-Access-Jwt-Assertion` JWT **itself** —
  signature against the team's JWKS, `kid`, RS256 only, `aud`, `iss`, `exp`/`nbf` — so a
  misconfigured or deleted Access application cannot expose the write. The URL path, the `Origin`
  header and every other client-settable value take no part in the decision.
- **Rule**: **fail closed.** Missing `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD`, a malformed
  `CF_ACCESS_ALLOWED_EMAILS`, an unreadable JWKS, a `CATALOGUE_BUCKET` that is not an R2 binding,
  a bound bucket that does not contain `catalogue/meta.json`, or an iptv-org list that could not
  be read or is over 24 hours old each end the request with 503 and **write nothing**. Never add
  a route that is unauthenticated "for now".
- **Rule**: an unauthenticated caller gets a generic refusal (`{"error":"unauthorised"}`), never
  the reason, a variable name or anything about the hosting. The reason goes to `console.warn`,
  which Pages observability captures; the setup guidance lives in README.md.
- The binding is wrapped in a three-method facade (`get`/`head`/`put`) before use, so the R2
  binding's `delete` is unreachable from this route at runtime, not only in the types.
- Every `channelId` is checked against the public iptv-org list at save time; `blocklist.json`
  entries and `is_nsfw` channels are refused, `closed`/`replaced_by` accepted with a warning.
  `picks.json` is written with an `If-Match` ETag (a stale write is a 412 carrying the newer copy)
  and every save also writes an append-only `picks-history/<updatedAt>.json` that is never
  overwritten or deleted.
- `/admin` is unlisted: no link, no sitemap, `noindex` and `no-store`. That is hygiene, not the
  access control. There is deliberately **no Vite dev stand-in** for `/api/picks`, so the portal
  works only where Access is in front of it; the handlers are tested directly in
  `e2e/picks-endpoint.spec.ts` with a generated RSA keypair.

### 6. FixerBot Buffering Mascot
- **Rule**: `FixerBotMascot.tsx`/`.css` are a verbatim port of the Android/TV FixerBot character and choreography (design history in the FixerBot plan's "Web parity (StreamLoomWeb)" section, prototyped live as claude.ai Artifact `VFzxVdTaYLdjwfK8sH4Fdy`) — not a redesign. The palette (pearl/blue/steel/visor/eyes/wrench/badge hexes, all inline on the SVG) and the choreography's numeric timing tables are kept identical across every Streamloom client on purpose, so they must never be remapped to this repo's `--accent`/`--accent-2` "Agate Black" tokens.
- Replaces the plain spinner in `VideoPlayer.tsx`'s `player__state-overlay--connecting` (same `isBuffering && !hasError` trigger; the spinner div itself, `.guide-loader`, is untouched since `Guide.tsx`/`Favorites.tsx` still use it elsewhere).
- The rig mutates SVG attributes directly on refs inside one `requestAnimationFrame` loop — never through React state per frame, the same "never read animated values through a recomposition" discipline the Android side follows for its own `Canvas` rig.
- `prefers-reduced-motion` freezes on a single designed still frame (mid-`ratchet`, wrench on the band, mood focused) instead of starting the loop, and disables the ring's CSS spin — never a blank or mid-transition frame.
- `src/api/occasion.ts` reads a small backend-published occasion document (`catalogue:occasion`, schema `{"schema":1,"occasions":[{"id":string,"region"?:string}]}` per streamloom-backend's ADR-0047 — not yet merged as of this writing) through the existing `redisGet()` client. Multiple occasions can be active at once for different regions, so `resolveAccessory()` prefers an entry matching this device's own locale region, falls back to a region-less (global) entry, else none. Fallback discipline mirrors `fetchCatalogueMeta()`: a failed/malformed read keeps the last successfully-decoded accessory; a successful read — including an occasion id not yet in `OCCASION_ACCESSORY`, or an empty `occasions` array — updates it to "no accessory," since that's a real decoded state, not a failure. The backend document doesn't exist yet as of this writing, so today this always renders no accessory, by design.

### 2d. Telemetry (ADR-0032, ADR-0047)
- **Rule**: aggregate counts, no identifier, opt-out. Nothing that could name a person is ever sent or stored: no IP, user agent, referrer, cookie, install or session id, hash, search text or client clock. Never add a third-party analytics SDK.
- `functions/api/_lib/telemetryContract.ts` is a line-for-line port of the backend's `sync-worker/telemetry-contract.js` and is tested against `e2e/support/telemetry-golden.json` (`e2e/telemetry-contract.spec.ts`). Change it only by porting a backend change and copying the regenerated fixture in the same commit; never edit its rules from memory.
- `functions/api/t.ts`: `Sec-GPC: 1` / `DNT: 1` → 204 before the body is read; `validateBatch` decides; a channel id not in `catalogue/active-channel-ids.json` is dropped, not refused (and dropped, not accepted, when the list cannot be read); one `writeDataPoint(waePoint(...))` per accepted event. Never log a header, body or address here or in `functions/api/stats.ts`.
- **Rule**: `functions/api/t.ts` also drops any request whose `cf.country` is `CN`, with an empty 204, before its method or body are looked at, and logs nothing about it — the China-origin backstop described in README.md's "The China-origin backstop at `POST /api/t`" section (streamloom-android ADR-0035, streamloom-backend ADR-0049). This repo has no `docs/adr/`; region-tiering design notes for this repo live in that README section, not in a new ADR format. Whether `src/telemetry/`'s own opt-out should adopt the same region tiering is a separate, still-open owner decision — do not change the client's opt-out behavior to "fix" this without that decision being made.
- `functions/api/stats.ts` verifies the Access JWT with `_lib/accessJwt.ts` before anything else, applies `foldGeo` per day and platform before answering, and caches ten minutes. `/admin/analytics` and `/api/stats` are under the `/admin` Access application.
- The client (`src/telemetry/`) is fire-and-forget: `sendBeacon` on `pagehide`, hidden `visibilitychange`, and every five minutes; at most 20 events / 2 KB per request; at most one `play_fail` per stream per session; `play_fail` only for `stream`-class failures (`streamFailure.ts`), never network or timeouts. The in-app opt-out (`sl_telemetry_optout`) is checked before `navigator.globalPrivacyControl`, and once set nothing is sent.
- `e2e/telemetry-endpoint.spec.ts`, `e2e/stats-endpoint.spec.ts` and `e2e/telemetry-client.spec.ts` are the gate; `e2e/workerd-smoke.spec.ts` also runs `/api/t` under real workerd.

### 7. Delight features (local-only, no identifier, no autoplay on Home)
- **Surprise me**: nav button and `*` key (`SurpriseMe.tsx`, `util/surprise.ts`); weights come from `sl_cat_weights_v1` and the working-stream cache, never leave the device. In the player `*` zaps directly (`switchChannelCleanly`). FixerBot is reused unchanged; the spin is a CSS wrapper, still and short under reduced motion.
- **Sleep timer** (`hooks/useSleepTimer.ts`, `Z` key / HUD button): 30/60/90 min, last minute dims and fades audio, ends on a calm "Good night" card; volume is always restored.
- **Starting soon** (`StartingSoon.tsx`, `util/reminders.ts`, `ReminderHost.tsx`): favourites whose next programme starts within 45 min; at most 8 schedule reads; reminders are in-app toasts only (no Notification API/push).
- **Flip preview**: 800 ms dwell on a drawer row shows now/next (`FlipPreview.tsx`); warms the origin via `util/preconnect.ts` only, no second video.
- **Resume line** (`ResumeLine.tsx`, `sl_last_watch_v1`): cold start within 6 h, one dismissible line, never autoplays.
- Telemetry for these is deliberately not added: any new event needs the backend contract updated first (port `telemetryContract.ts` + golden fixture in one commit).

### 3. Keyboard & Smart TV Navigation
- Navigation uses a single stable listener pattern with `onKeyRef` in `VideoPlayer.tsx` to ensure zero dropped keypresses.
- Keys:
  - **Previous Channel**: `ArrowLeft`, `ArrowUp`, `[`, `p`, `P`, `ChannelUp`, `PageUp`, `MediaTrackPrevious`
  - **Next Channel**: `ArrowRight`, `ArrowDown`, `]`, `n`, `N`, `ChannelDown`, `PageDown`, `MediaTrackNext`
  - **Number entry**: digits `0-9` build a 1-based playlist position ("CH 1 2 _"), jump after 1.5 s or on `Enter`; `Backspace` deletes a digit, `Escape` cancels. Digits are handled before every other key.
  - **Last channel**: `L` / `MediaLast` (previous channel kept in `sl_prev_channel`)
  - **Playback**: Space (play/pause), `M` (mute), `F` (fullscreen), `Esc` / `Backspace` (exit/back).
- Custom playlists are preserved only for filtered subsets (`< 500` items) to avoid serializing giant arrays to `sessionStorage` on every keypress.

---

## Coding Guidelines

- **TypeScript**: Strict types. Use types exported from `src/api/supabase.ts` and `src/hooks/useChannels.ts`.
- **React 19**: Avoid synchronous `setState` calls directly at the root of `useEffect` (use microtasks or action-driven updates to satisfy `oxlint`).
- **Memory & Lifecycle**: Clean up `Hls` instances (`stopLoad()`, `detachMedia()`, `destroy()`) and all window timers in `useEffect` cleanups.
- **CSS**: Pure CSS with CSS variables (`src/styles/`). Use glassmorphism and modern responsive layout primitives.
- **Git Workflow**: Always commit and push changes to `main` once completed and verified.
