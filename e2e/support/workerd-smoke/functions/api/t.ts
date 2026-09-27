// Test-only re-export: the real `/api/t` handler, served by `wrangler pages dev` from this fixture
// (`e2e/workerd-smoke.spec.ts`) so its `request.cf`, `request.body` stream, R2 binding read and
// Analytics Engine write are exercised under real workerd rather than Node's fetch stand-ins.
export { onRequest } from '../../../../../functions/api/t'
