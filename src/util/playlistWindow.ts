/** Most ids a zap playlist may carry into history state / sessionStorage. */
export const MAX_PLAYLIST = 500

/**
 * Bounds a playlist to a window of at most `max` ids around `currentId`, so a
 * multi-thousand-channel list is never serialised on a click. Order is kept;
 * the window wraps nothing, it simply slides to keep the current channel in it.
 */
export function windowPlaylist(ids: readonly string[], currentId: string, max = MAX_PLAYLIST): string[] {
  if (ids.length <= max) return ids as string[]
  const at = ids.indexOf(currentId)
  const start = Math.max(0, Math.min(ids.length - max, (at < 0 ? 0 : at) - Math.floor(max / 2)))
  return ids.slice(start, start + max)
}
