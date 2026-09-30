import { useCallback } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import type { EnrichedChannel } from './useChannels'
import { prefetchPlaylist } from '../util/playlistPrefetch'
import { windowPlaylist } from '../util/playlistWindow'
import { navigateWithLogoTransition } from '../util/viewTransition'

interface OpenOptions {
  /** The row's channel ids, so the player's prev/next walks that row. */
  playlist?: string[]
  onWatch?: (channelId: string) => void
  /** The logo the view transition morphs from; null for a plain navigation. */
  logo?: HTMLImageElement | null
}

/**
 * Opens a channel in the player the way a card does: prefetch its first playlist,
 * remember where to return to, keep a windowed playlist for zapping. Shared by
 * `ChannelCard` and the category rows' "live now" strip so both entry points
 * behave identically. A channel without a stream is a no-op.
 */
export function useOpenChannel() {
  const navigate = useNavigate()
  const location = useLocation()
  return useCallback(
    (channel: EnrichedChannel, { playlist, onWatch, logo = null }: OpenOptions = {}) => {
      if (!channel.stream) return
      prefetchPlaylist(channel)
      onWatch?.(channel.id)
      sessionStorage.setItem('sl_last_viewed', channel.id)
      const returnPath = location.pathname + location.search
      sessionStorage.setItem('sl_return_to', returnPath)
      const windowed = playlist ? windowPlaylist(playlist, channel.id) : undefined
      const hasMultipleInPlaylist = Boolean(windowed && windowed.length > 1)
      if (hasMultipleInPlaylist) {
        try {
          sessionStorage.setItem('sl_active_playlist', JSON.stringify(windowed))
        } catch {}
      } else {
        try {
          sessionStorage.removeItem('sl_active_playlist')
        } catch {}
      }
      navigateWithLogoTransition(logo, () =>
        navigate(`/watch/${encodeURIComponent(channel.id)}`, {
          state: {
            playlist: hasMultipleInPlaylist ? windowed : undefined,
            returnTo: returnPath,
          },
        }),
      )
    },
    [location.pathname, location.search, navigate],
  )
}
