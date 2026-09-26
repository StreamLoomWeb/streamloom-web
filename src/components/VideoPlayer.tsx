import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import Hls from 'hls.js'
import type { EnrichedChannel } from '../hooks/useChannels'
import type { EpgProgram } from '../api/types'
import { useEpg, useFavourites, useRecent } from '../hooks/useChannels'
import { useOccasionAccessory } from '../api/occasion'
import { FixerBotMascot } from './FixerBotMascot'
import { formatCountryDisplay } from '../util/country'
import { LOGO_SIZE, logoUrl, handleLogoError } from '../util/logo'
import { orderStreamsForPlayback, rankResolution } from '../util/resolution'
import {
  getProxyStreamUrl,
  isMixedContent,
  unmarkStreamBroken,
  tryUpgradeToHttps,
  getCachedWorkingStream,
  cacheWorkingStream,
  fetchEdgeVerifiedStreams,
  isAutoSkipEnabled,
  hideChannel,
} from '../util/stream'
import {
  classifyHlsError,
  classifyMediaElementError,
  recordStreamFailure,
} from '../util/streamFailure'
import type { FailureClass } from '../util/streamFailure'
import './VideoPlayer.css'

interface Props {
  channel: EnrichedChannel
  allChannels: EnrichedChannel[]
  returnTo?: string
}

export interface MediaTrackItem {
  id: number
  name: string
  lang?: string
  type?: string
}

function getCurrentProgram(programs: EpgProgram[], nowMs: number): EpgProgram | undefined {
  return programs.find((p) => {
    const start = new Date(p.start_time).getTime()
    const end = new Date(p.end_time).getTime()
    return nowMs >= start && nowMs < end
  })
}

/** Why each candidate of one channel failed, so exhaustion can be judged as a whole. */
interface FailureEvidence {
  channelId: string
  /** Class of the most recent failed attempt, per candidate index. */
  verdicts: Map<number, FailureClass>
}

export function VideoPlayer({ channel, allChannels, returnTo = '/' }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const navigate = useNavigate()
  const { programs } = useEpg(channel.id)
  const { isFavourite, toggle } = useFavourites()
  const { addRecent } = useRecent()
  const occasionAccessory = useOccasionAccessory()

  const [isPlaying, setIsPlaying] = useState(true)
  const [isMuted, setIsMuted] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [isBuffering, setIsBuffering] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [networkIssue, setNetworkIssue] = useState(false)
  const [isSlowConnecting, setIsSlowConnecting] = useState(false)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const toastTimer = useRef<number | null>(null)
  const [autoSkipCountdown, setAutoSkipCountdown] = useState<number | null>(null)
  const countdownTimerRef = useRef<number | null>(null)
  const [showChannelList, setShowChannelList] = useState(false)
  const [showHud, setShowHud] = useState(true)
  const hideHudTimer = useRef<number | null>(null)
  const connectionTimeoutTimer = useRef<number | null>(null)
  const failoverTimer = useRef<number | null>(null)

  const [subtitleTracks, setSubtitleTracks] = useState<MediaTrackItem[]>([])
  const [activeSubtitleTrack, setActiveSubtitleTrack] = useState<number>(-1)
  const [audioTracks, setAudioTracks] = useState<MediaTrackItem[]>([])
  const [activeAudioTrack, setActiveAudioTrack] = useState<number>(-1)
  const [showSubtitleMenu, setShowSubtitleMenu] = useState(false)
  const [showAudioMenu, setShowAudioMenu] = useState(false)
  const subtitleMenuRef = useRef<HTMLDivElement>(null)
  const audioMenuRef = useRef<HTMLDivElement>(null)

  const isHudVisible = showHud || isBuffering

  const resetHudTimer = useCallback(() => {
    setShowHud(true)
    if (hideHudTimer.current) window.clearTimeout(hideHudTimer.current)
    if (!isBuffering) {
      hideHudTimer.current = window.setTimeout(() => {
        setShowHud(false)
      }, isFullscreen ? 1800 : 3500)
    }
  }, [isBuffering, isFullscreen])

  const channelStreams = useMemo(() => {
    const rawStreams = channel.streams && channel.streams.length > 0
      ? channel.streams
      : (channel.stream ? [channel.stream] : [])

    const cached = getCachedWorkingStream(channel.id)
    return orderStreamsForPlayback(rawStreams, cached?.url)
  }, [channel])

  const [prevChannelId, setPrevChannelId] = useState(channel.id)
  const [activeStreamIdx, setActiveStreamIdx] = useState(0)
  const [isProxied, setIsProxied] = useState(() => {
    const ordered = orderStreamsForPlayback(
      channel.streams && channel.streams.length > 0
        ? channel.streams
        : (channel.stream ? [channel.stream] : []),
      getCachedWorkingStream(channel.id)?.url
    )
    const first = ordered[0]
    if (!first) return false
    const cached = getCachedWorkingStream(channel.id)
    if (cached && cached.url === first.url) return cached.useProxy || isMixedContent(first.url)
    return isMixedContent(first.url)
  })
  const [retryNonce, setRetryNonce] = useState(0)

  const channelRef = useRef(channel)
  const allChannelsRef = useRef(allChannels)
  const activeStreamIdxRef = useRef(activeStreamIdx)
  const isProxiedRef = useRef(isProxied)
  const channelStreamsRef = useRef(channelStreams)
  const stallTimer = useRef<number | null>(null)
  const mediaRecoveryAttempts = useRef(0)
  const hasPlayedSuccessfully = useRef(false)
  const switchChannelCleanlyRef = useRef<(target: EnrichedChannel) => void>(() => {})
  const failoverToNextAttemptRef = useRef<(cause: FailureClass) => void>(() => {})
  const failureEvidenceRef = useRef<FailureEvidence | null>(null)

  if (channel.id !== prevChannelId) {
    setPrevChannelId(channel.id)
    setActiveStreamIdx(0)
    const cached = getCachedWorkingStream(channel.id)
    const orderedStreams = orderStreamsForPlayback(
      channel.streams && channel.streams.length > 0
        ? channel.streams
        : (channel.stream ? [channel.stream] : []),
      cached?.url
    )
    const firstCandidate = orderedStreams[0]
    const initProxy = firstCandidate
      ? ((cached && cached.url === firstCandidate.url ? cached.useProxy : false) || isMixedContent(firstCandidate.url))
      : false
    setIsProxied(initProxy)
    setHasError(false)
    setNetworkIssue(false)
    setIsBuffering(true)
    setIsSlowConnecting(false)
    setShowHud(true)
    setSubtitleTracks([])
    setActiveSubtitleTrack(-1)
    setAudioTracks([])
    setActiveAudioTrack(-1)
    setShowSubtitleMenu(false)
    setShowAudioMenu(false)
  }

  useEffect(() => {
    channelRef.current = channel
    allChannelsRef.current = allChannels
    activeStreamIdxRef.current = activeStreamIdx
    isProxiedRef.current = isProxied
    channelStreamsRef.current = channelStreams
  }, [channel, allChannels, activeStreamIdx, isProxied, channelStreams])

  // Proactively check edge-verified working streams for this POP when the channel
  // has multiple candidates, then upgrade to the highest resolution that verified.
  useEffect(() => {
    if (!channelStreams || channelStreams.length <= 1) return
    const cached = getCachedWorkingStream(channel.id)

    // Skip when the cached stream is already the best resolution available.
    if (cached) {
      const cachedStream = channelStreams.find((s) => s.url === cached.url)
      const best = channelStreams[0]
      if (cachedStream && rankResolution(cachedStream.quality) >= rankResolution(best?.quality)) {
        return
      }
    }

    let cancelled = false
    const urls = channelStreams.map((s) => s.url)
    const qualities = channelStreams.map((s) => s.quality)
    fetchEdgeVerifiedStreams(channel.id, urls, qualities).then((result) => {
      if (cancelled || !result) return
      const verified = result.workingCandidates.length > 0
        ? result.workingCandidates
        : result.workingStream
          ? [result.workingStream]
          : []
      if (verified.length === 0) return

      // Highest resolution among the candidates the edge confirmed as live.
      const bestVerified = verified
        .map((u) => channelStreamsRef.current.find((s) => s.url === u))
        .filter((s): s is EnrichedChannel['streams'][number] => Boolean(s))
        .sort((a, b) => rankResolution(b.quality) - rankResolution(a.quality))[0]

      if (!bestVerified) return
      cacheWorkingStream(channel.id, bestVerified.url, isProxiedRef.current, bestVerified.quality)

      const matchIdx = channelStreamsRef.current.findIndex((s) => s.url === bestVerified.url)
      if (matchIdx > 0 && activeStreamIdxRef.current === 0) {
        setActiveStreamIdx(matchIdx)
      }
    })

    return () => {
      cancelled = true
    }
  }, [channel.id, channelStreams])

  const currentStream = channelStreams[activeStreamIdx] || channel.stream
  const streamUrl = currentStream?.url

  const togglePlayPause = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      v.play().catch(() => {})
      setIsPlaying(true)
    } else {
      v.pause()
    }
    resetHudTimer()
  }, [resetHudTimer])

  const toggleMute = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    v.muted = !v.muted
    setIsMuted(v.muted)
    resetHudTimer()
  }, [resetHudTimer])

  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current
    if (!container) return

    if (!document.fullscreenElement) {
      container.requestFullscreen().then(() => {
        setIsFullscreen(true)
        if (hideHudTimer.current) window.clearTimeout(hideHudTimer.current)
        hideHudTimer.current = window.setTimeout(() => {
          setShowHud(false)
        }, 1200)
      }).catch(() => {})
    } else {
      document.exitFullscreen().then(() => {
        setIsFullscreen(false)
        setShowHud(true)
      }).catch(() => {})
    }
  }, [])

  useEffect(() => {
    function onFullscreenChange() {
      const isFs = Boolean(document.fullscreenElement)
      setIsFullscreen(isFs)
      if (isFs) {
        if (hideHudTimer.current) window.clearTimeout(hideHudTimer.current)
        hideHudTimer.current = window.setTimeout(() => {
          setShowHud(false)
        }, 1200)
      } else {
        setShowHud(true)
      }
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  const handleMouseMove = useCallback(() => {
    setShowHud(true)
    if (hideHudTimer.current) window.clearTimeout(hideHudTimer.current)
    hideHudTimer.current = window.setTimeout(() => {
      setShowHud(false)
    }, isFullscreen ? 1800 : 3500)
  }, [isFullscreen])

  const togglePiP = useCallback(async () => {
    const v = videoRef.current
    if (!v) return
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture()
      } else if (document.pictureInPictureEnabled) {
        await v.requestPictureInPicture()
      }
    } catch {
      // ignore
    }
    resetHudTimer()
  }, [resetHudTimer])

  const showToast = useCallback((msg: string, duration = 2500) => {
    setToastMessage(msg)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => {
      setToastMessage(null)
    }, duration)
  }, [])

  const cancelCountdown = useCallback(() => {
    if (countdownTimerRef.current) {
      window.clearTimeout(countdownTimerRef.current)
      countdownTimerRef.current = null
      setAutoSkipCountdown(null)
      sessionStorage.removeItem('sl_autoskip_start')
    }
  }, [])

  // Leaving the player ends any pending auto-skip, including one still waiting on
  // the connectivity check in failoverToNextAttempt.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      cancelCountdown()
    }
  }, [cancelCountdown])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        subtitleMenuRef.current &&
        !subtitleMenuRef.current.contains(e.target as Node)
      ) {
        setShowSubtitleMenu(false)
      }
      if (
        audioMenuRef.current &&
        !audioMenuRef.current.contains(e.target as Node)
      ) {
        setShowAudioMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const selectSubtitleTrack = useCallback((trackId: number) => {
    const hls = hlsRef.current
    const video = videoRef.current

    if (hls && hls.subtitleTracks && hls.subtitleTracks.length > 0) {
      if (trackId < 0) {
        hls.subtitleTrack = -1
        hls.subtitleDisplay = false
        setActiveSubtitleTrack(-1)
        localStorage.setItem('sl_subtitles_enabled', 'false')
        showToast('Subtitles: Off')
      } else {
        hls.subtitleTrack = trackId
        hls.subtitleDisplay = true
        setActiveSubtitleTrack(trackId)
        localStorage.setItem('sl_subtitles_enabled', 'true')
        const track = hls.subtitleTracks[trackId]
        if (track) {
          const lang = track.lang || track.name
          if (lang) localStorage.setItem('sl_subtitles_lang', lang)
          showToast(`Subtitles: ${track.name || track.lang || `Track ${trackId + 1}`}`)
        }
      }
    } else if (video && video.textTracks && video.textTracks.length > 0) {
      const tracks = Array.from(video.textTracks)
      if (trackId < 0) {
        tracks.forEach((t) => {
          t.mode = 'disabled'
        })
        setActiveSubtitleTrack(-1)
        localStorage.setItem('sl_subtitles_enabled', 'false')
        showToast('Subtitles: Off')
      } else {
        tracks.forEach((t, i) => {
          t.mode = i === trackId ? 'showing' : 'disabled'
        })
        setActiveSubtitleTrack(trackId)
        localStorage.setItem('sl_subtitles_enabled', 'true')
        const target = tracks[trackId]
        if (target) {
          const lang = target.language || target.label
          if (lang) localStorage.setItem('sl_subtitles_lang', lang)
          showToast(`Subtitles: ${target.label || target.language || `Track ${trackId + 1}`}`)
        }
      }
    }
  }, [showToast])

  const selectAudioTrack = useCallback((trackId: number) => {
    const hls = hlsRef.current
    if (hls && hls.audioTracks && hls.audioTracks.length > 0) {
      if (trackId >= 0 && trackId < hls.audioTracks.length) {
        hls.audioTrack = trackId
        setActiveAudioTrack(trackId)
        const track = hls.audioTracks[trackId]
        if (track) {
          const lang = track.lang || track.name
          if (lang) localStorage.setItem('sl_audio_lang', lang)
          showToast(`Audio: ${track.name || track.lang || `Track ${trackId + 1}`}`)
        }
      }
    }
  }, [showToast])

  const toggleSubtitles = useCallback(() => {
    if (subtitleTracks.length === 0) {
      showToast('No subtitles available for this stream')
      return
    }
    if (activeSubtitleTrack === -1) {
      const prefLang = localStorage.getItem('sl_subtitles_lang')
      let targetIdx = 0
      if (prefLang) {
        const found = subtitleTracks.findIndex(
          (t) =>
            (t.lang && t.lang.toLowerCase() === prefLang.toLowerCase()) ||
            (t.name && t.name.toLowerCase().includes(prefLang.toLowerCase()))
        )
        if (found >= 0) targetIdx = found
      }
      selectSubtitleTrack(targetIdx)
    } else if (subtitleTracks.length === 1) {
      selectSubtitleTrack(-1)
    } else {
      const nextIdx = activeSubtitleTrack + 1
      if (nextIdx >= subtitleTracks.length) {
        selectSubtitleTrack(-1)
      } else {
        selectSubtitleTrack(nextIdx)
      }
    }
  }, [subtitleTracks, activeSubtitleTrack, selectSubtitleTrack, showToast])

  const cycleAudioTracks = useCallback(() => {
    if (audioTracks.length <= 1) {
      showToast(audioTracks.length === 1 ? `Audio: ${audioTracks[0]?.name || 'Standard'}` : 'Default audio track')
      return
    }
    const nextIdx = (activeAudioTrack + 1) % audioTracks.length
    selectAudioTrack(nextIdx)
  }, [audioTracks, activeAudioTrack, selectAudioTrack, showToast])

  // Switch channel preserving the active playlist and return path
  const switchChannel = useCallback((target: EnrichedChannel) => {
    if (failoverTimer.current) {
      window.clearTimeout(failoverTimer.current)
      failoverTimer.current = null
    }
    if (connectionTimeoutTimer.current) {
      window.clearTimeout(connectionTimeoutTimer.current)
      connectionTimeoutTimer.current = null
    }
    if (stallTimer.current) {
      window.clearTimeout(stallTimer.current)
      stallTimer.current = null
    }
    // Immediately stop current HLS loader and media buffer to prevent lockup
    if (hlsRef.current) {
      hlsRef.current.stopLoad()
      hlsRef.current.detachMedia()
      hlsRef.current.destroy()
      hlsRef.current = null
    }
    const video = videoRef.current
    if (video) {
      video.onloadedmetadata = null
      video.onplaying = null
      video.onerror = null
      video.pause()
    }

    sessionStorage.setItem('sl_last_viewed', target.id)
    ;(document.activeElement as HTMLElement)?.blur?.()

    const currentPlaylist = allChannelsRef.current
    const isCustomPlaylist = currentPlaylist.length > 1 && currentPlaylist.length < 500
    const playlistIds = isCustomPlaylist ? currentPlaylist.map((c) => c.id) : undefined
    if (isCustomPlaylist) {
      try {
        sessionStorage.setItem('sl_active_playlist', JSON.stringify(playlistIds))
      } catch {}
    }

    navigate(`/watch/${encodeURIComponent(target.id)}`, {
      replace: true,
      state: {
        playlist: playlistIds,
        returnTo,
      },
    })
  }, [returnTo, navigate])

  const switchChannelCleanly = useCallback((target: EnrichedChannel) => {
    cancelCountdown()
    switchChannel(target)
  }, [cancelCountdown, switchChannel])

  useEffect(() => {
    switchChannelCleanlyRef.current = switchChannelCleanly
  }, [switchChannelCleanly])

  // Return to the exact screen entered from and target the last watched channel
  const handleBack = useCallback(() => {
    cancelCountdown()
    if (failoverTimer.current) {
      window.clearTimeout(failoverTimer.current)
      failoverTimer.current = null
    }
    if (connectionTimeoutTimer.current) {
      window.clearTimeout(connectionTimeoutTimer.current)
      connectionTimeoutTimer.current = null
    }
    if (hlsRef.current) {
      hlsRef.current.stopLoad()
      hlsRef.current.detachMedia()
      hlsRef.current.destroy()
      hlsRef.current = null
    }
    const video = videoRef.current
    if (video) {
      video.onloadedmetadata = null
      video.onerror = null
      video.pause()
    }
    sessionStorage.setItem('sl_last_viewed', channel.id)
    ;(document.activeElement as HTMLElement)?.blur?.()
    navigate(returnTo, { state: { targetChannelId: channel.id } })
  }, [cancelCountdown, channel.id, returnTo, navigate])

  // The user's own choice to drop this channel from every list; undone in Settings.
  const handleHideChannel = useCallback(() => {
    cancelCountdown()
    const current = channelRef.current
    const playlist = allChannelsRef.current
    const pos = playlist.findIndex((c) => c.id === current.id)
    const next = playlist.length > 1 ? playlist[(pos + 1) % playlist.length] : null
    hideChannel(current.id)
    if (next && next.id !== current.id) {
      showToast(`${current.name} hidden · restore it in Settings`, 3500)
      switchChannelCleanly(next)
    } else {
      handleBack()
    }
  }, [cancelCountdown, showToast, switchChannelCleanly, handleBack])

  const targetChannelIdRef = useRef(channel.id)

  useEffect(() => {
    targetChannelIdRef.current = channel.id
  }, [channel.id])

  const channelIdx = allChannels.findIndex((c) => c.id === channel.id)

  /**
   * Warms the next channel's manifest while the current channel still plays.
   *
   * HLS spends its first 300-800ms fetching and parsing the manifest. Firing a
   * single low-priority request for the resolved URL ahead of time lets the edge
   * and browser cache the response, so switching feels instant.
   */
  useEffect(() => {
    if (allChannels.length <= 1) return
    const idx = allChannels.findIndex((c) => c.id === channel.id)
    const neighbour = idx >= 0 ? allChannels[(idx + 1) % allChannels.length] : allChannels[0]
    if (!neighbour || neighbour.id === channel.id) return

    const timer = window.setTimeout(() => {
      const streams = neighbour.streams && neighbour.streams.length > 0
        ? neighbour.streams
        : (neighbour.stream ? [neighbour.stream] : [])
      const cached = getCachedWorkingStream(neighbour.id)
      const ordered = orderStreamsForPlayback(streams, cached?.url)
      const target = ordered[0]
      if (!target?.url) return
      const useProxy = (cached && cached.url === target.url ? cached.useProxy : false) || isMixedContent(target.url)
      const warmUrl = useProxy ? getProxyStreamUrl(target.url, null, null, [], neighbour.id) : target.url
      fetch(warmUrl, { method: 'GET', priority: 'low', cache: 'force-cache' } as RequestInit).catch(() => {})
    }, 1500)

    return () => window.clearTimeout(timer)
  }, [channel.id, allChannels])

  // Cycle within filtered list in the same order shown, with wraparound
  const prevChannel = useMemo(() => {
    if (allChannels.length <= 1) return null
    if (channelIdx > 0) return allChannels[channelIdx - 1]
    return allChannels[allChannels.length - 1]
  }, [allChannels, channelIdx])

  const nextChannel = useMemo(() => {
    if (allChannels.length <= 1) return null
    if (channelIdx >= 0 && channelIdx < allChannels.length - 1) return allChannels[channelIdx + 1]
    return allChannels[0]
  }, [allChannels, channelIdx])

  const goToNextChannel = useCallback(() => {
    if (allChannels.length <= 1) return
    const currentId = targetChannelIdRef.current
    const curIdx = allChannels.findIndex((c) => c.id === currentId)
    const nextIdx = curIdx >= 0 && curIdx < allChannels.length - 1 ? curIdx + 1 : 0
    const target = allChannels[nextIdx]
    if (target) {
      targetChannelIdRef.current = target.id
      switchChannelCleanly(target)
    }
  }, [allChannels, switchChannelCleanly])

  const goToPrevChannel = useCallback(() => {
    if (allChannels.length <= 1) return
    const currentId = targetChannelIdRef.current
    const curIdx = allChannels.findIndex((c) => c.id === currentId)
    const prevIdx = curIdx > 0 ? curIdx - 1 : allChannels.length - 1
    const target = allChannels[prevIdx]
    if (target) {
      targetChannelIdRef.current = target.id
      switchChannelCleanly(target)
    }
  }, [allChannels, switchChannelCleanly])

  const failoverToNextAttempt = useCallback((cause: FailureClass) => {
    if (failoverTimer.current) {
      window.clearTimeout(failoverTimer.current)
      failoverTimer.current = null
    }
    if (connectionTimeoutTimer.current) {
      window.clearTimeout(connectionTimeoutTimer.current)
      connectionTimeoutTimer.current = null
    }
    if (stallTimer.current) {
      window.clearTimeout(stallTimer.current)
      stallTimer.current = null
    }

    const curIdx = activeStreamIdxRef.current
    const streams = channelStreamsRef.current
    const curStream = streams[curIdx]
    const curUrl = curStream?.url
    const currentIsProxied = isProxiedRef.current
    const currentChannel = channelRef.current

    let evidence = failureEvidenceRef.current
    if (!evidence || evidence.channelId !== currentChannel.id) {
      evidence = { channelId: currentChannel.id, verdicts: new Map() }
      failureEvidenceRef.current = evidence
    }
    evidence.verdicts.set(curIdx, cause)

    // 1. If currently direct, retry via edge proxy
    if (!currentIsProxied && curUrl && !curUrl.startsWith('/api/proxy')) {
      showToast('Direct stream blocked, retrying via edge proxy…')
      mediaRecoveryAttempts.current = 0
      isProxiedRef.current = true
      setIsProxied(true)
      setIsBuffering(true)
      setIsSlowConnecting(false)
      return
    }

    // 2. If proxy also failed (or mixed content proxy failed), try next candidate
    if (streams.length > 1 && curIdx < streams.length - 1) {
      const nextIdx = curIdx + 1
      const nextStream = streams[nextIdx]
      const nextUseProxy = isMixedContent(nextStream.url)
      showToast(`Stream unresponsive, trying candidate ${nextIdx + 1} of ${streams.length}…`)
      mediaRecoveryAttempts.current = 0
      activeStreamIdxRef.current = nextIdx
      setActiveStreamIdx(nextIdx)
      isProxiedRef.current = nextUseProxy
      setIsProxied(nextUseProxy)
      setIsBuffering(true)
      setIsSlowConnecting(false)
      return
    }

    // 3. All stream candidates and proxy attempts exhausted for this channel
    setHasError(true)
    setIsBuffering(false)
    setIsSlowConnecting(false)

    const skipToNext = () => {
      const playlist = allChannelsRef.current
      const curPos = playlist.findIndex((c) => c.id === currentChannel.id)
      let nextTarget: EnrichedChannel | null = null

      if (playlist.length > 1) {
        if (curPos >= 0 && curPos < playlist.length - 1) {
          nextTarget = playlist[curPos + 1]
        } else if (curPos >= 0) {
          nextTarget = playlist[0]
        } else {
          nextTarget = playlist.find((c) => c.id !== currentChannel.id) || null
        }
      }

      if (!nextTarget || nextTarget.id === currentChannel.id) return
      const autoSkipStart = sessionStorage.getItem('sl_autoskip_start')
      if (autoSkipStart === nextTarget.id) {
        // Loop guard: looped all the way back to the starting broken channel
        sessionStorage.removeItem('sl_autoskip_start')
        showToast('All channels in this playlist are currently unavailable', 3500)
        return
      }
      if (!autoSkipStart) {
        sessionStorage.setItem('sl_autoskip_start', currentChannel.id)
      }

      showToast(`⚠️ ${currentChannel.name} unavailable · Auto-skipping to ${nextTarget.name}…`, 3000)
      setAutoSkipCountdown(1)
      if (countdownTimerRef.current) window.clearTimeout(countdownTimerRef.current)
      countdownTimerRef.current = window.setTimeout(() => {
        countdownTimerRef.current = null
        setAutoSkipCountdown(null)
        switchChannelCleanlyRef.current(nextTarget)
      }, 1200)
    }

    // The channel is flagged only for stream-specific failures with the user's
    // connection confirmed working; auto-skip likewise needs a working connection,
    // so an outage on the user's side never walks them through the playlist.
    void recordStreamFailure(
      currentChannel.id,
      evidence.verdicts,
      streams.length,
      () => failureEvidenceRef.current === evidence
    ).then(({ reachable }) => {
      if (!mountedRef.current || failureEvidenceRef.current !== evidence) return
      if (!reachable) {
        setNetworkIssue(true)
        return
      }
      if (isAutoSkipEnabled() && channelRef.current.id === currentChannel.id) skipToNext()
    })
  }, [showToast])

  useEffect(() => {
    failoverToNextAttemptRef.current = failoverToNextAttempt
  }, [failoverToNextAttempt])

  const handleNextStreamCandidate = useCallback(() => {
    cancelCountdown()
    if (channelStreams.length <= 1) return
    const curIdx = activeStreamIdxRef.current
    const nextIdx = (curIdx + 1) % channelStreams.length
    const nextStream = channelStreams[nextIdx]
    const nextUseProxy = isMixedContent(nextStream.url)
    activeStreamIdxRef.current = nextIdx
    setActiveStreamIdx(nextIdx)
    mediaRecoveryAttempts.current = 0
    hasPlayedSuccessfully.current = false
    isProxiedRef.current = nextUseProxy
    setIsProxied(nextUseProxy)
    failureEvidenceRef.current = null
    setNetworkIssue(false)
    setHasError(false)
    setIsBuffering(true)
    setIsSlowConnecting(false)
    showToast(`Switching to stream candidate ${nextIdx + 1} of ${channelStreams.length}…`)
  }, [channelStreams, showToast, cancelCountdown])

  const handleRetry = useCallback(() => {
    cancelCountdown()
    failureEvidenceRef.current = null
    setNetworkIssue(false)
    setHasError(false)
    setIsBuffering(true)
    setIsSlowConnecting(false)
    setActiveStreamIdx(0)
    activeStreamIdxRef.current = 0
    mediaRecoveryAttempts.current = 0
    hasPlayedSuccessfully.current = false
    const rawStreams = channelStreamsRef.current
    const firstUrl = rawStreams[0]?.url
    const initProxy = firstUrl ? isMixedContent(firstUrl) : false
    isProxiedRef.current = initProxy
    setIsProxied(initProxy)
    setRetryNonce((n) => n + 1)
  }, [cancelCountdown])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const stream = channelStreams[activeStreamIdx] || channel.stream
    const rawUrl = stream?.url
    if (!rawUrl) {
      window.queueMicrotask(() => {
        failoverToNextAttemptRef.current('inconclusive')
      })
      return
    }

    let isDisposed = false

    if (connectionTimeoutTimer.current) window.clearTimeout(connectionTimeoutTimer.current)
    if (failoverTimer.current) window.clearTimeout(failoverTimer.current)
    if (stallTimer.current) window.clearTimeout(stallTimer.current)
    hasPlayedSuccessfully.current = false
    mediaRecoveryAttempts.current = 0

    // Slow connection indicator after 4.5s
    connectionTimeoutTimer.current = window.setTimeout(() => {
      if (!isDisposed) setIsSlowConnecting(true)
    }, 4500)

    // Failover watchdog timer: if stream not parsed / buffered in 7s, trigger failover
    failoverTimer.current = window.setTimeout(() => {
      if (!isDisposed) {
        failoverToNextAttemptRef.current('inconclusive')
      }
    }, 7000)

    const onPlaybackSuccess = () => {
      if (isDisposed) return
      if (failoverTimer.current) {
        window.clearTimeout(failoverTimer.current)
        failoverTimer.current = null
      }
      if (connectionTimeoutTimer.current) {
        window.clearTimeout(connectionTimeoutTimer.current)
        connectionTimeoutTimer.current = null
      }
      if (stallTimer.current) {
        window.clearTimeout(stallTimer.current)
        stallTimer.current = null
      }
      hasPlayedSuccessfully.current = true
      sessionStorage.removeItem('sl_autoskip_start')
      setIsBuffering(false)
      setIsSlowConnecting(false)
      setHasError(false)
      failureEvidenceRef.current = null
      unmarkStreamBroken(channel.id)
      const playedStream = channelStreamsRef.current[activeStreamIdxRef.current]
      cacheWorkingStream(channel.id, rawUrl, isProxied, playedStream?.quality)
    }

    // Determine target playback URL
    let targetUrl = rawUrl
    if (isProxied) {
      const fallbackUrls = channelStreams
        .filter((_, idx) => idx !== activeStreamIdx)
        .map((s) => s.url)
      targetUrl = getProxyStreamUrl(
        rawUrl,
        null,
        null,
        fallbackUrls,
        channel.id
      )
    } else if (isMixedContent(rawUrl)) {
      targetUrl = tryUpgradeToHttps(rawUrl)
    }

    // Stop and cleanup previous HLS instance
    if (hlsRef.current) {
      hlsRef.current.stopLoad()
      hlsRef.current.detachMedia()
      hlsRef.current.destroy()
      hlsRef.current = null
    }

    const syncNativeTextTracks = () => {
      if (isDisposed || !video.textTracks) return
      const raw = Array.from(video.textTracks)
      if (raw.length === 0) return
      const tracks: MediaTrackItem[] = raw.map((t, idx) => ({
        id: idx,
        name: t.label || t.language || `Track ${idx + 1}`,
        lang: t.language,
        type: t.kind,
      }))
      setSubtitleTracks(tracks)

      const subEnabled = localStorage.getItem('sl_subtitles_enabled') === 'true'
      const prefLang = localStorage.getItem('sl_subtitles_lang')
      let activeIdx = -1

      raw.forEach((t, i) => {
        if (
          subEnabled &&
          ((prefLang &&
            (t.language?.toLowerCase() === prefLang.toLowerCase() ||
              t.label.toLowerCase().includes(prefLang.toLowerCase()))) ||
            (!prefLang && i === 0))
        ) {
          t.mode = 'showing'
          activeIdx = i
        } else {
          t.mode = 'disabled'
        }
      })
      setActiveSubtitleTrack(activeIdx)
    }

    if (Hls.isSupported()) {
      const isLowLatency = localStorage.getItem('sl_low_latency') !== 'false'
      const hls = new Hls({
        // Worker spawn costs 100-300ms on low-end TVs; the parse work is tiny here.
        enableWorker: false,
        lowLatencyMode: isLowLatency,
        backBufferLength: 15,
        maxBufferLength: 20,
        maxMaxBufferLength: 30,
        maxBufferSize: 20 * 1024 * 1024,
        maxBufferHole: 0.5,
        highBufferWatchdogPeriod: 2,
        nudgeOffset: 0.1,
        nudgeMaxRetry: 3,
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 4,
        startFragPrefetch: true,
        startLevel: -1,
        abrEwmaDefaultEstimate: 5_000_000,
        // Start on the highest level so a good connection never ramps up from 360p.
        testBandwidth: false,
        manifestLoadingTimeOut: 10000,
        manifestLoadingMaxRetry: 2,
        manifestLoadingRetryDelay: 500,
        levelLoadingTimeOut: 10000,
        fragLoadingTimeOut: 12000,
        fragLoadingMaxRetry: 2,
        fragLoadingRetryDelay: 500,
        renderTextTracksNatively: true,
        enableCEA708Captions: true,
        xhrSetup: (xhr: XMLHttpRequest) => {
          xhr.addEventListener('readystatechange', () => {
            // Guard against HTML payloads (e.g. SPA index.html returned by unconfigured proxy)
            if (xhr.readyState === 4 && xhr.status === 200) {
              const ct = (xhr.getResponseHeader('Content-Type') || '').toLowerCase()
              if (ct.includes('text/html')) {
                xhr.abort()
              }
              const resolvedStream = xhr.getResponseHeader('X-Stream-Resolved')
              if (resolvedStream && resolvedStream !== rawUrl) {
                const resolved = channelStreamsRef.current.find((s) => s.url === resolvedStream)
                cacheWorkingStream(channel.id, resolvedStream, true, resolved?.quality)
                const matchIdx = channelStreamsRef.current.findIndex((s) => s.url === resolvedStream)
                if (matchIdx >= 0) {
                  activeStreamIdxRef.current = matchIdx
                }
              }
            }
          })
        },
      })

      const onSubtitleTracksUpdated = () => {
        if (isDisposed) return
        const h = hlsRef.current
        if (!h) return
        const rawTracks = h.subtitleTracks || []
        const tracks: MediaTrackItem[] = rawTracks.map((t, idx) => ({
          id: idx,
          name: t.name || t.lang || `Track ${idx + 1}`,
          lang: t.lang,
          type: t.type,
        }))
        setSubtitleTracks(tracks)

        const subEnabled = localStorage.getItem('sl_subtitles_enabled') === 'true'
        const prefLang = localStorage.getItem('sl_subtitles_lang')

        if (tracks.length > 0 && subEnabled) {
          let matchIdx = 0
          if (prefLang) {
            const found = tracks.findIndex(
              (t) =>
                (t.lang && t.lang.toLowerCase() === prefLang.toLowerCase()) ||
                (t.name && t.name.toLowerCase().includes(prefLang.toLowerCase()))
            )
            if (found >= 0) matchIdx = found
          }
          h.subtitleTrack = matchIdx
          h.subtitleDisplay = true
          setActiveSubtitleTrack(matchIdx)
        } else if (!subEnabled || tracks.length === 0) {
          h.subtitleTrack = -1
          h.subtitleDisplay = false
          setActiveSubtitleTrack(-1)
        } else {
          setActiveSubtitleTrack(h.subtitleTrack)
        }
      }

      const onAudioTracksUpdated = () => {
        if (isDisposed) return
        const h = hlsRef.current
        if (!h) return
        const rawTracks = h.audioTracks || []
        const tracks: MediaTrackItem[] = rawTracks.map((t, idx) => ({
          id: idx,
          name: t.name || t.lang || `Audio ${idx + 1}`,
          lang: t.lang,
        }))
        setAudioTracks(tracks)

        const prefLang = localStorage.getItem('sl_audio_lang')
        if (tracks.length > 1 && prefLang) {
          const found = tracks.findIndex(
            (t) =>
              (t.lang && t.lang.toLowerCase() === prefLang.toLowerCase()) ||
              (t.name && t.name.toLowerCase().includes(prefLang.toLowerCase()))
          )
          if (found >= 0 && h.audioTrack !== found) {
            h.audioTrack = found
            setActiveAudioTrack(found)
          } else {
            setActiveAudioTrack(h.audioTrack)
          }
        } else {
          setActiveAudioTrack(h.audioTrack)
        }
      }

      hls.loadSource(targetUrl)
      hls.attachMedia(video)

      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, onSubtitleTracksUpdated)
      hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, (_, data) => {
        if (!isDisposed) {
          setActiveSubtitleTrack(data.id)
        }
      })
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, onAudioTracksUpdated)
      hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_, data) => {
        if (!isDisposed) {
          setActiveAudioTrack(data.id)
        }
      })

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        onSubtitleTracksUpdated()
        onAudioTracksUpdated()
        video.play().catch(() => {
          setIsPlaying(false)
        })
      })

      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        onPlaybackSuccess()
      })

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (isDisposed) return
        if (data.fatal) {
          if (failoverTimer.current) {
            window.clearTimeout(failoverTimer.current)
            failoverTimer.current = null
          }
          switch (data.type) {
            case Hls.ErrorTypes.MEDIA_ERROR:
              if (mediaRecoveryAttempts.current < 1) {
                mediaRecoveryAttempts.current++
                hls.recoverMediaError()
              } else {
                failoverToNextAttemptRef.current(classifyHlsError(data))
              }
              break
            case Hls.ErrorTypes.NETWORK_ERROR:
            default:
              failoverToNextAttemptRef.current(classifyHlsError(data))
              break
          }
        }
      })

      hlsRef.current = hls
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = targetUrl
      video.onloadedmetadata = () => {
        syncNativeTextTracks()
        video.play().catch(() => setIsPlaying(false))
      }
      video.onplaying = () => {
        onPlaybackSuccess()
        setIsPlaying(true)
      }
      video.textTracks?.addEventListener?.('addtrack', syncNativeTextTracks)
      video.textTracks?.addEventListener?.('change', syncNativeTextTracks)
      video.onerror = () => {
        if (!isDisposed) {
          if (failoverTimer.current) {
            window.clearTimeout(failoverTimer.current)
            failoverTimer.current = null
          }
          failoverToNextAttemptRef.current(classifyMediaElementError(video.error?.code))
        }
      }
    }

    addRecent(channel.id)
    sessionStorage.setItem('sl_last_viewed', channel.id)

    return () => {
      isDisposed = true
      if (failoverTimer.current) {
        window.clearTimeout(failoverTimer.current)
        failoverTimer.current = null
      }
      if (connectionTimeoutTimer.current) {
        window.clearTimeout(connectionTimeoutTimer.current)
        connectionTimeoutTimer.current = null
      }
      if (stallTimer.current) {
        window.clearTimeout(stallTimer.current)
        stallTimer.current = null
      }
      if (hlsRef.current) {
        hlsRef.current.stopLoad()
        hlsRef.current.detachMedia()
        hlsRef.current.destroy()
        hlsRef.current = null
      }
      video.textTracks?.removeEventListener?.('addtrack', syncNativeTextTracks)
      video.textTracks?.removeEventListener?.('change', syncNativeTextTracks)
      video.onloadedmetadata = null
      video.onplaying = null
      video.onerror = null
    }
  }, [channel.id, activeStreamIdx, isProxied, retryNonce, channelStreams, channel.stream, addRecent])

  // Keybindings: attached once with stable ref to guarantee zero dropped key events
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => {})

  const onKey = useCallback((e: KeyboardEvent) => {
    const targetTag = (e.target as HTMLElement)?.tagName
    if (targetTag === 'INPUT' || targetTag === 'TEXTAREA' || targetTag === 'SELECT') return

    handleMouseMove()

    if (showSubtitleMenu || showAudioMenu) {
      if (e.key === 'Escape' || e.key === 'Backspace') {
        e.preventDefault()
        setShowSubtitleMenu(false)
        setShowAudioMenu(false)
        return
      }
    }

    if (showChannelList) {
      if (e.key === 'Escape' || e.key === 'Backspace') {
        e.preventDefault()
        setShowChannelList(false)
        return
      }
      // Don't hijack vertical arrows when browsing the channel list drawer
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        return
      }
    }

    if (
      e.key === 'ArrowLeft' ||
      e.key === 'ArrowUp' ||
      e.key === '[' ||
      e.key === 'p' ||
      e.key === 'P' ||
      e.key === 'ChannelDown' ||
      e.key === 'PageUp' ||
      e.key === 'MediaTrackPrevious'
    ) {
      e.preventDefault()
      goToPrevChannel()
    } else if (
      e.key === 'ArrowRight' ||
      e.key === 'ArrowDown' ||
      e.key === ']' ||
      e.key === 'n' ||
      e.key === 'N' ||
      e.key === 'ChannelUp' ||
      e.key === 'PageDown' ||
      e.key === 'MediaTrackNext'
    ) {
      e.preventDefault()
      goToNextChannel()
    } else if (e.key === 'Escape' || e.key === 'Backspace') {
      e.preventDefault()
      handleBack()
    } else if (e.key === ' ') {
      e.preventDefault()
      togglePlayPause()
    } else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault()
      toggleFullscreen()
    } else if (e.key === 'm' || e.key === 'M') {
      e.preventDefault()
      toggleMute()
    } else if (e.key === 'c' || e.key === 'C' || e.key === 's' || e.key === 'S') {
      e.preventDefault()
      toggleSubtitles()
    } else if (e.key === 'a' || e.key === 'A') {
      e.preventDefault()
      cycleAudioTracks()
    }
  }, [
    showChannelList,
    showSubtitleMenu,
    showAudioMenu,
    handleMouseMove,
    goToPrevChannel,
    goToNextChannel,
    handleBack,
    togglePlayPause,
    toggleFullscreen,
    toggleMute,
    toggleSubtitles,
    cycleAudioTracks,
  ])

  useEffect(() => {
    onKeyRef.current = onKey
  }, [onKey])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      onKeyRef.current(e)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const [currentTimestamp] = useState(() => Date.now())
  const nowPlaying = useMemo(() => getCurrentProgram(programs, currentTimestamp), [programs, currentTimestamp])
  const nextProgram = useMemo(
    () => programs.find((p) => new Date(p.start_time).getTime() > currentTimestamp),
    [programs, currentTimestamp]
  )
  const fav = isFavourite(channel.id)

  return (
    <div
      className={`player ${isHudVisible ? 'player--hud-visible' : ''} ${isFullscreen ? 'player--fullscreen' : ''}`}
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onTouchStart={handleMouseMove}
    >
      <video
        ref={videoRef}
        className="player__video"
        autoPlay
        playsInline
        onWaiting={() => {
          setIsBuffering(true)
          if (hasPlayedSuccessfully.current && !stallTimer.current) {
            stallTimer.current = window.setTimeout(() => {
              stallTimer.current = null
              failoverToNextAttemptRef.current('inconclusive')
            }, 8000)
          }
        }}
        onPlaying={() => {
          if (stallTimer.current) {
            window.clearTimeout(stallTimer.current)
            stallTimer.current = null
          }
          if (failoverTimer.current) {
            window.clearTimeout(failoverTimer.current)
            failoverTimer.current = null
          }
          if (connectionTimeoutTimer.current) {
            window.clearTimeout(connectionTimeoutTimer.current)
            connectionTimeoutTimer.current = null
          }
          hasPlayedSuccessfully.current = true
          sessionStorage.removeItem('sl_autoskip_start')
          setIsBuffering(false)
          setIsSlowConnecting(false)
          setHasError(false)
          failureEvidenceRef.current = null
          setIsPlaying(true)
          unmarkStreamBroken(channel.id)
          const curStream = channelStreams[activeStreamIdx] || channel.stream
          if (curStream?.url) {
            cacheWorkingStream(channel.id, curStream.url, isProxied, curStream.quality)
          }
        }}
        onClick={() => setShowHud((v) => !v)}
      />

      {/* Buffering Indicator */}
      {isBuffering && !hasError && (
        <div className="player__state-overlay player__state-overlay--connecting">
          <FixerBotMascot accessory={occasionAccessory} />
          <div className="player__connecting-content">
            <p className="player__connecting-title">
              {isSlowConnecting ? 'Stream is slow to respond' : `Connecting to ${channel.name}…`}
            </p>
            {isSlowConnecting && (
              <p className="player__connecting-sub">This stream might be experiencing high latency.</p>
            )}
          </div>
          <div className="player__connecting-actions">
            {nextChannel && (
              <button
                className="player__overlay-btn player__overlay-btn--skip"
                onClick={goToNextChannel}
                aria-label="Skip to next channel"
              >
                Skip Channel ⏭
              </button>
            )}
            {channelStreams.length > 1 && (
              <button
                className="player__overlay-btn"
                onClick={handleNextStreamCandidate}
                aria-label="Try alternate stream candidate"
              >
                Alternate Stream ↻
              </button>
            )}
            {streamUrl && isSlowConnecting && (
              <button
                className="player__overlay-btn player__overlay-btn--retry"
                onClick={handleRetry}
                aria-label="Retry connection"
              >
                Retry ↺
              </button>
            )}
            {isSlowConnecting && (
              <button
                className="player__overlay-btn"
                onClick={handleHideChannel}
                aria-label="Hide this channel"
              >
                Hide Channel 🚫
              </button>
            )}
            <button
              className="player__overlay-btn player__overlay-btn--back"
              onClick={handleBack}
              aria-label="Back to channels"
            >
              ← Back
            </button>
          </div>
        </div>
      )}

      {/* Toast message */}
      {toastMessage && (
        <div className="player__toast">
          <span>⚡</span>
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Error Overlay */}
      {hasError && (
        <div className="player__state-overlay player__state-overlay--error">
          <div className="player__connecting-content">
            <p className="player__connecting-title">⚠️ Stream Unavailable</p>
            <p className="player__connecting-sub">
              {networkIssue
                ? 'Your connection appears to be down, so this channel has not been marked unavailable. Retry once you are back online.'
                : channelStreams.length > 1
                ? `Tried all ${channelStreams.length} stream candidates directly and via edge proxy.`
                : isProxied
                ? 'Unable to connect directly or via edge proxy.'
                : 'Direct stream connection could not be established.'}
            </p>
            {autoSkipCountdown !== null && (
              <p className="player__error-countdown">
                Auto-advancing to next channel…{' '}
                <button
                  className="player__countdown-cancel"
                  onClick={cancelCountdown}
                  type="button"
                >
                  Cancel
                </button>
              </p>
            )}
          </div>
          <div className="player__connecting-actions">
            <button
              className="player__overlay-btn player__overlay-btn--retry"
              onClick={handleRetry}
            >
              Retry ↺
            </button>
            {channelStreams.length > 1 && (
              <button
                className="player__overlay-btn"
                onClick={handleNextStreamCandidate}
              >
                Alternate Stream ({activeStreamIdx + 1}/{channelStreams.length})
              </button>
            )}
            <button
              className="player__overlay-btn"
              onClick={handleHideChannel}
              aria-label="Hide this channel"
            >
              Hide Channel 🚫
            </button>
            {nextChannel && (
              <button
                className="player__overlay-btn player__overlay-btn--skip"
                onClick={goToNextChannel}
              >
                Next Channel ⏭
              </button>
            )}
            <button
              className="player__overlay-btn player__overlay-btn--back"
              onClick={() => {
                cancelCountdown()
                handleBack()
              }}
            >
              ← Back
            </button>
          </div>
        </div>
      )}

      {/* Top HUD */}
      <div className="player__hud player__hud--top">
        <button className="player__back" onClick={handleBack} aria-label="Go back">
          ← Back
        </button>

        <div className="player__info">
          {logoUrl(channel.logo) && (
            <img
              src={logoUrl(channel.logo)!}
              alt={channel.name}
              width={LOGO_SIZE}
              height={LOGO_SIZE}
              decoding="async"
              onError={handleLogoError}
              className="player__logo"
            />
          )}
          <div className="player__info-text">
            <p className="player__name">{channel.name}</p>
            {nowPlaying && (
              <p className="player__now">
                <span className="live-dot" style={{ marginRight: 6 }} />
                {nowPlaying.title}
              </p>
            )}
            {nextProgram && (
              <p className="player__next">Next: {nextProgram.title}</p>
            )}
          </div>
        </div>

        <div className="player__top-actions">
          {channelStreams.length > 1 && (
            <button
              className="player__stream-badge-btn"
              onClick={handleNextStreamCandidate}
              title={`Candidate ${activeStreamIdx + 1} of ${channelStreams.length} · Click to cycle`}
              aria-label="Switch stream candidate"
            >
              <span>Candidate {activeStreamIdx + 1}/{channelStreams.length}</span>
            </button>
          )}
          <button
            className="player__action-btn"
            onClick={() => setShowChannelList((v) => !v)}
            title="Channels"
            aria-label="Toggle channel drawer"
          >
            ☰
          </button>
          <button
            className={`player__fav-btn ${fav ? 'player__fav-btn--active' : ''}`}
            onClick={() => toggle(channel.id)}
            aria-label={fav ? 'Remove from favourites' : 'Add to favourites'}
          >
            {fav ? '♥' : '♡'}
          </button>
          <button
            className="player__fav-btn"
            onClick={handleHideChannel}
            aria-label="Hide this channel"
            title="Hide this channel (restore in Settings)"
          >
            🚫
          </button>
        </div>
      </div>

      {/* Bottom HUD */}
      <div className="player__hud player__hud--bottom">
        <div className="player__bottom-layout">
          {/* Channel cycling controls */}
          <div className="player__ch-nav">
            <button
              className="player__ch-btn"
              onClick={goToPrevChannel}
              disabled={allChannels.length <= 1}
              aria-label="Previous channel"
            >
              ◀ <span className="player__ch-label">{prevChannel?.name ?? '—'}</span>
            </button>

            <div className="player__ch-center">
              <span className="player__ch-number">
                CH {channelIdx >= 0 ? channelIdx + 1 : 1} of {allChannels.length}
              </span>
            </div>

            <button
              className="player__ch-btn"
              onClick={goToNextChannel}
              disabled={allChannels.length <= 1}
              aria-label="Next channel"
            >
              <span className="player__ch-label">{nextChannel?.name ?? '—'}</span> ▶
            </button>
          </div>

          {/* Media actions */}
          <div className="player__playback-nav">
            <div className="player__playback-left">
              <button
                className="player__action-btn"
                onClick={togglePlayPause}
                aria-label={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying ? '⏸' : '▶'}
              </button>
              <button
                className="player__action-btn"
                onClick={toggleMute}
                aria-label={isMuted ? 'Unmute' : 'Mute'}
              >
                {isMuted ? '🔇' : '🔊'}
              </button>
            </div>

            <div className="player__playback-right">
              {/* Audio Tracks Popover */}
              <div className="player__menu-wrapper" ref={audioMenuRef}>
                <button
                  className={`player__action-btn ${showAudioMenu ? 'player__action-btn--open' : ''} ${audioTracks.length > 1 ? 'player__action-btn--available' : ''}`}
                  onClick={() => {
                    resetHudTimer()
                    if (audioTracks.length <= 1) {
                      showToast(audioTracks.length === 1 ? `Audio: ${audioTracks[0]?.name || 'Standard'}` : 'Default audio track')
                      return
                    }
                    setShowAudioMenu((v) => !v)
                    setShowSubtitleMenu(false)
                  }}
                  title={audioTracks.length > 1 ? `Audio Streams (${audioTracks.length}) [A]` : 'Audio (Standard)'}
                  aria-label="Audio stream tracks"
                  aria-expanded={showAudioMenu}
                >
                  <span className="player__btn-icon">🎧</span>
                  {audioTracks.length > 1 && (
                    <span className="player__track-count-badge">{audioTracks.length}</span>
                  )}
                </button>

                {showAudioMenu && audioTracks.length > 0 && (
                  <div className="player__track-popover glass" role="menu">
                    <div className="player__track-popover-title">
                      <span>Audio Streams</span>
                      <span className="player__track-popover-count">{audioTracks.length} tracks</span>
                    </div>
                    <div className="player__track-list">
                      {audioTracks.map((track) => (
                        <button
                          key={track.id}
                          className={`player__track-item ${track.id === activeAudioTrack ? 'player__track-item--active' : ''}`}
                          onClick={() => {
                            selectAudioTrack(track.id)
                            setShowAudioMenu(false)
                            resetHudTimer()
                          }}
                          role="menuitem"
                        >
                          <span className="player__track-check">{track.id === activeAudioTrack ? '✓' : ''}</span>
                          <span className="player__track-name">{track.name}</span>
                          {track.lang && <span className="player__track-badge">{track.lang.toUpperCase()}</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Subtitles Popover */}
              <div className="player__menu-wrapper" ref={subtitleMenuRef}>
                <button
                  className={`player__action-btn ${activeSubtitleTrack >= 0 ? 'player__action-btn--active' : ''} ${showSubtitleMenu ? 'player__action-btn--open' : ''} ${subtitleTracks.length === 0 ? 'player__action-btn--disabled' : ''}`}
                  onClick={() => {
                    resetHudTimer()
                    if (subtitleTracks.length === 0) {
                      showToast('No subtitles available for this stream')
                      return
                    }
                    setShowSubtitleMenu((v) => !v)
                    setShowAudioMenu(false)
                  }}
                  title={subtitleTracks.length > 0 ? `Subtitles [C] (${subtitleTracks.length} available)` : 'No subtitles available'}
                  aria-label="Subtitles & Closed Captions"
                  aria-expanded={showSubtitleMenu}
                >
                  <span className="player__cc-text">CC</span>
                  {subtitleTracks.length > 0 && (
                    <span className="player__track-count-badge">{subtitleTracks.length}</span>
                  )}
                </button>

                {showSubtitleMenu && subtitleTracks.length > 0 && (
                  <div className="player__track-popover glass" role="menu">
                    <div className="player__track-popover-title">
                      <span>Subtitles & Captions</span>
                      <span className="player__track-popover-count">{subtitleTracks.length} tracks</span>
                    </div>
                    <div className="player__track-list">
                      <button
                        className={`player__track-item ${activeSubtitleTrack === -1 ? 'player__track-item--active' : ''}`}
                        onClick={() => {
                          selectSubtitleTrack(-1)
                          setShowSubtitleMenu(false)
                          resetHudTimer()
                        }}
                        role="menuitem"
                      >
                        <span className="player__track-check">{activeSubtitleTrack === -1 ? '✓' : ''}</span>
                        <span className="player__track-name">Off</span>
                      </button>
                      {subtitleTracks.map((track) => (
                        <button
                          key={track.id}
                          className={`player__track-item ${track.id === activeSubtitleTrack ? 'player__track-item--active' : ''}`}
                          onClick={() => {
                            selectSubtitleTrack(track.id)
                            setShowSubtitleMenu(false)
                            resetHudTimer()
                          }}
                          role="menuitem"
                        >
                          <span className="player__track-check">{track.id === activeSubtitleTrack ? '✓' : ''}</span>
                          <span className="player__track-name">{track.name}</span>
                          {track.lang && <span className="player__track-badge">{track.lang.toUpperCase()}</span>}
                          {track.type && track.type !== 'SUBTITLES' && (
                            <span className="player__track-type-badge">{track.type}</span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <button
                className="player__action-btn"
                onClick={togglePiP}
                title="Picture-in-Picture"
                aria-label="Picture in Picture"
              >
                ⧉
              </button>
              <button
                className="player__action-btn"
                onClick={toggleFullscreen}
                title="Toggle fullscreen"
                aria-label="Fullscreen"
              >
                {isFullscreen ? '⤓' : '⤢'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Side Channel Switcher Drawer */}
      {showChannelList && (
        <div className="player__drawer glass">
          <div className="player__drawer-header">
            <h3>Playlist Channels ({allChannels.length})</h3>
            <button onClick={() => setShowChannelList(false)} aria-label="Close drawer">✕</button>
          </div>
          <div className="player__drawer-list">
            {allChannels.map((c) => (
              <div
                key={c.id}
                className={`player__drawer-item ${c.id === channel.id ? 'player__drawer-item--active' : ''}`}
                onClick={() => {
                  setShowChannelList(false)
                  targetChannelIdRef.current = c.id
                  switchChannelCleanly(c)
                }}
              >
                {logoUrl(c.logo) ? (
                  <img
                    src={logoUrl(c.logo)!}
                    alt={c.name}
                    width={LOGO_SIZE}
                    height={LOGO_SIZE}
                    loading="lazy"
                    decoding="async"
                    onError={handleLogoError}
                    className="player__drawer-logo"
                  />
                ) : (
                  <div className="player__drawer-initials">{c.name.slice(0, 2).toUpperCase()}</div>
                )}
                <span className="player__drawer-name">{c.name}</span>
                {c.country && <span className="player__drawer-badge">{formatCountryDisplay(c.country)}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Controls hint */}
      <p className="player__hint">
        ← / → switch channel · Space play/pause · M mute · C subtitles · A audio · F fullscreen · Esc return
      </p>
    </div>
  )
}
