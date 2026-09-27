/**
 * The seam registry, and the only thing that creates it.
 *
 * The Function libraries hold module-scoped caches (the team's JWKS, the
 * iptv-org index) that a test has to be able to clear and backdate. Exporting
 * `resetX()` / `ageX()` from those libraries put state mutators on the surface of
 * modules that ship to production, where nothing needs them.
 *
 * Instead, each library looks for `globalThis.__streamloomTestSeams` **as it is
 * evaluated** and, only if it is already there, hangs its hooks on it. This file
 * is what puts it there. Nothing in `functions/` or `src/` creates that object,
 * no HTTP request can create it, and a Workers isolate gives no one a way to set
 * a global before module evaluation — so in a deployed Function the registration
 * block is dead code and the libraries export no mutator at all.
 *
 * **Import this first.** ES modules (and Playwright's CommonJS transform) evaluate
 * dependencies in import-declaration order, so the registry must be created by an
 * import that appears above the Function modules in the spec file. A spec that
 * imports it late gets `seams.resetJwksCache` throwing, not silently stale state.
 */

export interface SeamRegistry {
  /** Drops the cached JWKS so the next verification re-reads the certs endpoint. */
  resetJwksCache?: () => void
  /** Drops the cached iptv-org index so the next save re-fetches it. */
  resetIptvCache?: () => void
  /** Backdates the held iptv-org copy (and the retry floor) by `byMs`. */
  ageIptvCache?: (byMs: number) => void
}

const registry: SeamRegistry = {}
;(globalThis as Record<string, unknown>).__streamloomTestSeams = registry

/** Fails loudly rather than silently doing nothing when a seam was never registered. */
function required<K extends keyof SeamRegistry>(name: K): NonNullable<SeamRegistry[K]> {
  const hook = registry[name]
  if (!hook) {
    throw new Error(
      `Test seam "${String(name)}" is not registered. Import e2e/support/testSeams before the ` +
        'Function modules: the library registers its hooks as it is evaluated, and only if the ' +
        'registry already exists.',
    )
  }
  return hook as NonNullable<SeamRegistry[K]>
}

export const resetJwksCache = (): void => required('resetJwksCache')()
export const resetIptvCache = (): void => required('resetIptvCache')()
export const ageIptvCache = (byMs: number): void => required('ageIptvCache')(byMs)
