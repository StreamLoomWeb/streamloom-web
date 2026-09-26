/**
 * 10-foot mode (S5): a TV browser gets a bigger type scale, overscan padding
 * and D-pad-first navigation instead of the desktop/mobile layout.
 *
 * Detected once per load, by two independent signals (either is enough):
 *  - The UA names a TV platform (Tizen, webOS, Google/Android TV, HbbTV,
 *    Fire TV's Silk, Roku, Vizio, Hisense — every smart-TV browser with a
 *    production footprint worth spending this on).
 *  - The device reports no fine pointer and no hover — the same signal a TV
 *    remote gives a browser with a generic or unrecognised UA.
 * A `?tv=1` query flag forces it on, for testing without a real TV browser
 * or a spoofed UA.
 */
const TV_UA_PATTERN =
  /Tizen|SmartTV|SMART-TV|WebOS|Web0S|GoogleTV|Android TV|AFTB|AFTT|AFTS|AFTA|AFTN|CrKey|HbbTV|Roku|VIDAA|VIZIO|Hisense/i

function hasNoPointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return !window.matchMedia('(hover: hover)').matches && !window.matchMedia('(pointer: fine)').matches
}

export function detectTvMode(): boolean {
  if (typeof window === 'undefined') return false
  if (new URLSearchParams(window.location.search).get('tv') === '1') return true
  if (TV_UA_PATTERN.test(window.navigator.userAgent)) return true
  return hasNoPointer()
}

/** Applies the `data-tv-mode` attribute the CSS type scale and overscan padding key on. */
export function applyTvMode(): void {
  if (detectTvMode()) document.documentElement.dataset.tvMode = 'true'
}
