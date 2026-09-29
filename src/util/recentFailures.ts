/**
 * Channels that failed to play recently on this device. In memory only (gone on reload), no
 * storage, no identifier. Separate from `markStreamBroken`: this never hides anything, it only
 * lets "Surprise me" steer clear of a channel that just let the user down.
 */
const TTL_MS = 30 * 60 * 1000
const failures = new Map<string, number>()

export function noteFailure(channelId: string, now = Date.now()) {
  if (channelId) failures.set(channelId, now)
}

export function hasRecentFailure(channelId: string, now = Date.now()): boolean {
  const at = failures.get(channelId)
  if (at === undefined) return false
  if (now - at >= TTL_MS) {
    failures.delete(channelId)
    return false
  }
  return true
}

export function clearRecentFailures() {
  failures.clear()
}
