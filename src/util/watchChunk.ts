/**
 * The watch route's code (VideoPlayer, hls.js) is loaded on demand — see App.tsx.
 * A view transition into it must know whether that chunk is already in hand:
 * starting one while it's still downloading forces a synchronous commit of the
 * route's Suspense fallback, and the transition morphs into blank space instead
 * of the player.
 */

let ready = false

export function loadWatch() {
  return import('../pages/Watch').then((m) => {
    ready = true
    return m
  })
}

export function isWatchChunkReady() {
  return ready
}
