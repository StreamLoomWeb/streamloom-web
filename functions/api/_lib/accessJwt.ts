/**
 * Cloudflare Access JWT verification, done here rather than assumed (ADR-0033 §5).
 *
 * Access puts a signed RS256 JWT in `Cf-Access-Jwt-Assertion` on every request it
 * lets through. A route that only checks the header is *present* trusts the edge
 * configuration: if the Access application is deleted, its path rule stops
 * matching, or the project is ever served from a hostname the application does
 * not cover, the header simply stops arriving and the route becomes public. So
 * this module verifies the token end to end — signature, key identity, audience,
 * issuer and lifetime — against the team's published JWKS.
 *
 * What is deliberately NOT trusted:
 *   - the URL path (a path rule is edge configuration, not authorisation)
 *   - the `Origin`, `Referer`, `CF-Connecting-IP` or any other client-settable
 *     header (a client can set all of them)
 *   - the presence of the assertion header on its own
 *   - an `alg` the token itself chose: only RS256 is accepted, so `none`, HS256
 *     (which would let the public modulus be used as an HMAC key) and every other
 *     algorithm are refused before a key is ever looked up
 *
 * Failure is closed everywhere. If the configuration is absent, or the JWKS
 * cannot be read, the caller gets 503 and must write nothing — never a pass.
 *
 * Nothing here has any I/O other than the JWKS fetch, so `verifyAccessJwt` can be
 * driven from a test with a generated keypair and a stubbed `fetch`.
 */

/** Resolved, validated Access settings. */
export interface AccessConfig {
  /** `https://<team>.cloudflareaccess.com`, lowercased, no trailing slash. Also the expected `iss`. */
  teamDomain: string
  /**
   * The Access application AUD tags this route accepts, compared to the token's
   * `aud` by exact equality.
   *
   * A list, because Access issues a *different* AUD per application and the
   * portal needs two paths covered (`/admin` for the page, `/api/picks` for the
   * endpoint). One application carrying both paths gives one tag and is the
   * simpler configuration; two applications give two, and
   * `CF_ACCESS_AUD` then holds them comma-separated. This is the same shape
   * `cloudflared`'s `audTag` takes.
   */
  auds: string[]
  /** Where the team publishes its signing keys. */
  certsUrl: string
  /**
   * Optional second gate: when `CF_ACCESS_ALLOWED_EMAILS` is set, the verified
   * `email` claim must be one of these (lowercased, exact match). Empty when the
   * variable is unset, which leaves the Access policy as the only allow-list.
   *
   * Defence in depth, not a replacement: it means a policy widened by accident —
   * an extra rule, a group that grew, a second identity provider attached to the
   * application — does not by itself become permission to publish.
   */
  allowedEmails: string[]
}

/** Who the token says is calling. Only ever produced after a full verification. */
export interface AccessIdentity {
  sub: string
  email: string
}

export type AccessFailure = {
  ok: false
  /** 401 the token is absent or bad, 403 it is for something else, 503 we cannot decide. */
  status: 401 | 403 | 503
  /** Short machine-readable tag. Safe to return to the client: it names no secret. */
  reason: string
}

export type AccessResult = { ok: true; identity: AccessIdentity } | AccessFailure

/** The header Access sets. Read case-insensitively via `Headers.get`. */
export const ACCESS_JWT_HEADER = 'Cf-Access-Jwt-Assertion'

/**
 * Tolerance on `exp`, `nbf` and `iat`. Access tokens live for hours, so a minute
 * absorbs ordinary clock drift without meaningfully extending a token's life.
 */
export const CLOCK_SKEW_S = 60

/** A real Access token is a few hundred bytes; this only bounds the work a stranger can cause. */
const MAX_TOKEN_BYTES = 8192

/** How long a fetched JWKS is reused before it is re-read. */
const JWKS_TTL_MS = 60 * 60 * 1000

/**
 * Floor between two fetches of the same certs URL. Without it, a stranger posting
 * tokens with random `kid`s would make this route fetch the certs endpoint once
 * per request.
 */
const JWKS_MIN_REFETCH_MS = 60 * 1000

const JWKS_MAX_BYTES = 128 * 1024
const JWKS_TIMEOUT_MS = 5_000
const JWKS_MAX_KEYS = 32

/** Team hostnames Access issues tokens for. A custom Access domain is refused, not guessed at. */
const TEAM_DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/

/**
 * An AUD tag is a 64-character hex string today. The check is deliberately looser
 * than that (it only has to exclude whitespace, URLs and the empty string) because
 * the tag is compared by exact equality: its shape carries no security weight, and
 * a needlessly strict pattern would fail a correct configuration closed.
 */
const AUD_RE = /^[A-Za-z0-9_-]{20,200}$/

/** Ceiling on how many applications may publish to this route. */
const MAX_AUDS = 4

/** Ceiling on the optional email allow-list. It is one author (ADR-0033). */
const MAX_ALLOWED_EMAILS = 10

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** True when a string carries any whitespace. Written without a regex escape. */
const hasSpace = (value: string): boolean => value.split('').some((c) => c.trim().length === 0)

/**
 * The Access settings, or null when they are unusable.
 *
 * Null must become a 503 with no write: a portal that cannot say who is calling
 * has no business saving anything.
 */
export function readAccessConfig(env: unknown): AccessConfig | null {
  const e = isRecord(env) ? env : {}
  const rawTeam = typeof e.CF_ACCESS_TEAM_DOMAIN === 'string' ? e.CF_ACCESS_TEAM_DOMAIN.trim() : ''
  const rawAud = typeof e.CF_ACCESS_AUD === 'string' ? e.CF_ACCESS_AUD.trim() : ''
  if (!rawTeam || !rawAud) return null

  // One tag, or several comma-separated. Every one must be well formed: a typo
  // that produced an empty or malformed entry fails the whole configuration
  // closed rather than quietly accepting the rest.
  const auds = rawAud.split(',').map((a) => a.trim())
  if (auds.length === 0 || auds.length > MAX_AUDS) return null
  if (!auds.every((a) => AUD_RE.test(a))) return null
  if (new Set(auds).size !== auds.length) return null

  // Tolerate the two ways the owner might paste the team domain, and nothing else:
  // no path, no port, no query, no credentials, no scheme other than https.
  let host = rawTeam.toLowerCase()
  if (host.startsWith('https://')) host = host.slice('https://'.length)
  host = host.replace(/\/+$/, '')
  if (!TEAM_DOMAIN_RE.test(host)) return null

  // Optional, and the distinction that matters is **absent** versus **present**,
  // not empty versus non-empty.
  //
  // Absent — the key is not on the environment at all — means "there is no second
  // gate", the behaviour before this variable existed. *Present* means the owner
  // intended a gate, so anything that would not produce one is a misconfiguration
  // and fails the whole configuration closed: a blank value, whitespace, a lone
  // comma, a malformed address, more than MAX_ALLOWED_EMAILS of them, or a
  // non-string. Otherwise `CF_ACCESS_ALLOWED_EMAILS=" "` would quietly disable
  // the gate the owner thought they had turned on, while `","` refused everything
  // — the same mistake with opposite outcomes.
  let allowedEmails: string[] = []
  if ('CF_ACCESS_ALLOWED_EMAILS' in e) {
    if (typeof e.CF_ACCESS_ALLOWED_EMAILS !== 'string') return null
    const entries = e.CF_ACCESS_ALLOWED_EMAILS.split(',').map((entry) => entry.trim().toLowerCase())
    if (entries.length === 0 || entries.length > MAX_ALLOWED_EMAILS) return null
    if (
      !entries.every(
        (entry) => entry.length > 0 && entry.length <= 320 && entry.includes('@') && !hasSpace(entry),
      )
    ) {
      return null
    }
    allowedEmails = [...new Set(entries)]
    if (allowedEmails.length === 0) return null
  }

  const teamDomain = 'https://' + host
  return { teamDomain, auds, certsUrl: teamDomain + '/cdn-cgi/access/certs', allowedEmails }
}

// ---- JWKS cache ----

interface JwksEntry {
  keys: Map<string, CryptoKey>
  /** 0 when the entry only records a failed attempt. */
  fetchedAt: number
  lastAttempt: number
}

const jwksCache = new Map<string, JwksEntry>()

/*
 * Test seam, absent in production.
 *
 * A test process creates `globalThis.__streamloomTestSeams` before this module is
 * evaluated (e2e/support/testSeams.ts) and finds its hooks on it. Nothing in the
 * deployed bundle creates that object, no request can, and a Workers isolate
 * offers no way to set a global before module evaluation — so this block
 * registers nothing in production and no state mutator is exported from here.
 */
{
  const seams = (globalThis as { __streamloomTestSeams?: Record<string, unknown> })
    .__streamloomTestSeams
  if (seams) seams.resetJwksCache = () => jwksCache.clear()
}

/**
 * Reads and imports the team's signing keys, or null if they could not be read.
 *
 * Every key is checked before import: RSA only, RS256 only, signing use only. A
 * JWKS that offered, say, an `oct` key could otherwise be imported and then used
 * to verify a symmetric token.
 */
async function fetchJwks(certsUrl: string): Promise<Map<string, CryptoKey> | null> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), JWKS_TIMEOUT_MS)
  try {
    const res = await fetch(certsUrl, {
      signal: ctl.signal,
      headers: { accept: 'application/json' },
      // A redirect must never be followed — the certs URL is built from a
      // hostname this module has already constrained to
      // `*.cloudflareaccess.com`; following a redirect would hand that
      // constraint back to whatever answered, and signing keys taken from a
      // redirect target are keys chosen by someone other than the team.
      //
      // `'error'` is the standard Fetch API spelling of that, but workerd (the
      // runtime this Function actually runs on in production) only implements
      // `'follow'` and `'manual'` and throws a TypeError for anything else —
      // every request here failed closed with a 503 for exactly this reason.
      // `'manual'` gets the same effect without the throw: a 3xx response is
      // returned rather than followed, and `!res.ok` below already refuses it
      // (`res.ok` is true only for 200–299).
      redirect: 'manual',
      // Cloudflare's own cache; harmless where `cf` is not understood.
      cf: { cacheTtl: 3600, cacheEverything: true },
    } as RequestInit)
    if (!res.ok) return null
    if (Number(res.headers.get('content-length') ?? 0) > JWKS_MAX_BYTES) return null
    const text = await res.text()
    if (text.length > JWKS_MAX_BYTES) return null

    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return null
    }
    if (!isRecord(body) || !Array.isArray(body.keys)) return null

    const out = new Map<string, CryptoKey>()
    for (const raw of body.keys.slice(0, JWKS_MAX_KEYS)) {
      if (!isRecord(raw)) continue
      const { kid, kty, alg, use, n, e } = raw
      if (typeof kid !== 'string' || kid.length === 0 || out.has(kid)) continue
      if (kty !== 'RSA') continue
      if (alg !== undefined && alg !== 'RS256') continue
      if (use !== undefined && use !== 'sig') continue
      if (typeof n !== 'string' || typeof e !== 'string') continue
      try {
        const key = await crypto.subtle.importKey(
          'jwk',
          { kty: 'RSA', n, e, alg: 'RS256', ext: true },
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['verify'],
        )
        out.set(kid, key)
      } catch {
        // One unusable key does not invalidate the rest.
      }
    }
    return out.size > 0 ? out : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

type KeyLookup = { key: CryptoKey } | { key: null; unavailable: boolean }

/**
 * The key `kid` names.
 *
 * `unavailable` separates "the team's keys could not be read" (503: we cannot
 * decide, so we refuse) from "the keys were read and this `kid` is not among
 * them" (401: the token is not one Access issued).
 */
async function keyFor(certsUrl: string, kid: string): Promise<KeyLookup> {
  const now = Date.now()
  const entry = jwksCache.get(certsUrl)
  const fresh = entry !== undefined && entry.fetchedAt > 0 && now - entry.fetchedAt < JWKS_TTL_MS

  if (fresh) {
    const hit = entry.keys.get(kid)
    if (hit) return { key: hit }
  }

  // An unknown kid may mean the team rotated its keys, so one refetch is allowed —
  // but no more often than JWKS_MIN_REFETCH_MS, whoever is asking.
  if (entry && now - entry.lastAttempt < JWKS_MIN_REFETCH_MS) {
    return { key: null, unavailable: !fresh }
  }

  const keys = await fetchJwks(certsUrl)
  if (!keys) {
    if (entry) entry.lastAttempt = now
    else jwksCache.set(certsUrl, { keys: new Map(), fetchedAt: 0, lastAttempt: now })
    // A stale-but-present cache can still answer; otherwise we genuinely cannot decide.
    if (fresh) return { key: entry.keys.get(kid) ?? null, unavailable: false }
    return { key: null, unavailable: true }
  }

  jwksCache.set(certsUrl, { keys, fetchedAt: now, lastAttempt: now })
  return { key: keys.get(kid) ?? null, unavailable: false }
}

// ---- Token decoding ----

function base64UrlToBytes(segment: string): Uint8Array | null {
  if (segment.length === 0 || !/^[A-Za-z0-9_-]+$/.test(segment)) return null
  const b64 = segment.replace(/-/g, '+').replace(/_/g, '/')
  const remainder = b64.length % 4
  if (remainder === 1) return null
  const padded = remainder === 0 ? b64 : b64 + '='.repeat(4 - remainder)
  try {
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

function base64UrlToJson(segment: string): unknown {
  const bytes = base64UrlToBytes(segment)
  if (!bytes) return null
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}

const fail = (status: 401 | 403 | 503, reason: string): AccessFailure => ({ ok: false, status, reason })

/**
 * Verifies one `Cf-Access-Jwt-Assertion` value against `config`.
 *
 * `now` is injectable so expiry can be tested without waiting.
 */
export async function verifyAccessJwt(
  token: string | null | undefined,
  config: AccessConfig,
  now: number = Date.now(),
): Promise<AccessResult> {
  if (typeof token !== 'string' || token.length === 0) return fail(401, 'missing-token')
  if (token.length > MAX_TOKEN_BYTES) return fail(401, 'token-too-large')

  const parts = token.split('.')
  if (parts.length !== 3) return fail(401, 'malformed-token')
  const [headerB64, payloadB64, signatureB64] = parts

  const header = base64UrlToJson(headerB64)
  if (!isRecord(header)) return fail(401, 'malformed-header')

  // The algorithm is fixed by us, never taken from the token. `none` and every
  // symmetric algorithm are rejected right here, before any key is fetched.
  if (header.alg !== 'RS256') return fail(401, 'unsupported-alg')
  if (header.typ !== undefined && header.typ !== 'JWT') return fail(401, 'unsupported-typ')
  const kid = header.kid
  if (typeof kid !== 'string' || kid.length === 0 || kid.length > 256) return fail(401, 'missing-kid')

  const signature = base64UrlToBytes(signatureB64)
  if (!signature) return fail(401, 'malformed-signature')

  const lookup = await keyFor(config.certsUrl, kid)
  if (!lookup.key) {
    if ('unavailable' in lookup && lookup.unavailable) return fail(503, 'jwks-unavailable')
    return fail(401, 'unknown-kid')
  }

  const signed = new TextEncoder().encode(headerB64 + '.' + payloadB64)
  let verified = false
  try {
    verified = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      lookup.key,
      signature as unknown as ArrayBufferView,
      signed as unknown as ArrayBufferView,
    )
  } catch {
    return fail(401, 'bad-signature')
  }
  if (!verified) return fail(401, 'bad-signature')

  // Only now is the payload worth reading: everything below is signed content.
  const payload = base64UrlToJson(payloadB64)
  if (!isRecord(payload)) return fail(401, 'malformed-payload')

  if (typeof payload.iss !== 'string' || payload.iss !== config.teamDomain) {
    return fail(403, 'wrong-issuer')
  }

  const audClaim = payload.aud
  const audList = typeof audClaim === 'string' ? [audClaim] : Array.isArray(audClaim) ? audClaim : []
  if (!audList.some((a) => typeof a === 'string' && config.auds.includes(a))) {
    return fail(403, 'wrong-audience')
  }

  const nowS = Math.floor(now / 1000)
  const exp = payload.exp
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return fail(401, 'missing-exp')
  if (nowS > exp + CLOCK_SKEW_S) return fail(401, 'expired')

  const nbf = payload.nbf
  if (typeof nbf === 'number' && Number.isFinite(nbf) && nowS < nbf - CLOCK_SKEW_S) {
    return fail(401, 'not-yet-valid')
  }

  const iat = payload.iat
  if (typeof iat === 'number' && Number.isFinite(iat) && nowS < iat - CLOCK_SKEW_S) {
    return fail(401, 'issued-in-future')
  }

  // The policy behind this route is a human identity with MFA (ADR-0033 §5).
  // An Access *service token* carries the same `aud` but no `email`, so requiring
  // one keeps a service token from ever publishing picks even if a service-auth
  // policy is added to the application later.
  const email = payload.email
  if (typeof email !== 'string' || email.length === 0 || email.length > 320) {
    return fail(403, 'no-identity')
  }

  // The optional second gate. Unset means "the Access policy decides", which is
  // what ADR-0033 §5 specifies; set, it means a policy that grew by accident does
  // not on its own become permission to publish.
  if (config.allowedEmails.length > 0 && !config.allowedEmails.includes(email.toLowerCase())) {
    return fail(403, 'not-on-allow-list')
  }

  const sub = typeof payload.sub === 'string' ? payload.sub : ''
  return { ok: true, identity: { sub, email } }
}

/**
 * The whole gate in one call: configuration, then token.
 *
 * Callers must treat every failure as terminal and write nothing.
 */
export async function authoriseAccessRequest(
  request: Request,
  env: unknown,
  now: number = Date.now(),
): Promise<AccessResult> {
  const config = readAccessConfig(env)
  if (!config) return fail(503, 'access-not-configured')
  return verifyAccessJwt(request.headers.get(ACCESS_JWT_HEADER), config, now)
}
