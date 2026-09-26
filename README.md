# StreamLoom Web

**StreamLoom Web** is the high-performance browser-native Progressive Web App (PWA) companion to the [StreamLoom](https://github.com/SoftArchium/streamloom) Android/TV app. It brings the full live-TV & EPG experience to any modern browser — installable like a native app on desktop, mobile, and smart TVs.

---

## Features

| Feature | Details |
|---|---|
| 📺 Live TV | Thousands of channels via HLS.js, resolution-first stream selection, 5 Mbps fast-start buffer, resilient stream retries |
| 📅 TV Guide (EPG) | Virtualized timeline grid that anchors to now (or to the published schedule when the feed lags), one-click English translation of programme titles, and the same filters as Home: search, category, country, language, resolution and favourites |
| ❤️ Favourites | Pin channels with persistent local storage |
| 🕘 Continue Watching | Auto-records recently watched channels |
| 🎯 Mobile Filter Parity | Priority categories (Music 🎵, Movies 🎬, Cartoons 🦄, Comedy 😂, News 📰, Sports ⚽), Resolution filter (4K, FHD, HD, SD), and Country picker |
| ⌨️ TV & Desktop Nav | Arrow keys for channel/row navigation, Enter to play, `/` to search, Esc to clear/back, Space, F, M |
| 🖱️ Trackpad & Mouse | 2-finger horizontal trackpad inertia, mouse wheel horizontal category scroll, card hover states |
| ⚡ Edge Performance | Cloudflare Pages Anycast edge distribution, Upstash Redis caching (ADR-0015) |
| 🌐 Installable | Add to home screen from a web app manifest; no service worker, so every visit loads the live deploy (backend ADR-0045) |
| ⚙️ Settings | Data source indicators, low-latency mode toggle, cache management, shortcut reference |

---

## Stack

- **React 19** + **TypeScript** + **Vite 8**
- **HLS.js** for adaptive live streaming
- **Cloudflare Pages** for global Anycast edge delivery
- **R2 snapshots** (ADR-0030) — the primary catalogue read path: immutable brotli objects behind a public hostname
- **Upstash Redis** read-only edge cache (ADR-0015) — the fallback when R2 cannot serve the catalogue
- **Supabase** — backend source of truth, synced into Redis (never called from the browser)
- A static web app manifest for installability; HTTP caching (`public/_headers`) instead of a service worker (backend ADR-0045)

---

## R2 snapshot contract (primary)

The browser reads the catalogue from R2 first (ADR-0030, ADR-0034 in
streamloom-backend) and falls through to Redis on any miss, malformed object or
timeout. The base URL is the build-time setting `VITE_CATALOGUE_R2_BASE_URL`.

- catalogue/meta.json                      -> { generation, version: 2, layout: 1, syncedAt, hash, guide, counts }
- catalogue/g<N>/channels.json.br          -> Channel[]
- catalogue/g<N>/streams.json.br           -> Stream[]
- catalogue/g<N>/categories.json.br        -> Category[]
- catalogue/g<N>/epg/ids.json.br           -> string[]      (channel ids with schedules)
- catalogue/g<N>/epg/<channelId>.json.br   -> EpgProgram[]  (per-channel schedule, on demand)

Every generation object is served `Content-Encoding: br`, so the browser decodes
it itself. A client fetches `meta.json`, compares `generation` with the stored
one and downloads the generation's objects only when it differs. An unknown
`version` or `layout` is refused, and a bulk object whose row count disagrees
with `meta.counts` is treated as malformed. `src/api/r2Contract.ts` holds the
contract (pure, decoded against `e2e/support/r2-golden.json`), `src/api/r2.ts`
the fetching and `src/api/catalogueSource.ts` the R2-then-Redis order.

## Redis data contract (fallback)

When R2 cannot serve the catalogue the browser reads Upstash Redis (ADR-0015).
Supabase is never called from the client; the sync worker publishes into Redis
and the app reads it back.

- catalogue:meta                    -> { generation, version, pages }
- catalogue:g<N>:channels:page:<i>  -> Channel[]
- catalogue:g<N>:streams:page:<i>   -> Stream[]
- catalogue:g<N>:categories         -> Category[]
- catalogue:g<N>:epg:ids            -> string[]      (channel ids with schedules)
- catalogue:g<N>:epg:<channelId>    -> EpgProgram[]  (per-channel schedule)

Each Channel carries languages as ISO 639-2 codes (e.g. [eng, hin]).
The sync worker already publishes this field; when a generation omits it the Language filter hides itself rather than showing an empty control.

Every key shares the generation prefix from catalogue:meta, so bumping the
generation invalidates the catalogue and EPG together. Page counts in meta
decide how many channels/streams pages are read, and they are fetched
concurrently.

## Environment Variables


Copy `.env.example` to `.env`:

```bash
VITE_CATALOGUE_R2_BASE_URL=https://your-catalogue-hostname
VITE_UPSTASH_REDIS_REST_URL=https://your-upstash-endpoint.upstash.io
VITE_UPSTASH_REDIS_REST_READONLY_TOKEN=your_upstash_readonly_token
```

All three are required: the first is the primary read path, the other two the fallback.

### Build-time enforcement

The build refuses to run without them:

```bash
$ npm run build
StreamLoom build aborted: required environment variables are missing.
  - Catalogue R2 base URL (set any of: VITE_CATALOGUE_R2_BASE_URL)
  - Upstash Redis REST URL (set any of: VITE_UPSTASH_REDIS_REST_URL, ...)
  - Upstash Redis read-only token (set any of: VITE_UPSTASH_REDIS_REST_READONLY_TOKEN, ...)
```

This exists because Vite inlines `VITE_*` values **at build time**. A missing
variable does not break the build; it silently produces a bundle that renders no
channels and shows "Upstash Redis is not configured". Failing loudly at build
time turns a confusing dead deployment into an obvious error.

The check reads either `VITE_`-prefixed or bare names, matching the fallback
ordering in `src/api/redis.ts`, and prefers the shell environment over `.env`.

To build a bundle without live data on purpose (a lint or type-check step),
bypass it explicitly:

```bash
SKIP_ENV_CHECK=1 npm run build
```


### Optional: TV Guide translation

The Guide's `English` toggle translates programme titles. Point it at a
LibreTranslate-compatible endpoint; without one it falls back to the public
MyMemory API, which is rate limited.

```bash
VITE_TRANSLATE_URL=https://your-libretranslate.example.com/translate
VITE_TRANSLATE_API_KEY=            # only if the endpoint requires a key
```

Translations are cached in memory and in localStorage, requests are debounced
and batched, and only titles that look non-English are sent at all.

---

## Development

```bash
npm install
npm run dev          # starts at http://localhost:5174
npm run build        # production build to dist/
npm run lint         # oxlint
```

---

## Cloudflare Pages Deployment

StreamLoom Web is pre-configured for Cloudflare Pages:
- **Build command:** `npm run build`
- **Build output directory:** `dist`
- **Node version:** `>= 20`
- SPA routing handled automatically via `public/_redirects` (`/* /index.html 200`)
- Edge caching and security headers defined in `public/_headers`

### Environment variables must be set for BOTH scopes

Cloudflare Pages keeps **two separate variable scopes: Production and Preview**.
Preview deployments — every branch build and pull request — **do not inherit
production variables**. Setting a variable only under Production means every
branch deploy builds without it, and the guard above will stop the build.

Add each variable to **both** scopes:

```
Dashboard -> Workers & Pages -> your project -> Settings
  -> Variables and Secrets -> Add
  -> choose the Production environment, add the variable
  -> repeat, choosing the Preview environment
```

Required variables:

| Variable | Where to find it |
|---|---|
| `VITE_CATALOGUE_R2_BASE_URL` | The public (custom) hostname of the `streamloom-catalogue` R2 bucket, no trailing slash; it serves `catalogue/meta.json` |
| `VITE_UPSTASH_REDIS_REST_URL` | Upstash console -> Redis -> REST API -> Endpoint |
| `VITE_UPSTASH_REDIS_REST_READONLY_TOKEN` | Upstash console -> Redis -> REST API -> Read Only Token |

These are inlined into the client bundle, so anyone can read them from the
deployed JavaScript. Use the **read-only** token, never a read-write one.

No variables need to be set for `netlify.toml`; that file only defines build and
redirect rules.

### `wrangler.jsonc` is for local development, not for the deployment

A Pages project treats a Wrangler file as its configuration **only when the file
carries `pages_build_output_dir`**. This project's `wrangler.jsonc` deliberately
does not, so it applies to `wrangler pages dev` alone and the deployed project
keeps reading its bindings and variables from the dashboard. Adding that key
would make the file authoritative and discard everything currently set in the
dashboard, so a binding added to `wrangler.jsonc` must also be added there.

---

## The author's-picks portal (`/admin`, ADR-0033)

An unlisted page for curating pinned channels from the whole iptv-org list.
Nothing links to it; it is served `noindex` and `no-store`. It is protected by a
**Cloudflare Access** application, and the Function behind it verifies the
`Cf-Access-Jwt-Assertion` JWT itself, so a misconfigured route cannot expose the
write path.

The project's **only** write capability is an R2 binding to the catalogue bucket.
There is no R2 API token, no Supabase key and no Upstash write token in this
repository, and nothing about the portal is a `VITE_` variable — so nothing about
it reaches the browser bundle.

### What the owner has to configure (once, a few minutes)

1. **Zero Trust -> Access -> Applications -> Add -> Self-hosted.**
   The application must cover **both** paths, because Access only attaches the
   `Cf-Access-Jwt-Assertion` header to requests for a path it protects — the page
   at `/admin` and the endpoint at `/api/picks` (a path prefix, so it also covers
   `/api/picks/channels`). Preferably add both as **paths on one application**,
   which yields one AUD tag. Policy: Allow, `Emails` = the owner's address, with
   MFA required. Copy the **Application Audience (AUD) tag**.
2. **Workers & Pages -> `streamloomweb` -> Settings -> Variables and Secrets**,
   under **both Production and Preview**:
   | Variable | Value | |
   |---|---|---|
   | `CF_ACCESS_TEAM_DOMAIN` | `https://<team>.cloudflareaccess.com` | required |
   | `CF_ACCESS_AUD` | the AUD tag copied above | required |
   | `CF_ACCESS_ALLOWED_EMAILS` | your email address | **recommended** |

   If you created two applications instead of one, set `CF_ACCESS_AUD` to both
   tags **comma-separated** (`tag1,tag2`); the endpoint accepts a token carrying
   either and nothing else. Until the two required variables are set,
   `/api/picks` answers **503 and writes nothing**.

   `CF_ACCESS_ALLOWED_EMAILS` (comma-separated, case-insensitive, exact match) is
   optional defence in depth: with it set, a verified token whose `email` is not
   on the list is refused with 403 even though Access let it through. An Access
   policy widened by accident — an extra rule, a group that grew, a second
   identity provider attached to the application — then does not by itself become
   permission to publish.

   **Either leave it out entirely, or give it a real address.** Not setting the
   variable at all means "no second gate" and is the supported way to go without
   one. Setting it to a blank or whitespace value, a lone comma, or anything that
   is not a valid address **refuses every request with 503 until it is fixed** —
   a deliberate choice, so a half-typed value can never quietly leave the gate
   off while the dashboard shows it as configured. To remove the gate later,
   **delete the variable**; do not blank it.
3. **Settings -> Bindings -> Add -> R2 bucket**: variable name
   `CATALOGUE_BUCKET`, bucket `streamloom-catalogue`. **Not** `channel-icons` —
   that bucket sits behind a public read route. Redeploy for it to take effect.

   Add this binding in **Production only, not Preview.** Preview deployments are
   built from every branch and pull request, so a branch is the least trustworthy
   place to hold the one write capability this project has. Without the binding a
   preview's `/api/picks` answers 503 and writes nothing, which is the right
   answer for a branch. (The two `CF_ACCESS_*` variables *do* belong in both
   scopes: a preview with no Access configuration is safe, but impossible to sign
   into for testing.)

   It must be a **binding**, not a variable of that name typed into "Variables
   and Secrets". The route checks, and answers 503 rather than 500 if it is the
   wrong kind.
4. Confirm the catalogue bucket's public hostname serves `catalogue/picks.json`
   (it is written beside `catalogue/meta.json`, outside `catalogue/g<N>/`, so the
   14-day lifecycle rule on the `catalogue/g` prefix does not match it).

**The portal cannot save until the first catalogue has been published to R2.**
Before any write it asks the bound bucket for `catalogue/meta.json` — the object
the sync worker writes last on every publish (ADR-0034 §3) — and refuses with 503
if it is not there. That is what stops a binding aimed at the wrong bucket, or at
an empty one, from being seeded with a picks object nothing will ever read. Until
the worker's first R2 publish, `/admin` opens and lets you build groups, and the
save returns "CATALOGUE_BUCKET does not contain catalogue/meta.json".

### One check to run after the first deploy

**Save twice within a second, then list the bucket's `picks-history/` prefix.**
There must be **two distinct objects**, not one.

History objects are written with a conditional put (`If-None-Match: *`), which is
what makes "append-only" true even when two saves land in the same millisecond.
That condition has only ever been exercised against a test double, so this is the
one behaviour of the write path that a real bucket has to confirm.

If you see only one object, the store ignored the condition. It is not urgent and
nothing is lost in normal use — keys carry a millisecond timestamp, so two saves
a person makes by hand never collide, and the retry loop still moves a collision
to a new suffix. What it would mean is that the *simultaneous* case could
overwrite, so say so in the pull request or an issue rather than relying on the
append-only claim for anything that matters.

Then open `/admin`, sign in through Access, and save. A pin already in the live
generation appears on the site within about a minute; one that is not yet
published appears at the next sync, and the portal says which is which.

### Fast-track dispatch (ADR-0043, WO-19)

A save that pins a genuinely new channel — one not already in the live
generation and not already carrying a fast-track entry — dispatches a narrow
`repository_dispatch` to `streamloom-backend`, which probes just that channel
and, on a live verdict, makes it playable within seconds instead of waiting for
the next scheduled sync. See `streamloom-backend/docs/adr/0043-*.md` for the
full design; this section is only the one credential this repository needs.

1. **Create a fine-grained GitHub PAT**, scoped to `Stream-Loom/streamloom-backend`
   only, with **Contents: Read and write** (what `repository_dispatch` requires —
   confirmed empirically, 2026-09-22). Nothing else: no Issues, no Actions, no
   account-wide access.
2. **Workers & Pages -> `streamloomweb` -> Settings -> Variables and Secrets**,
   **Production only** (not Preview — `CATALOGUE_BUCKET` is Production-only too,
   so a Preview save never reaches the dispatch code regardless): add
   `GITHUB_DISPATCH_TOKEN`, marked **Encrypt**.
3. **Redeploy Production after adding or changing it.** This is not specific to
   this variable — Cloudflare Pages snapshots secrets, variables and bindings
   **per deployment** (the R2 binding note above says the same thing) — but it
   bit this feature for real: the token was added to an already-live deployment
   once, and every save silently dispatched nothing (no error, no log — an
   absent token is a deliberately quiet no-op, see `functions/api/_lib/fastTrack.ts`)
   until the next deploy picked it up. **Adding, rotating or removing any Pages
   secret/variable/binding always needs a fresh deployment to take effect** —
   dashboard "Retry deployment" on the current Production deployment is enough,
   no code change required.

**Verify it actually reached the token:** pin one genuinely new channel, then
check `streamloom-backend`'s Actions tab for a `Fast-track a pick` run within
seconds. If none appears, the token likely hasn't reached the live deployment
yet — redeploy and try again before assuming anything else is wrong.

