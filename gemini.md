# StreamLoom Web — Google Antigravity & Gemini Agent Playbook

This document defines operational guidelines, system architecture, and quality standards for Google Antigravity (AGY) and Gemini agents working on **StreamLoom Web**.

---

## 1. Project Context & Objectives

StreamLoom Web is the browser-native Progressive Web App (PWA) companion to the [StreamLoom](https://github.com/SoftArchium/streamloom) Android/TV application.
- **Primary Goal**: Deliver high-performance, resilient live-TV streaming across mobile, desktop, and smart TV browsers.
- **Shared Infrastructure**: Shares backend databases and schema with the Android TV app (Supabase PostgREST backend, Upstash Redis ADR-0015 edge catalogue).
- **Core Edge Functionality**: Cloudflare Pages edge delivery with real-time M3U8 rewriting proxy for mixed-content resolution and CORS bypass.

---

## 2. Agent Operational Rules & Token Discipline

1. **Quality-First, Rework-Free Execution**:
   - Understand the codebase before making changes. Review relevant files with targeted line limits.
   - Run verification commands before concluding every milestone.
2. **Output Hygiene**:
   - Never dump unbounded logs or multi-thousand line files into prompt context.
   - Redirect command outputs and inspect relevant exit codes and errors.
3. **Model & Tool Efficiency**:
   - Batch independent tool calls when reading or editing files.
   - Use precise diffs when updating files. Maintain documentation and existing comments.
4. **Zero-Warning Gate**:
   - Every task must satisfy `npm run lint` (`oxlint`) with **0 warnings** and **0 errors**.
   - Every task must pass `npm run build` (`tsc -b && vite build`) without TypeScript discrepancies.

---

## 3. Technology Stack & Key Dependencies

- **Runtime & Build**: Node.js `>= 20`, Vite 8, TypeScript (strict mode)
- **Frontend Framework**: React 19 (`react`, `react-dom`)
- **Routing**: `react-router-dom` v7
- **Video Engine**: `hls.js` v1.7.x (adaptive bitrate streaming, low-latency live synchronization)
- **Backend & Data**:
  - `@supabase/supabase-js` v2 (backend only - never called from the browser)
  - Upstash Redis REST API (read-only edge catalogue caching via ADR-0015)
- **Installability**: a static `public/manifest.webmanifest`; no service worker (backend ADR-0045)
- **Linter**: `oxlint` (Rust-based ultra-fast linter)
- **Edge Deployment**: Cloudflare Pages with Cloudflare Pages Functions (`functions/api/proxy.ts`)

---

## 4. Architecture & Data Flow

```
[Upstash Redis Edge Cache] ──(ADR-0015 REST)──> [useChannels Hook] ──> [In-Memory State]
          │ (if miss/stale)                           │                     │
          ▼                                           ▼                     ▼
 [Supabase PostgREST]                           [LocalStorage]         [Home / Guide / Watch]
                                                • sl_catalogue_v5           │
                                                • sl_working_streams_v1     ▼
                                                • sl_broken_streams_v2  [VideoPlayer (HLS.js)]
                                                                            │
                                                        ┌───────────────────┴───────────────────┐
                                                        ▼                                       ▼
                                                  Direct HTTPS                           Edge Proxy
                                              (if CORS & cert valid)          (/api/proxy?url=...&ua=...&ref=...)
                                                                                        │
                                                                                        ▼
                                                                           Rewrites M3U8 URLs,
                                                                           Strips Content-Length,
                                                                           Preserves Segment Params
```

---

## 5. Critical Streaming & Proxy Invariants

### M3U8 Rewriting & Content-Length Stripping
- **Why**: Prepending `/api/proxy?url=` to segment and playlist URIs increases manifest body size by 300% to 500%.
- **Invariant**: **NEVER pass through upstream `content-length` or `content-encoding` headers** when returning modified M3U8 text in `functions/api/proxy.ts` or `vite.config.ts`. Retaining upstream `content-length` causes the browser HTTP parser to truncate the body prematurely, triggering fatal `invalid M3U8` parsing errors.
- **Headers to Inject**:
  - `Access-Control-Allow-Origin: *`
  - `Access-Control-Expose-Headers: *`
  - `Accept-Ranges: bytes`

### Mixed Content & Protocol Resolution
- If the app is served over `https://`, plain `http://` stream endpoints are blocked by the browser before TCP packets are sent (`ERR_MIXED_CONTENT`).
- Direct TLS upgrade to raw IP streaming servers fails (`ERR_SSL_PROTOCOL_ERROR`) because IP streaming boxes lack valid domain SSL certificates.
- **Rule**: If `isMixedContent(url)` is true, immediately route the stream via `/api/proxy?url=...` without attempting a direct connection first.

### Resolution-First Candidate Ordering
- `Stream.quality` holds the resolution label and is the **primary** sort key for candidate selection; protocol/status only break ties.
- `src/util/resolution.ts` is the single source of ranking truth, shared by `enrich.ts`, `VideoPlayer.tsx` and `functions/api/streams.ts`.
- **Invariant**: index 0 of `channel.streams` is always the highest resolution candidate, so playback starts at the best available quality.
- A cached working stream is promoted to index 0 only when no higher resolution candidate exists.
- `/api/streams` receives `qualities` positionally aligned with `urls` and returns the highest resolution candidate it verified live.

### Multi-Stream Candidate Shuffling & Caching
- Many channels have multiple broadcast endpoints in `channel.streams`.
- `VideoPlayer.tsx` maintains a **progress-aware failover watchdog** (7 s without media bytes; see `claude.md` for the exact rules):
  1. Try direct connection (if HTTPS) or proxy (if HTTP mixed content).
  2. If direct stalls or errors, failover to edge proxy.
  3. If edge proxy stalls or errors, advance to candidate 2, candidate 3, etc.
  4. On successful playback (`MANIFEST_PARSED` / `FRAG_BUFFERED`), save candidate URL, proxy flag and resolution label to `localStorage` (`sl_working_streams_v1`, 7-day TTL).
  5. The working stream is automatically prioritized at index 0 on subsequent views.

---

## 6. Storage & State Management Schemas

| Key | Storage | Schema / Type | Purpose |
|---|---|---|---|
| `sl_catalogue_v5` | `localStorage` | `{ channels: EnrichedChannel[], categories: Category[], epgIds: string[], source: string, ts: number }` | Offline catalogue cache (1h TTL) |
| `sl_working_streams_v1` | `localStorage` | `Record<channelId, { url: string, useProxy: boolean, quality: string \| null, timestamp: number }>` | Verified playable stream cache with resolution label (7-day TTL) |
| `sl_broken_streams_v2` | `localStorage` | `Record<channelId, { timestamp: number }>` | Broken channel registry for auto-skip (24h TTL) |
| `sl_favourites` | `localStorage` | `string[]` | Pinned channel IDs |
| `sl_recent_v1` | `localStorage` | `string[]` | Recent channels list (capped at 20) |
| `sl_low_latency` | `localStorage` | `'true' \| 'false'` | HLS live low-latency toggle |
| `sl_auto_skip` | `localStorage` | `'true' \| 'false'` | Auto-advance to next channel on error |
| `sl_hide_broken` | `localStorage` | `'true' \| 'false'` | Hide failed/unresponsive channels toggle (default false; on only when the user turns it on) |
| `sl_last_viewed` | `sessionStorage`| `string` | Last focused channel ID |
| `sl_active_playlist` | `sessionStorage`| `string[]` | Filtered playlist ID list (guarded `< 500` items) |

---

## 7. Verification Checklist for Agents

Before completing any task touching the codebase:
- [ ] Run `npm run lint` — Confirm 0 errors, 0 warnings.
- [ ] Run `npm run build` — Confirm clean TypeScript compilation and Vite packaging.
- [ ] Check keyboard & TV remote navigation: Arrow keys, `[`, `]`, `p`, `n`, Enter, Space, Esc.
- [ ] Ensure no unbounded state serialization (do not serialize `allChannels` when `allChannels.length > 500`).
- [ ] Ensure `Hls` instances and timers are detached and destroyed during component unmount.
- [ ] Always commit and push changes to `main` once completed and tested.
