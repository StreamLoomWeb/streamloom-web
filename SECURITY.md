# Security

StreamLoom Web has no accounts and stores no personal data (see
[PRIVACY.md](https://streamloomlegal.github.io/streamloom-legal/)). The app is a read-only
client: catalogue reads go to Cloudflare R2 and Upstash Redis, and every other network call
goes through this repository's own `/api/*` Cloudflare Pages Functions. The one authenticated
surface (`/admin`, the picks portal) is gated by Cloudflare Access and verifies the Access JWT
itself (`functions/api/_lib/accessJwt.ts`) rather than trusting the edge configuration alone.

## Reporting a vulnerability

Email `support@softarchium.com` with a description and reproduction steps. We aim to
acknowledge within a few days. Please do not open a public GitHub issue for a vulnerability
report, and please do not test against production in a way that degrades the service for other
users (no load testing, no automated scanning beyond a handful of requests).

See [`/.well-known/security.txt`](public/.well-known/security.txt) for the machine-readable
version of this contact ([RFC 9116](https://www.rfc-editor.org/rfc/rfc9116)).

## Scope

In scope: this repository (the web app and its Cloudflare Pages Functions) and the production
deployment it ships to. Out of scope: the upstream IPTV sources the catalogue indexes — their
infrastructure is not ours to test, and a report about a stream's own origin should go to that
broadcaster.

## What's already in place

- A strict `Content-Security-Policy` and standard hardening headers (HSTS, `X-Content-Type-Options`,
  `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`) —
  see [`public/_headers`](public/_headers) for the policy and why `connect-src`/`img-src`/`media-src`
  allow any HTTPS host (the app proxies and displays arbitrary broadcaster-hosted streams and icons;
  that is its purpose, not an oversight).
- No secret ever reaches this repository or the browser bundle: the Supabase service-role key, the
  read-write Upstash token and any R2 write credential live only in `streamloom-backend`. This
  repository's only write capability is a scoped R2 bucket binding
  (`functions/api/picks/*`, behind Cloudflare Access).
- `/api/proxy`'s outbound fetch is guarded against SSRF: a destination guard
  (`functions/api/_lib/rawHttp.ts`) refuses loopback, link-local, private (RFC 1918/4193),
  multicast and `.internal`/`.localhost` targets before any raw-socket connection is attempted.
- `/api/unlock-validate` compares codes in constant time (`functions/api/_lib/unlockCode.ts`) and
  fails closed (returns "invalid", never "valid") when its secret is unset.
- Every `/admin` and `/api/picks*` request is independently verified end to end (signature,
  issuer, audience, expiry) against Cloudflare Access's own JWKS, not just checked for the
  presence of the header Access sets.
