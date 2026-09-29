import { useEffect } from 'react'

/**
 * Shows how many favourites can be played right now on the installed app's icon.
 *
 * Installed only (`display-mode: standalone`): a browser tab has no icon to badge.
 * Local, no network: the count comes from the catalogue already in memory, so it
 * costs no schedule reads. Not a notification; the badge never prompts anyone and
 * clears itself at zero.
 */
export function useAppBadge(count: number) {
  useEffect(() => {
    const nav = navigator as Navigator & {
      setAppBadge?: (n?: number) => Promise<void>
      clearAppBadge?: () => Promise<void>
    }
    if (!nav.setAppBadge || !window.matchMedia?.('(display-mode: standalone)').matches) return
    const apply = count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge?.()
    apply?.catch(() => {})
  }, [count])
}
