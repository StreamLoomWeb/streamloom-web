/**
 * The `CATALOGUE_BUCKET` binding, wrapped down to a three-method facade — shared by every route
 * that reads or writes the catalogue bucket (`picks/index.ts`, `picks/channels.ts`,
 * `picks/custom-channels.ts`).
 *
 * Extracted from `picks/index.ts` (WO-21) once a second write route needed the same binding:
 * two independent copies of "is this really an R2 binding, and can it reach `delete`" is exactly
 * the kind of drift `_lib/` exists to prevent.
 */

export interface R2Object {
  httpEtag: string
  size?: number
  json: <T>() => Promise<T>
  text: () => Promise<string>
}

export interface PutOptions {
  httpMetadata?: { contentType?: string; cacheControl?: string }
  onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string }
}

/**
 * Read-and-append surface of the catalogue bucket.
 *
 * There is deliberately no `delete`. That used to be a type-only claim, which a
 * compiled Function does not enforce: `(bucket as any).delete(...)` would have
 * run. `bindBucket` below now returns a facade holding only these three methods,
 * so the underlying binding's `delete` is not reachable from this module at
 * runtime either (backend CLAUDE.md, "retire by flag, never delete").
 */
export interface CatalogueBucket {
  get: (key: string) => Promise<R2Object | null>
  head: (key: string) => Promise<{ key: string } | null>
  put: (key: string, value: string, options?: PutOptions) => Promise<{ httpEtag: string } | null>
}

/**
 * A three-method facade over the `CATALOGUE_BUCKET` binding, or null.
 *
 * Two jobs:
 *
 *  1. **Check it is a binding at all.** A truthiness test passes for a plain
 *     environment *variable* of the same name — a string the owner typed into
 *     "Variables and Secrets" instead of adding under "Bindings" — and the route
 *     would then throw on `.get` and answer 500. Requiring the three methods
 *     turns that into the 503 it should be.
 *  2. **Drop `delete`.** The returned object holds only `get`, `head` and `put`,
 *     so nothing in a caller can reach the binding's `delete`, whatever a
 *     later edit or a cast tries.
 */
export function bindBucket(env: unknown): CatalogueBucket | null {
  const raw = (env as { CATALOGUE_BUCKET?: unknown } | undefined)?.CATALOGUE_BUCKET
  if (typeof raw !== 'object' || raw === null) return null

  const source = raw as Record<string, unknown>
  const { get, head, put } = source
  if (typeof get !== 'function' || typeof head !== 'function' || typeof put !== 'function') return null

  return {
    get: (key) => (get as (k: string) => Promise<R2Object | null>).call(source, key),
    head: (key) => (head as (k: string) => Promise<{ key: string } | null>).call(source, key),
    put: (key, value, options) =>
      (put as (k: string, v: string, o?: PutOptions) => Promise<{ httpEtag: string } | null>).call(
        source,
        key,
        value,
        options,
      ),
  }
}
