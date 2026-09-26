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
├── functions/api/proxy.ts    # Cloudflare Pages Edge Function for M3U8 rewriting & CORS proxying
├── public/
│   ├── _headers              # Cloudflare Pages security & caching headers
│   └── _redirects            # SPA fallback (/* /index.html 200)
├── src/
│   ├── api/
│   │   ├── redis.ts          # Upstash Redis REST read-only client (ADR-0015 edge catalogue cache)
│   │   └── types.ts          # Catalogue + EPG payload types (erased at build)
│   ├── components/
│   │   ├── ChannelCard.tsx   # Channel card with thumbnail, country, resolution badges
│   │   ├── HeroSection.tsx   # Featured banner with instant playback
│   │   ├── Navbar.tsx        # Top navigation, search, and category filters
│   │   └── VideoPlayer.tsx   # HLS.js video engine, failover watchdog, TV remote navigation
│   ├── hooks/
│   │   └── useChannels.ts    # Catalogue loader, in-memory cache, working stream prioritization
│   ├── pages/
│   │   ├── Home.tsx          # Channel grid, category rails, continue watching
│   │   ├── Guide.tsx         # EPG timeline guide
│   │   ├── Watch.tsx         # Video playback route with playlist memory
│   │   └── Settings.tsx      # Low-latency, auto-skip, hide-broken toggles, cache reset
│   ├── util/
│   │   ├── resolution.ts     # Resolution ranking + resolution-first candidate ordering
│   │   ├── stream.ts         # Edge proxy URL generator, working stream cache, broken stream registry
│   │   ├── country.ts        # Country code to flag/name formatting
│   │   └── shortcuts.ts      # Keyboard navigation helpers
│   └── vite.config.ts        # Vite config with dev streamProxyPlugin mirroring Cloudflare Edge Function
```

---

## Key Technical Patterns

### 1. Edge Proxy & M3U8 Rewriting
- **Problem**: Browsers on HTTPS block plain `http://` streams (mixed content); direct TLS connections to raw stream IPs fail with SSL handshake errors; stream servers omit CORS headers.
- **Solution**: Cloudflare Pages Edge Function (`functions/api/proxy.ts`) and Vite dev plugin (`vite.config.ts`) rewrite `#EXTM3U` playlists to route sub-playlists and media chunks through `/api/proxy?url=...`.
- **Crucial Rule**: When modifying text bodies in the proxy, **always delete `content-length` and `content-encoding` headers**. Otherwise, the browser cuts off the rewritten M3U8 mid-URL, resulting in `Manifest parsing error: invalid M3U8`.
- Preserve `ua` and `ref` query params on child chunk URLs for authenticated streams.

### 2. Multi-Stream Candidate Shuffling & Caching
- Channels in Supabase often provide multiple stream candidates (`channel.streams`).
- `VideoPlayer.tsx` features a **6.5s watchdog timer**:
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
- `VideoPlayer.tsx` classifies every failed attempt (`src/util/streamFailure.ts`): `stream` (origin 4xx/5xx except 408/425/429, manifest/level/frag parse, codec, native decode/unsupported), `network` (no response), `inconclusive` (timeouts, the 7s/8s watchdogs, aborts, unknown).
- On exhaustion, `recordStreamFailure()` calls `markStreamBroken` only when `navigator.onLine`, a same-origin probe (`/favicon.svg?probe=`) succeeds, and **every** candidate's last attempt was `stream`. Auto-skip also requires the probe to pass.
- Never call `markStreamBroken` from a player error path directly. Marks written before this rule are purged once (`sl_broken_reset_v1`).
- Hangs are never marked, so the user can hide a channel themselves (player HUD 🚫, slow-connecting and error overlays). `sl_hidden_channels_v1` holds their choice: no TTL, applies regardless of hide-broken, untouched by the mark purge and cache reset, undone per channel or all at once in Settings → Hidden Channels. It filters `channels` in `useChannels` and the playlists in `Watch.tsx`.
- `e2e/stream-failure.spec.ts` covers offline, probe failure, timeout, origin 404, voluntary hide, defaults and migration.

### 3. Startup & Channel-Switch Latency
- HLS runs with `enableWorker: false` — worker spawn costs 100–300 ms on low-end TV browsers while the parse work is negligible.
- `testBandwidth: false` plus `startFragPrefetch` and `abrEwmaDefaultEstimate: 5 Mbps` avoid an ABR ramp-up from low quality on fast connections.
- `VideoPlayer.tsx` warms the next channel's resolved manifest with a `priority: 'low'` fetch 1.5 s after playback starts, so the browser and edge cache are primed before the user switches.

### 4. Redis Read Budget
- **Rule**: every Upstash read is metered, and the read-only token is public. Read only what is on screen, and never re-download what has not changed.
- The catalogue is compared by generation first: `loadData` reads `catalogue:meta` (`fetchCatalogueMeta`, one GET, concurrent callers share it) and skips the download when the stored generation matches. The stored record carries its `generation`; the worker receives the `meta` already read, so it does not read it again.
- The guide (`EpgGuide.tsx`) fetches schedules only for rows in or just beyond the viewport, after scrolling settles. Never re-introduce a timer that prefetches every guide channel.
- Schedules are persisted in the `schedules` object store of the same IndexedDB (`catalogueStore.ts`), keyed by `<generation>:<channelId>`, and read by `scheduleLoader.ts` before Redis. An entry expires when every programme has ended or the generation changes; a write also drops other generations.
- `e2e/guide-requests.spec.ts` counts reads against an in-process Upstash mock (`e2e/support/upstashMock.ts`) and fails on a regression. Do not use `MGET` until it is confirmed to bill as one command.

### 5. FixerBot Buffering Mascot
- **Rule**: `FixerBotMascot.tsx`/`.css` are a verbatim port of the Android/TV FixerBot character and choreography (design history in the FixerBot plan's "Web parity (StreamLoomWeb)" section, prototyped live as claude.ai Artifact `VFzxVdTaYLdjwfK8sH4Fdy`) — not a redesign. The palette (pearl/blue/steel/visor/eyes/wrench/badge hexes, all inline on the SVG) and the choreography's numeric timing tables are kept identical across every Streamloom client on purpose, so they must never be remapped to this repo's `--accent`/`--accent-2` "Agate Black" tokens.
- Replaces the plain spinner in `VideoPlayer.tsx`'s `player__state-overlay--connecting` (same `isBuffering && !hasError` trigger; the spinner div itself, `.guide-loader`, is untouched since `Guide.tsx`/`Favorites.tsx` still use it elsewhere).
- The rig mutates SVG attributes directly on refs inside one `requestAnimationFrame` loop — never through React state per frame, the same "never read animated values through a recomposition" discipline the Android side follows for its own `Canvas` rig.
- `prefers-reduced-motion` freezes on a single designed still frame (mid-`ratchet`, wrench on the band, mood focused) instead of starting the loop, and disables the ring's CSS spin — never a blank or mid-transition frame.
- `src/api/occasion.ts` reads a small backend-published occasion document (`catalogue:occasion`, schema `{"schema":1,"active":string|null}`) through the existing `redisGet()` client. Fallback discipline mirrors `fetchCatalogueMeta()`: a failed/malformed read keeps the last successfully-decoded accessory; a successful read — including an `active` id not yet in `OCCASION_ACCESSORY` — updates it to "no accessory," since that's a real decoded state, not a failure. The backend document doesn't exist yet as of this writing, so today this always renders no accessory, by design.

### 3. Keyboard & Smart TV Navigation
- Navigation uses a single stable listener pattern with `onKeyRef` in `VideoPlayer.tsx` to ensure zero dropped keypresses.
- Keys:
  - **Previous Channel**: `ArrowLeft`, `ArrowUp`, `[`, `p`, `P`, `ChannelDown`, `PageUp`, `MediaTrackPrevious`
  - **Next Channel**: `ArrowRight`, `ArrowDown`, `]`, `n`, `N`, `ChannelUp`, `PageDown`, `MediaTrackNext`
  - **Playback**: Space (play/pause), `M` (mute), `F` (fullscreen), `Esc` / `Backspace` (exit/back).
- Custom playlists are preserved only for filtered subsets (`< 500` items) to avoid serializing giant arrays to `sessionStorage` on every keypress.

---

## Coding Guidelines

- **TypeScript**: Strict types. Use types exported from `src/api/supabase.ts` and `src/hooks/useChannels.ts`.
- **React 19**: Avoid synchronous `setState` calls directly at the root of `useEffect` (use microtasks or action-driven updates to satisfy `oxlint`).
- **Memory & Lifecycle**: Clean up `Hls` instances (`stopLoad()`, `detachMedia()`, `destroy()`) and all window timers in `useEffect` cleanups.
- **CSS**: Pure CSS with CSS variables (`src/styles/`). Use glassmorphism and modern responsive layout primitives.
- **Git Workflow**: Always commit and push changes to `main` once completed and verified.
