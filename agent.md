# StreamLoom Web — Autonomous Agent Manual

Welcome to **StreamLoom Web**. This guide provides autonomous agents, pair programmers, and code generators with everything needed to inspect, build, modify, and test this project effectively.

---

## 1. Executive Summary

StreamLoom Web is a progressive web application (PWA) built for streaming thousands of live television channels and electronic program guides (EPG) directly in modern web browsers (Desktop, Mobile, and Smart TVs). It shares its backend schema and edge architecture with the [StreamLoom](https://github.com/SoftArchium/streamloom) Android/TV platform.

---

## 2. Directory Layout

```
streamloom-web/
├── functions/
│   └── api/
│       └── proxy.ts           # Cloudflare Pages Function: M3U8 rewrite & CORS proxy
├── public/
│   ├── _headers               # Security & cache headers for Cloudflare Pages
│   └── _redirects             # SPA fallback route (/* /index.html 200)
├── src/
│   ├── api/
│   │   ├── redis.ts           # Upstash Redis REST edge catalogue client (ADR-0015)
│   │   └── types.ts           # Catalogue + EPG payload types (erased at build)
│   ├── components/
│   │   ├── ChannelCard.tsx    # Channel grid item with badges and fallback logo
│   │   ├── HeroSection.tsx    # Featured channel showcase with play CTA
│   │   ├── Navbar.tsx         # Brand header, search bar, and filter tabs
│   │   └── VideoPlayer.tsx    # HLS.js streaming core, watchdog failover, TV remote keys
│   ├── hooks/
│   │   └── useChannels.ts     # In-memory reactive channel store & stream priority
│   ├── pages/
│   │   ├── Home.tsx           # Category rails, infinite grid, continue watching
│   │   ├── Guide.tsx          # Interactive EPG grid aligned to current time
│   │   ├── Watch.tsx          # Fullscreen / embedded playback route
│   │   └── Settings.tsx       # Latency profile, auto-skip & hide-broken toggles, cache clear
│   ├── util/
│   │   ├── resolution.ts      # Resolution ranking + resolution-first candidate ordering
│   │   ├── stream.ts          # Stream caching, proxy formatting, mixed-content checks
│   │   ├── country.ts         # Country code resolution and flag rendering
│   │   └── shortcuts.ts       # Global keybinding definitions
│   └── styles/                # Global themes, animations, glassmorphism CSS
├── index.html                 # App shell entry point
├── package.json               # Scripts, runtime & dev dependencies
├── tsconfig.json              # TypeScript root project reference
├── vite.config.ts             # Vite configuration with local development proxy plugin
└── wrangler.jsonc             # Cloudflare Pages configuration
```

---

## 3. Development & Verification Workflow

### Environment Setup
1. Node.js `>= 20.x` is required.
2. Clone repository and install dependencies:
   ```bash
   npm install
   ```
3. Copy `.env.example` to `.env` with valid Supabase and Upstash Redis credentials.

### Command Reference
- `npm run dev`: Starts local Vite development server (includes local M3U8 proxy plugin).
- `npm run lint`: Runs `oxlint`. **Must exit with code 0 and zero warnings.**
- `npm run build`: Executes `tsc -b` and `vite build`. **Must compile cleanly to `dist/`.**
- `npm run preview`: Locates production artifacts in `dist/` and runs a local preview server.

---

## 4. Key Subsystems & Design Invariants

### 1. Edge Proxy & M3U8 Protocol Translation
- **Context**: Browsers enforce mixed-content restrictions on HTTPS origins, blocking plain `http://` stream endpoints. Direct TLS connection to raw stream IPs fails due to invalid SSL certificates.
- **Mechanism**: The edge proxy (`functions/api/proxy.ts` on Cloudflare Pages, `streamProxyPlugin` in `vite.config.ts` during development) dynamically rewrites M3U8 text so that all sub-playlists (`.m3u8`) and transport stream chunks (`.ts`, `.aac`) pass through `/api/proxy?url=...`.
- **CRITICAL RULE**: Whenever text is modified in the proxy response, **delete `content-length` and `content-encoding` headers**. Prepending proxy prefixes increases file size by 3x–5x; retaining original content-length causes the browser to truncate the response mid-URL, resulting in fatal parser errors (`invalid M3U8`).
- Inject `Access-Control-Expose-Headers: *` and `Accept-Ranges: bytes`.
- Propagate `ua` and `ref` parameters to maintain upstream authentication on sub-chunks.

### 2. Multi-Stream Candidate Shuffling & Failover
- Channels often have multiple candidate stream URLs in `channel.streams`.
- `VideoPlayer.tsx` implements a **progress-aware failover watchdog** (7 s without media bytes; see `claude.md` for the exact rules):
  1. Plain HTTP streams on HTTPS origins immediately use the edge proxy.
  2. If a direct HTTPS stream fails or stops receiving data, it retries via edge proxy.
  3. If edge proxy fails or stops receiving data, it automatically advances to the next candidate stream.
  4. Once a candidate stream parses its manifest or buffers a fragment, it is recorded via `cacheWorkingStream(channel.id, url, useProxy, quality)` into `localStorage` (`sl_working_streams_v1`, 7-day TTL).
  5. The working candidate is placed at index 0 on subsequent visits, guaranteeing fast startup times.
  6. The system is self-healing: if an old cached stream stops working, candidate shuffling automatically finds and caches a new one.

### 2b. Resolution-First Candidate Selection
- `Stream.quality` carries the resolution label ("4K", "FHD", "1080p", "HD", "SD", ...).
- `src/util/resolution.ts` owns the ranking (`rankResolution`) and ordering (`orderStreamsForPlayback`).
- **Invariant**: the highest resolution candidate is always index 0, so playback starts on the best quality.
- A cached working stream only holds the front position while no higher resolution candidate exists.
- `enrich.ts` (worker + main thread), `VideoPlayer.tsx` and the `/api/streams` edge probe all share this ordering.
- The edge probe receives `qualities` aligned positionally with `urls`, ranks candidates before probing, and returns the highest resolution candidate that verified live.

### 3. Keyboard & Smart TV Remote Navigation
- Live TV interfaces require continuous keyboard and TV remote control.
- Event listeners are attached once on mount using a stable `onKeyRef` callback to prevent missed or dropped keystrokes.
- Supported inputs:
  - **Previous Channel**: `ArrowLeft`, `ArrowUp`, `[`, `p`, `P`, `ChannelDown`, `PageUp`, `MediaTrackPrevious`
  - **Next Channel**: `ArrowRight`, `ArrowDown`, `]`, `n`, `N`, `ChannelUp`, `PageDown`, `MediaTrackNext`
  - **Playback**: Space (play/pause), `M` (mute), `F` (fullscreen), `Esc` / `Backspace` (exit/back).
- Navigation state uses `sessionStorage` for playlist memory, but **only when playlist length is `< 500`**. Never serialize thousands of channel objects or IDs into history/session storage during channel flips.

---

## 5. Common Pitfalls & Antipatterns

1. **Retaining upstream Content-Length on rewritten bodies**:
   - *Never* pass upstream `content-length` when modifying response text in proxy functions.
2. **Synchronous setState inside React 19 effects**:
   - `oxlint` strictly checks `react(set-state-in-effect)`. Avoid synchronous state dispatches at the root of `useEffect`. Derive values in render or schedule through microtasks/event handlers.
3. **Ghost HLS Instances**:
   - Always call `hls.stopLoad()`, `hls.detachMedia()`, and `hls.destroy()` in `useEffect` cleanups and before re-initializing playback.
4. **Hardcoding Secrets or Private Keys**:
   - Do not commit `.env` or sensitive credentials. All client keys must be read-only anon credentials from environment variables (`VITE_*`).
5. **Leaving Unpushed Commits**:
   - Always commit and push changes directly to `main` once completed and verified.
