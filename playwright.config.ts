import { defineConfig, devices } from '@playwright/test'
import { loadEnv } from 'vite'
import { R2_MOCK_BASE_URL } from './e2e/support/r2Mock'

/**
 * Placeholder Upstash settings for the dev server, used only when none are
 * configured (a fresh checkout or worktree has no .env). Specs that mock the
 * endpoint (e2e/guide-requests.spec.ts) then still run; specs that read the real
 * catalogue need real credentials, as before. Real values always win.
 */
const configured = loadEnv('development', process.cwd(), 'VITE_')
const upstashEnv =
  configured.VITE_UPSTASH_REDIS_REST_URL && configured.VITE_UPSTASH_REDIS_REST_READONLY_TOKEN
    ? {}
    : {
        VITE_UPSTASH_REDIS_REST_URL: 'https://upstash.mock.invalid',
        VITE_UPSTASH_REDIS_REST_READONLY_TOKEN: 'mock-readonly-token',
      }

// The R2 snapshot host is always the fixed mock host (e2e/support/r2Mock.ts
// intercepts it), never a value from .env: the specs count and fail R2 requests
// and must not depend on, or spend, the real bucket.

/**
 * Browser tests for the TV guide.
 *
 * These run against the real dev server (and therefore the real Redis
 * catalogue), because the guide's layout — sticky columns, two-axis scroll,
 * virtualization — can only be validated in a browser. Server-side rendering
 * checks cannot catch any of it.
 */
export default defineConfig({
  testDir: './e2e',
  // Every test gets a fresh browser context; specs that count reads mock Redis per
  // context and R2 per worker (e2e/support/r2Mock.ts). Workers default to half
  // the cores; `--workers=N` overrides.
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  timeout: 90_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: 'http://localhost:5199',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Bound to 127.0.0.1 explicitly: `localhost` can resolve to ::1 while the
    // server listens on IPv4 only, which makes the readiness probe hang.
    command: 'npx vite --host 127.0.0.1 --port 5199 --strictPort',
    url: 'http://127.0.0.1:5199',
    reuseExistingServer: true,
    timeout: 120_000,
    env: { ...upstashEnv, VITE_CATALOGUE_R2_BASE_URL: R2_MOCK_BASE_URL },
  },
})
