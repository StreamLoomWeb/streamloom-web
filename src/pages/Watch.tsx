import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { useMemo } from 'react'
import { useChannels } from '../hooks/useChannels'
import type { EnrichedChannel } from '../hooks/useChannels'
import { isChannelHidden, isHideBrokenStreamsEnabled, isStreamBroken } from '../util/stream'
import { VideoPlayer } from '../components/VideoPlayer'

export function Watch() {
  const { channelId } = useParams<{ channelId: string }>()
  const { channels, allChannels, loading, epgChannelIds } = useChannels()
  const navigate = useNavigate()
  const location = useLocation()

  const channelIdParam = channelId ? decodeURIComponent(channelId) : ''
  const channel = (allChannels ?? channels).find((c) => c.id === channelId || c.id === channelIdParam)

  // Retrieve playlist from route state OR fallback to sessionStorage
  const playlistIds = useMemo(() => {
    const fromState = (location.state as { playlist?: string[] } | null)?.playlist
    if (fromState && Array.isArray(fromState) && fromState.length > 1) {
      try {
        sessionStorage.setItem('sl_active_playlist', JSON.stringify(fromState))
      } catch {}
      return fromState
    }
    try {
      const stored = sessionStorage.getItem('sl_active_playlist')
      if (stored) {
        const parsed = JSON.parse(stored)
        if (Array.isArray(parsed) && parsed.length > 1) {
          return parsed as string[]
        }
      }
    } catch {}
    return null
  }, [location.state])

  const returnTo = useMemo(() => {
    const fromState = (location.state as { returnTo?: string } | null)?.returnTo
    if (fromState) {
      try {
        sessionStorage.setItem('sl_return_to', fromState)
      } catch {}
      return fromState
    }
    return sessionStorage.getItem('sl_return_to') || '/'
  }, [location.state])

  const channelMap = useMemo(
    () => new Map((allChannels ?? channels).map((c) => [c.id, c])),
    [allChannels, channels]
  )

  // Preserve the exact list and order from the screen the user came from
  const orderedPlaylist = useMemo(() => {
    const hideBroken = isHideBrokenStreamsEnabled()
    // The channel being watched always stays in its own playlist.
    const listed = (c: EnrichedChannel) =>
      c.id === channel?.id || (!isChannelHidden(c.id) && (!hideBroken || !isStreamBroken(c.id)))
    if (playlistIds && Array.isArray(playlistIds) && playlistIds.length > 1) {
      const list = playlistIds
        .map((id) => channelMap.get(id))
        .filter((c): c is EnrichedChannel => Boolean(c?.stream && listed(c)))
      if (list.length > 1 && channel && list.some((c) => c.id === channel.id)) {
        return list
      }
    }
    const fullList = (allChannels && allChannels.length > 0 ? allChannels : channels).filter((c) => c.stream)
    const baseList = fullList.filter(listed)
    if (channel && !baseList.some((c) => c.id === channel.id)) {
      return [channel, ...baseList]
    }
    return baseList
  }, [playlistIds, channelMap, channels, allChannels, channel])

  if (loading && !channels.length) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100dvh', color: 'var(--text-muted)' }}>
        Loading…
      </div>
    )
  }

  if (!channel || !channel.stream) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100dvh', gap: 16, color: 'var(--text-secondary)' }}>
        <p>Channel not found or no stream available.</p>
        <button
          style={{ padding: '10px 24px', background: 'var(--accent-gradient)', color: 'white', borderRadius: 'var(--radius-full)', fontWeight: 700, cursor: 'pointer', border: 'none' }}
          onClick={() => navigate(returnTo, { state: { targetChannelId: channelIdParam } })}
        >
          ← Go back
        </button>
      </div>
    )
  }

  return (
    <VideoPlayer
      channel={channel}
      allChannels={orderedPlaylist}
      returnTo={returnTo}
      epgChannelIds={epgChannelIds}
    />
  )
}
