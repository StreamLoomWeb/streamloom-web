/**
 * Card-to-player view transition (S11). The name is assigned only to the
 * one logo element involved in a given transition, right before it starts,
 * so unrelated cards sharing the same channel elsewhere on the page never
 * collide on the name (the API throws if two elements share one at once).
 */

import { flushSync } from 'react-dom'
import { prefersReducedMotion } from './motion'
import { isWatchChunkReady } from './watchChunk'

const TRANSITION_NAME = 'channel-logo'

/** Call from the card's click handler: morphs its logo into the player's on navigation. */
export function navigateWithLogoTransition(logoEl: HTMLElement | null, run: () => void) {
  // A transition forces a synchronous commit (flushSync). If the watch route's
  // lazy chunk hasn't landed yet, that commit is its Suspense fallback, and the
  // transition would morph into blank space instead of the player.
  if (
    typeof document === 'undefined' ||
    !('startViewTransition' in document) ||
    !isWatchChunkReady() ||
    prefersReducedMotion()
  ) {
    run()
    return
  }
  if (logoEl) logoEl.style.viewTransitionName = TRANSITION_NAME
  document
    .startViewTransition(() => flushSync(run))
    .finished.catch(() => {})
    .finally(() => {
      if (logoEl) logoEl.style.viewTransitionName = ''
    })
}

/** Call once the player's logo mounts, so it is the transition's "after" element. */
export function markPlayerLogoForTransition(logoEl: HTMLElement | null) {
  if (logoEl && 'startViewTransition' in document && !prefersReducedMotion()) {
    logoEl.style.viewTransitionName = TRANSITION_NAME
  }
}
