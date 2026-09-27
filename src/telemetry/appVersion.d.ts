/**
 * The app version the telemetry batch carries as `a` (ADR-0032: a short token, never free
 * text). Defined at build time in `vite.config.ts` from the Pages commit (`CF_PAGES_COMMIT_SHA`,
 * first seven characters) or `package.json`'s version; `'dev'` when neither exists.
 */
declare const __APP_VERSION__: string
