/**
 * Ranking by this session's category affinity (feasibility study, recommendation 2).
 *
 * The counts come from `useSessionAffinity()` in useChannels.ts: sessionStorage only,
 * bumped once per channel played, gone with the tab (ADR-0005, anonymous by design).
 * These helpers only reorder; nothing here ever drops an item.
 */

/**
 * A lead of this many plays is needed before affinity outranks the curated order.
 * One stray click must not reshuffle Home: row position is muscle memory on a
 * D-pad, so it takes a real pattern to move anything.
 */
export const AFFINITY_REORDER_THRESHOLD = 2

/**
 * Comparator on two affinity scores: higher first once either reaches the
 * threshold, otherwise 0 so the caller's own tie-breakers (curated priority, row
 * order) decide. Pure and symmetric, so `Array.prototype.sort` stays stable.
 */
export function compareAffinity(a: number, b: number): number {
  if (a === b || Math.max(a, b) < AFFINITY_REORDER_THRESHOLD) return 0
  return b - a
}

/**
 * How strongly this session leans toward a channel, from its categories. The row's
 * own category is left out (`except`): every channel in a Sports row shares it, so
 * counting it would add the same number to all of them and rank nothing.
 */
export function channelAffinity(
  categoryIds: readonly string[],
  affinity: ReadonlyMap<string, number>,
  except?: string,
): number {
  let score = 0
  for (const id of categoryIds) if (id !== except) score += affinity.get(id) ?? 0
  return score
}
