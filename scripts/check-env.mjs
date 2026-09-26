/**
 * Prebuild guard: refuses to build a bundle that cannot read its catalogue.
 *
 * The catalogue R2 base URL is the primary data source and the two Upstash
 * variables are its fallback (ADR-0030). Vite inlines `VITE_*` variables at
 * build time, so a missing variable does not fail the build — it silently
 * produces a deployed app that reads nothing from that store (or, with both
 * missing, renders no channels). That is the failure that ships when a new
 * branch or preview deployment lacks its environment.
 *
 * This check fails the build loudly instead, naming the missing keys and where
 * to set them. It mirrors the fallback ordering in src/api/redis.ts so the
 * check never disagrees with what the bundle actually reads.
 *
 * Bypass intentionally with SKIP_ENV_CHECK=1 (e.g. for a CI step that only
 * type-checks or lints and does not deploy a working bundle).
 */

import { readFileSync } from 'node:fs'

const REQUIRED = [
  {
    keys: ['VITE_CATALOGUE_R2_BASE_URL'],
    label: 'Catalogue R2 base URL (the public hostname serving catalogue/meta.json)',
  },
  {
    keys: [
      'VITE_UPSTASH_REDIS_REST_URL',
      'VITE_UPSTASH_REDIS_URL',
      'UPSTASH_REDIS_REST_URL',
      'UPSTASH_REDIS_URL',
    ],
    label: 'Upstash Redis REST URL',
  },
  {
    keys: [
      'VITE_UPSTASH_REDIS_REST_READONLY_TOKEN',
      'VITE_UPSTASH_REDIS_READONLY_TOKEN',
      'UPSTASH_REDIS_REST_READONLY_TOKEN',
      'UPSTASH_REDIS_READONLY_TOKEN',
    ],
    label: 'Upstash Redis read-only token',
  },
]

/** Mirrors Vite: values from .env fill gaps, the shell environment wins. */
function loadEnvFile() {
  let raw
  try {
    raw = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  } catch {
    // No .env file — fine on a host that injects variables itself.
    return
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (key && value && !(key in process.env)) process.env[key] = value
  }
}

function resolved(required) {
  for (const key of required.keys) {
    if (process.env[key]) return process.env[key]
  }
  return undefined
}

if (process.env.SKIP_ENV_CHECK === '1') {
  process.exit(0)
}

loadEnvFile()

const missing = REQUIRED.filter((required) => !resolved(required))

// A scheme-less base URL would pass the presence check yet leave R2 silently disabled.
const r2Base = process.env.VITE_CATALOGUE_R2_BASE_URL
if (r2Base && !/^https?:\/\//i.test(r2Base.trim())) {
  console.error(
    '\nStreamLoom build aborted: VITE_CATALOGUE_R2_BASE_URL must start with http:// or https:// (got "' +
      r2Base +
      '").\n',
  )
  process.exit(1)
}

if (missing.length === 0) process.exit(0)

const names = missing.map((m) => `  - ${m.label} (set any of: ${m.keys.join(', ')})`).join('\n')
console.error(
  [
    '',
    'StreamLoom build aborted: required environment variables are missing.',
    '',
    names,
    '',
    'These are the browser-only data sources: R2 snapshots first (ADR-0030),',
    'Upstash Redis as the fallback (ADR-0015). Vite inlines them at build',
    'time, so building without them ships a bundle that reads nothing from',
    'that store, or renders no channels at all.',
    '',
    'Where to set them (Cloudflare Pages):',
    '  Dashboard -> your Pages project -> Settings -> Variables and Secrets',
    '  Add each variable under BOTH "Production" and "Preview". Preview',
    '  deployments do NOT inherit production variables.',
    '',
    'For local builds: copy .env.example to .env and fill it in.',
    'To build without live data on purpose: SKIP_ENV_CHECK=1 npm run build',
    '',
  ].join('\n'),
)
process.exit(1)
