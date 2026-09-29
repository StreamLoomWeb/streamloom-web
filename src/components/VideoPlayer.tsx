import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import Hls, { type PlaylistLoaderConstructor } from 'hls.js'
import type { EnrichedChannel } from '../hooks/useChannels'
import { useEpg, useFavourites, useRecent } from '../hooks/useChannels'
import { useOccasionAccessory } from '../api/occasion'
import { FixerBotMascot } from './FixerBotMascot'
import { getCurrentProgram, getNextProgram, programProgress } from '../util/epgNow'
import { LOGO_SIZE, logoUrl, handleLogoError } from '../util/logo'
import { markPlayerLogoForTransition } from '../util/viewTransition'
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
import { beginPlay, endPlay, failPlay, markFirstFrame, stallEnd, stallStart } from '../telemetry/playSession'
import { errorClassOfHls, errorClassOfMedia } from '../telemetry/errorClass'
import type { ErrorClass } from '../../functions/api/_lib/telemetryContract'
import { rememberBandwidth, startingBandwidth } from '../util/bandwidth'
import { preconnectChannel } from '../util/preconnect'
import { HandoffLoader } from '../util/handoffLoader'
import { MANIFEST_TIMEOUT_MS } from '../util/playlistPrefetch'
import { MiniGuideRow } from './MiniGuideRow'
import { useDocumentPip } from '../hooks/useDocumentPip'
import { getTranslation, requestTranslations, useTranslateEnabled } from '../util/translate'
import './VideoPlayer.css'

interface Props {
  channel: EnrichedChannel
  allChannels: EnrichedChannel[]
  returnTo?: string
  /** Channel ids with a published schedule (epg/ids.json). Gates the mini-guide's now/next fetch. */
  epgChannelIds?: Set<string>
}

export interface MediaTrackItem {
  id: number
  name: string
  lang?: string
  type?: string
}

/*
 * Watchdogs judge progress, not elapsed time. A load that receives no media bytes for
 * the idle window is dead and the next attempt is tried, exactly as fast as before; a
 * load whose bytes are still arriving on a slow link is left to finish, up to the cap,
 * instead of being torn down and restarted from zero on another path.
 */
/** Before the first frame: longest without a media byte before trying the next attempt. */
/** Mid-play rebuffer shorter than this never shows the overlay. Watchdogs are unaffected. */
const REBUFFER_GRACE_MS = 600
/** How long the channel banner stays up after a switch. */
const ZAP_BANNER_MS = 2500
const START_IDLE_MS = 7000
/**
 * Before the first frame: longest a slow but moving load may take. Just past hls.js's
 * own fragLoadingTimeOut (12 s, below), beyond which it restarts the fragment anyway.
 */
const START_CAP_MS = 13000
/** After playback: longest a stall may go without a media byte. */
const STALL_IDLE_MS = 8000
/** After playback: longest a stall may last while bytes trickle in. */
const STALL_CAP_MS = 20000

/** Why each candidate of one channel failed, so exhaustion can be judged as a whole. */
interface FailureEvidence {
  channelId: string
  /** Class of the most recent failed attempt, per candidate index. */
  verdicts: Map<number, FailureClass>
}

export function VideoPlayer({ channel, allChannels, returnTo = '/', epgChannelIds }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const videoHostRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const playerLogoRef = useRef<HTMLImageElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const navigate = useNavigate()
  const { programs } = useEpg(channel.id)
  const { isFavourite, toggle } = useFavourites()
  const { addRecent } = useRecent()
  const occasionAccessory = useOccasionAccessory()

  const [isPlaying, setIsPlaying] = useState(true)
  const [isPip, setIsPip] = useState(false)
  const [isMuted, setIsMuted] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [isZoomed, setIsZoomed] = useState(false)
  const [isBuffering, setIsBuffering] = useState(true)
  // Mid-play rebuffers only surface the overlay after REBUFFER_GRACE_MS, so a
  // sub-second hiccup does not flash the mascot. The initial connect is never delayed.
  const [rebufferGrace, setRebufferGrace] = useState(false)
  const rebufferGraceTimer = useRef<number | null>(null)
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

  // Only the mount from a card's click is a view transition's "after" state;
  // switching channels within an already-open player has none in flight.
  useLayoutEffect(() => {
    markPlayerLogoForTransition(playerLogoRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const showConnectOverlay = isBuffering && !rebufferGrace
  const isHudVisible = showHud || showConnectOverlay

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

  // One telemetry play session per channel visit (ADR-0047): `play` names the first stream tried,
  // `play_end` carries the watch-time bucket when the channel is left. Fire-and-forget; nothing
  // here is awaited by playback.
  useEffect(() => {
    // The session itself starts in the attempt effect below, naming the stream actually tried
    // first; leaving the channel is what ends it.
    return () => endPlay()
  }, [channel.id])
  const stallTimer = useRef<number | null>(null)
  const mediaRecoveryAttempts = useRef(0)
  const hasPlayedSuccessfully = useRef(false)
  /** When the last media byte arrived; playlist refreshes do not count. */
  const lastMediaByteAt = useRef(0)
  const switchChannelCleanlyRef = useRef<(target: EnrichedChannel) => void>(() => {})
  const failoverToNextAttemptRef = useRef<(cause: FailureClass, errorClass?: ErrorClass) => void>(() => {})
  const failureEvidenceRef = useRef<FailureEvidence | null>(null)

  /** Tears down the engine, keeping its bandwidth measurement for the next start. */
  const destroyHls = useCallback(() => {
    const hls = hlsRef.current
    if (!hls) return
    // Only while it is actually playing: a teardown after a stall measured one slow
    // origin, not this device's connection.
    const v = videoRef.current
    if (hasPlayedSuccessfully.current && v && !v.paused && v.readyState >= 3) rememberBandwidth(hls.bandwidthEstimate)
    hls.stopLoad()
    hls.detachMedia()
    hls.destroy()
    hlsRef.current = null
  }, [])

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
    setRebufferGrace(false)
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

    // iOS Safari has no element fullscreen at all; it exposes fullscreen
    // only on the <video> itself, natively (own play/pause/scrub HUD, no
    // fullscreenchange event or document.fullscreenElement either — tracked
    // instead by the video's own webkitbeginfullscreen/webkitendfullscreen
    // listeners set up below).
    type IosVideo = HTMLVideoElement & {
      webkitEnterFullscreen?: () => void
      webkitExitFullscreen?: () => void
      webkitDisplayingFullscreen?: boolean
    }
    const video = videoRef.current as IosVideo | null
    if (!container.requestFullscreen && video?.webkitEnterFullscreen) {
      if (video.webkitDisplayingFullscreen) {
        video.webkitExitFullscreen?.()
      } else {
        video.webkitEnterFullscreen()
      }
      return
    }

    if (!document.fullscreenElement) {
      container.requestFullscreen().then(() => {
        setIsFullscreen(true)
        if (hideHudTimer.current) window.clearTimeout(hideHudTimer.current)
        hideHudTimer.current = window.setTimeout(() => {
          setShowHud(false)
        }, 1200)
        const lock = screen.orientation?.lock
        if (lock) lock.call(screen.orientation, 'landscape').catch(() => {})
      }).catch(() => {})
    } else {
      document.exitFullscreen().then(() => {
        setIsFullscreen(false)
        setShowHud(true)
      }).catch(() => {})
    }
  }, [])

  const toggleZoom = useCallback(() => {
    setIsZoomed((v) => !v)
    resetHudTimer()
  }, [resetHudTimer])

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

  // iOS Safari never fires 'fullscreenchange' for webkitEnterFullscreen — it's
  // tracked only through these two events on the <video> itself. Without this,
  // isFullscreen (and the button's icon) never reflects native fullscreen at all.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    function onBegin() {
      setIsFullscreen(true)
    }
    function onEnd() {
      setIsFullscreen(false)
      setShowHud(true)
    }
    video.addEventListener('webkitbeginfullscreen', onBegin)
    video.addEventListener('webkitendfullscreen', onEnd)
    return () => {
      video.removeEventListener('webkitbeginfullscreen', onBegin)
      video.removeEventListener('webkitendfullscreen', onEnd)
    }
  }, [])

  // Native video PiP (togglePiP below): tracks isPip via the real browser events
  // rather than an app-held flag, and closes this video's own PiP session on
  // unmount so a leftover session from a previous VideoPlayer instance can't make
  // togglePiP's identity check below take the wrong branch on the next open.
  useLayoutEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onEnter = () => setIsPip(true)
    const onLeave = () => {
      setIsPip(false)
      // Chrome's native PiP close ("X") pauses the video as part of closing the
      // window — resume right away so returning to the tab is seamless instead
      // of requiring an explicit play click. Its own "back to tab" control never
      // pauses, so this is a no-op there.
      if (video.paused) {
        if (stallTimer.current) {
          window.clearTimeout(stallTimer.current)
          stallTimer.current = null
        }
        video.play().catch(() => {})
      }
      setIsPlaying(true)
    }
    video.addEventListener('enterpictureinpicture', onEnter)
    video.addEventListener('leavepictureinpicture', onLeave)
    return () => {
      video.removeEventListener('enterpictureinpicture', onEnter)
      video.removeEventListener('leavepictureinpicture', onLeave)
      if (document.pictureInPictureElement === video) {
        document.exitPictureInPicture().catch(() => {})
      }
    }
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
      if (document.pictureInPictureElement === v) {
        await document.exitPictureInPicture()
      } else if (document.pictureInPictureEnabled) {
        await v.requestPictureInPicture()
      }
    } catch {
      // ignore
    }
    resetHudTimer()
  }, [resetHudTimer])

  // B9: Document PiP mini-player (desktop Chrome/Edge only — the hook feature-detects
  // and `docPipSupported` stays false everywhere else, so the toggle button below never
  // renders on phone, TV or Safari). Unlike the native video-PiP button above, this
  // opens a real window we control, so it can carry zap buttons instead of just
  // play/pause. Moves the actual <video> node into that window rather than mounting a
  // second one, so playback (buffer, currentTime, the attached hls.js instance)
  // survives the move.
  const restoreVideoInPlace = useCallback(() => {
    const video = videoRef.current
    const host = videoHostRef.current
    if (!video || !host) return
    video.style.width = ''
    video.style.height = ''
    video.style.objectFit = ''
    video.style.display = ''
    // Reinsert as host's next sibling — its original JSX position — rather than
    // into host itself: React still thinks of video as a sibling of host, not a
    // child of it, and an `appendChild` into host here would leave that fiber
    // pointing at a DOM node video is no longer directly under, which throws on
    // the next unmount (removeChild on a node that isn't there any more).
    host.insertAdjacentElement('afterend', video)
  }, [])

  const { isSupported: docPipSupported, pipWindow, open: openDocPip, close: closeDocPip } = useDocumentPip(restoreVideoInPlace)

  // Runs the move-in when a window opens (and, redundantly but harmlessly, the
  // move-back on close/unmount — the real move-back already happened synchronously in
  // useDocumentPip's close() or pagehide handler, via restoreVideoInPlace, so a
  // browsing-context teardown never races a React effect for playback state; this
  // cleanup just keeps the DOM tidy for paths that go through neither, like a
  // StrictMode double-invoke).
  useEffect(() => {
    if (!pipWindow) return
    const video = videoRef.current
    if (!video) return
    try {
      pipWindow.document.body.appendChild(video)
    } catch (err) {
      // The window `open()` handed back wasn't actually usable (e.g. its document
      // was already on its way out) — nothing to reparent into, so leave the video
      // where it is rather than throwing out of a passive effect. Logged rather
      // than swallowed: if this is where the mini-player is actually failing,
      // this is the one place that would know why.
      console.error('[document-pip] could not move the video into the mini-player window', err)
      return
    }
    video.style.width = '100%'
    video.style.height = 'calc(100% - 44px)'
    video.style.objectFit = 'contain'
    video.style.display = 'block'
    return restoreVideoInPlace
  }, [pipWindow, restoreVideoInPlace])

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
    destroyHls()
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
  }, [returnTo, navigate, destroyHls])

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
    destroyHls()
    const video = videoRef.current
    if (video) {
      video.onloadedmetadata = null
      video.onerror = null
      video.pause()
    }
    sessionStorage.setItem('sl_last_viewed', channel.id)
    ;(document.activeElement as HTMLElement)?.blur?.()
    // Close the mini-player (a no-op when none is open). closeDocPip() moves the
    // <video> back into this document and clears the hook's state synchronously,
    // before navigate() below unmounts this tree, so nothing depends on the
    // window's own 'pagehide' arriving first. It reads the hook's ref, not the
    // `pipWindow` render value, so a stale closure can't skip it.
    closeDocPip()
    navigate(returnTo, { state: { targetChannelId: channel.id } })
  }, [cancelCountdown, channel.id, returnTo, navigate, destroyHls, closeDocPip])

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
   * Once this channel plays, opens connections to the channels either side of it, so
   * zapping to one skips DNS, TCP and TLS. This replaced a manifest fetch that warmed
   * nothing: live playlists are not cacheable, and a proxied one cost a Function
   * invocation and competed with the current channel's own start.
   */
  useEffect(() => {
    if (isBuffering || allChannels.length <= 1) return
    const idx = allChannels.findIndex((c) => c.id === channel.id)
    if (idx < 0) return
    for (const step of [1, -1]) {
      const neighbour = allChannels[(idx + step + allChannels.length) % allChannels.length]
      if (neighbour && neighbour.id !== channel.id) preconnectChannel(neighbour)
    }
  }, [channel.id, allChannels, isBuffering])

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

  const failoverToNextAttempt = useCallback((cause: FailureClass, errorClass?: ErrorClass) => {
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

    // Telemetry (ADR-0032): a stream fault is counted once per stream per session; a network
    // failure, a timeout or the watchdog is never reported, since it says nothing about the stream.
    if (cause === 'stream') failPlay(currentChannel.id, curUrl, errorClass ?? 'other')

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
    // No-op while a session for this channel is open, so a proxy retry or the next candidate
    // does not count as a second `play`.
    beginPlay(channel.id, rawUrl)

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

    // Failover watchdog: re-checks until media stops arriving or the cap is reached.
    const attemptStart = performance.now()
    lastMediaByteAt.current = attemptStart
    const checkStart = () => {
      if (isDisposed) return
      const now = performance.now()
      const idle = now - lastMediaByteAt.current
      const left = START_CAP_MS - (now - attemptStart)
      if (idle < START_IDLE_MS && left > 0) {
        failoverTimer.current = window.setTimeout(checkStart, Math.min(START_IDLE_MS - idle, left))
        return
      }
      failoverToNextAttemptRef.current('inconclusive')
    }
    failoverTimer.current = window.setTimeout(checkStart, START_IDLE_MS)

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
      markFirstFrame()
      stallEnd()
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
    destroyHls()

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
        // Start on the level this device's last measured speed sustains, so a good
        // connection never ramps up from 360p and a slow one never starts on 1080p.
        abrEwmaDefaultEstimate: startingBandwidth(),
        testBandwidth: false,
        // The first manifest request takes the playlist fetched when the channel was tapped.
        // hls.js types its default loader for every context; a playlist loader is one.
        pLoader: HandoffLoader as unknown as PlaylistLoaderConstructor,
        manifestLoadingTimeOut: MANIFEST_TIMEOUT_MS,
        manifestLoadingMaxRetry: 2,
        manifestLoadingRetryDelay: 500,
        levelLoadingTimeOut: 10000,
        fragLoadingTimeOut: 12000,
        fragLoadingMaxRetry: 2,
        fragLoadingRetryDelay: 500,
        renderTextTracksNatively: true,
        enableCEA708Captions: true,
        xhrSetup: (xhr: XMLHttpRequest) => {
          // Media bytes (not playlists, which keep refreshing on a stuck live stream,
          // nor error bodies) are what tells the watchdogs a slow load is still alive.
          // hls.js loads fragments as arraybuffer and playlists as text, whatever
          // Content-Type the origin sends.
          xhr.addEventListener('progress', () => {
            if (xhr.responseType === 'arraybuffer' && xhr.status >= 200 && xhr.status < 300) {
              lastMediaByteAt.current = performance.now()
            }
          })
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
                failoverToNextAttemptRef.current(classifyHlsError(data), errorClassOfHls(data))
              }
              break
            case Hls.ErrorTypes.NETWORK_ERROR:
            default:
              failoverToNextAttemptRef.current(classifyHlsError(data), errorClassOfHls(data))
              break
          }
        }
      })

      hlsRef.current = hls
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = targetUrl
      // Native HLS (Safari) has no loader hook. Its progress event can fire for playlist
      // polling too, so only a buffer that actually grew counts as media arriving.
      let bufferedEnd = 0
      video.onprogress = () => {
        const b = video.buffered
        const end = b.length > 0 ? b.end(b.length - 1) : 0
        if (end > bufferedEnd) {
          bufferedEnd = end
          lastMediaByteAt.current = performance.now()
        }
      }
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
          failoverToNextAttemptRef.current(classifyMediaElementError(video.error?.code), errorClassOfMedia(video.error?.code))
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
      destroyHls()
      video.textTracks?.removeEventListener?.('addtrack', syncNativeTextTracks)
      video.textTracks?.removeEventListener?.('change', syncNativeTextTracks)
      video.onloadedmetadata = null
      video.onplaying = null
      video.onerror = null
      video.onprogress = null
    }
  }, [channel.id, activeStreamIdx, isProxied, retryNonce, channelStreams, channel.stream, addRecent, destroyHls])

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
      // Don't hijack any arrow key when browsing the channel list drawer —
      // it's the drawer's own list to navigate, not the HUD's.
      if (
        e.key === 'ArrowUp' ||
        e.key === 'ArrowDown' ||
        e.key === 'ArrowLeft' ||
        e.key === 'ArrowRight'
      ) {
        return
      }
    }

    // TV remote model: with the HUD hidden, up/down are a dedicated channel-zap
    // D-pad; with it showing, all four arrows move focus between HUD controls
    // instead, so the controls are reachable at all.
    const isArrowKey =
      e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight'
    const hudControls = () =>
      Array.from(
        containerRef.current?.querySelectorAll<HTMLElement>(
          '.player__hud button, .player__hud [tabindex]:not([tabindex="-1"])'
        ) ?? []
      ).filter((el) => el.offsetParent !== null)

    // Arrows drive the HUD only once focus is actually inside it, or on
    // Left/Right (which reveal and enter it). The HUD also shows while merely
    // buffering after a zap; Up/Down must keep zapping through that, or a
    // second flip would move focus instead of changing channel.
    const focusInHud = hudControls().includes(document.activeElement as HTMLElement)
    const hudOwnsArrow = focusInHud || (isHudVisible && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'))
    if (isHudVisible && isArrowKey && hudOwnsArrow) {
      e.preventDefault()
      const controls = hudControls()
      if (controls.length) {
        const delta = e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 1
        const current = controls.indexOf(document.activeElement as HTMLElement)
        const next = current === -1 ? (delta === 1 ? 0 : controls.length - 1) : (current + delta + controls.length) % controls.length
        controls[next].focus()
      }
      return
    }

    if (
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
      // A focused HUD button owns Space itself (native activation); only
      // treat it as play/pause when nothing in the HUD has focus.
      if (isHudVisible && hudControls().includes(document.activeElement as HTMLElement)) return
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
    } else if (e.key === 'g' || e.key === 'G') {
      e.preventDefault()
      setShowChannelList((v) => !v)
    }
  }, [
    showChannelList,
    showSubtitleMenu,
    showAudioMenu,
    isHudVisible,
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

  const [currentTimestamp, setCurrentTimestamp] = useState(() => Date.now())
  useEffect(() => {
    const tick = () => setCurrentTimestamp(Date.now())
    tick()
    const id = window.setInterval(tick, 30_000)
    return () => window.clearInterval(id)
  }, [channel.id])
  const nowPlaying = useMemo(() => getCurrentProgram(programs, currentTimestamp), [programs, currentTimestamp])
  const nextProgram = useMemo(() => getNextProgram(programs, currentTimestamp), [programs, currentTimestamp])
  const fav = isFavourite(channel.id)

  const translateEpg = useTranslateEnabled()
  useEffect(() => {
    if (!translateEpg) return
    const titles = [nowPlaying?.title, nextProgram?.title].filter((t): t is string => !!t)
    if (titles.length > 0) requestTranslations(titles)
  }, [translateEpg, nowPlaying, nextProgram])
  const nowPlayingTitle = nowPlaying
    ? (translateEpg && getTranslation(nowPlaying.title)) || nowPlaying.title
    : null
  const nextProgramTitle = nextProgram
    ? (translateEpg && getTranslation(nextProgram.title)) || nextProgram.title
    : null

  // Zap banner: shown for ZAP_BANNER_MS after every channel switch. Derived
  // from "which channel has finished its banner" so no state is set
  // synchronously in the effect; pointer-events are off, so it never takes
  // focus or keys.
  const [zapDoneFor, setZapDoneFor] = useState<string | null>(null)
  useEffect(() => {
    const id = window.setTimeout(() => setZapDoneFor(channel.id), ZAP_BANNER_MS)
    return () => window.clearTimeout(id)
  }, [channel.id])
  useEffect(() => () => {
    if (rebufferGraceTimer.current !== null) window.clearTimeout(rebufferGraceTimer.current)
  }, [])
  const showZapBanner = zapDoneFor !== channel.id
  const nowProgress = nowPlaying ? programProgress(nowPlaying, currentTimestamp) : null

  // Mini-guide row order (S3): the playing channel first, then the rest of the
  // playlist in their existing order, wrapping around.
  const guideChannels = useMemo(() => {
    const idx = allChannels.findIndex((c) => c.id === channel.id)
    if (idx <= 0) return allChannels
    return [...allChannels.slice(idx), ...allChannels.slice(0, idx)]
  }, [allChannels, channel.id])

  const handleGuidePick = useCallback(
    (picked: EnrichedChannel) => {
      setShowChannelList(false)
      targetChannelIdRef.current = picked.id
      switchChannelCleanly(picked)
    },
    [switchChannelCleanly],
  )

  // Lock-screen, hardware-key and PiP transport controls. previous/next map
  // to zapping, same as the keyboard shortcuts.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const artwork = logoUrl(channel.logo)
    navigator.mediaSession.metadata = new MediaMetadata({
      title: channel.name,
      artist: nowPlaying?.title ?? '',
      artwork: artwork ? [{ src: artwork, sizes: `${LOGO_SIZE}x${LOGO_SIZE}`, type: 'image/webp' }] : [],
    })
    navigator.mediaSession.setActionHandler('play', togglePlayPause)
    navigator.mediaSession.setActionHandler('pause', togglePlayPause)
    navigator.mediaSession.setActionHandler('previoustrack', goToPrevChannel)
    navigator.mediaSession.setActionHandler('nexttrack', goToNextChannel)
    return () => {
      navigator.mediaSession.setActionHandler('play', null)
      navigator.mediaSession.setActionHandler('pause', null)
      navigator.mediaSession.setActionHandler('previoustrack', null)
      navigator.mediaSession.setActionHandler('nexttrack', null)
    }
  }, [channel.id, channel.name, channel.logo, nowPlaying?.title, togglePlayPause, goToPrevChannel, goToNextChannel])

  useEffect(() => {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused'
  }, [isPlaying])

  return (
    <div
      className={`player ${isHudVisible ? 'player--hud-visible' : ''} ${isFullscreen ? 'player--fullscreen' : ''}`}
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onTouchStart={handleMouseMove}
    >
      <div className="player__video-host" ref={videoHostRef} />
      <video
        ref={videoRef}
        className={`player__video${isZoomed ? ' player__video--zoomed' : ''}`}
        autoPlay
        playsInline
        onWaiting={(e) => {
          if (e.currentTarget.paused) return
          setIsBuffering(true)
          if (hasPlayedSuccessfully.current && rebufferGraceTimer.current === null) {
            setRebufferGrace(true)
            rebufferGraceTimer.current = window.setTimeout(() => {
              rebufferGraceTimer.current = null
              setRebufferGrace(false)
            }, REBUFFER_GRACE_MS)
          }
          if (hasPlayedSuccessfully.current) stallStart()
          if (hasPlayedSuccessfully.current && !stallTimer.current) {
            const since = performance.now()
            const checkStall = () => {
              const now = performance.now()
              const idle = now - lastMediaByteAt.current
              const left = STALL_CAP_MS - (now - since)
              if (idle < STALL_IDLE_MS && left > 0) {
                stallTimer.current = window.setTimeout(checkStall, Math.min(STALL_IDLE_MS - idle, left))
                return
              }
              stallTimer.current = null
              failoverToNextAttemptRef.current('inconclusive')
            }
            stallTimer.current = window.setTimeout(checkStall, STALL_IDLE_MS)
          }
        }}
        onPause={() => {
          setIsPlaying(false)
          if (stallTimer.current) {
            window.clearTimeout(stallTimer.current)
            stallTimer.current = null
          }
        }}
        onPlay={() => setIsPlaying(true)}
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
          if (rebufferGraceTimer.current !== null) {
            window.clearTimeout(rebufferGraceTimer.current)
            rebufferGraceTimer.current = null
          }
          setRebufferGrace(false)
          markFirstFrame()
          stallEnd()
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

      {/* B9: the video itself has moved into the Document PiP window; this stands in
          for it here so the main view isn't just a black rectangle with no way back. */}
      {pipWindow && (
        <div className="player__pip-placeholder">
          <p className="player__connecting-title">Playing in mini-player</p>
          <button className="player__overlay-btn" onClick={closeDocPip}>
            Return here
          </button>
        </div>
      )}

      {pipWindow &&
        createPortal(
          <div className="player__pip-controls">
            <button
              onClick={goToPrevChannel}
              disabled={allChannels.length <= 1}
              aria-label="Previous channel"
            >
              ◀
            </button>
            <div className="player__pip-controls-info">
              {logoUrl(channel.logo) && (
                <img src={logoUrl(channel.logo)!} alt="" width={24} height={24} onError={handleLogoError} />
              )}
              <span>{channel.name}</span>
            </div>
            <button onClick={togglePlayPause} aria-label={isPlaying ? 'Pause' : 'Play'}>
              {isPlaying ? '⏸' : '▶'}
            </button>
            <button
              onClick={goToNextChannel}
              disabled={allChannels.length <= 1}
              aria-label="Next channel"
            >
              ▶
            </button>
          </div>,
          pipWindow.document.body
        )}

      {/* Zap banner */}
      {showZapBanner && !hasError && (
        <div className="player__zap" role="status" aria-live="polite" key={channel.id}>
          {logoUrl(channel.logo) && (
            <img
              src={logoUrl(channel.logo)!}
              alt=""
              width={LOGO_SIZE}
              height={LOGO_SIZE}
              decoding="async"
              onError={handleLogoError}
              className="player__zap-logo"
            />
          )}
          <div className="player__zap-text">
            <p className="player__zap-name">{channel.name}</p>
            {nowPlayingTitle && <p className="player__zap-now">{nowPlayingTitle}</p>}
            {nextProgramTitle && <p className="player__zap-next">Next: {nextProgramTitle}</p>}
            {nowProgress !== null && (
              <div className="player__zap-progress" aria-hidden="true">
                <div className="player__zap-progress-fill" style={{ width: `${nowProgress * 100}%` }} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Buffering Indicator */}
      {showConnectOverlay && !hasError && (
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
        <div className="player__toast" role="status" aria-live="polite">
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
            {nextChannel && (
              <button
                className="player__overlay-btn player__overlay-btn--primary"
                onClick={goToNextChannel}
                autoFocus
              >
                Next Channel ⏭
              </button>
            )}
            <button
              className={`player__overlay-btn ${nextChannel ? 'player__overlay-btn--secondary' : 'player__overlay-btn--primary'}`}
              onClick={handleRetry}
              autoFocus={!nextChannel}
            >
              Retry ↺
            </button>
            {channelStreams.length > 1 && (
              <button
                className="player__overlay-btn player__overlay-btn--secondary"
                onClick={handleNextStreamCandidate}
              >
                Alternate Stream ({activeStreamIdx + 1}/{channelStreams.length})
              </button>
            )}
            <button
              className="player__overlay-btn player__overlay-btn--secondary"
              onClick={handleHideChannel}
              aria-label="Hide this channel"
            >
              Hide Channel 🚫
            </button>
            <button
              className="player__overlay-btn player__overlay-btn--secondary"
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
              ref={playerLogoRef}
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
                {nowPlayingTitle}
              </p>
            )}
            {nextProgram && (
              <p className="player__next">Next: {nextProgramTitle}</p>
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
                className={`player__action-btn ${pipWindow ? 'player__action-btn--disabled' : isPip ? 'player__action-btn--active' : ''}`}
                disabled={Boolean(pipWindow)}
                onClick={togglePiP}
                aria-pressed={isPip}
                title={pipWindow ? 'Unavailable while the mini-player is open' : isPip ? 'Exit Picture-in-Picture' : 'Picture-in-Picture'}
                aria-label={isPip ? 'Exit Picture-in-Picture' : 'Picture in Picture'}
              >
                ⧉
              </button>
              {docPipSupported && (
                <button
                  className={`player__action-btn ${pipWindow ? 'player__action-btn--active' : ''}`}
                  onClick={() => {
                    if (pipWindow) {
                      closeDocPip()
                      return
                    }
                    // Called synchronously from the click so requestWindow() still
                    // has this click's transient user activation.
                    openDocPip({ width: 360, height: 220 }).then((win) => {
                      if (!win) showToast('Could not open the mini-player — try again in a moment')
                    }).catch((err: unknown) => {
                      // Failure-path only: the DOMException name (NotAllowedError =
                      // no user activation, InvalidStateError = browser refused the
                      // window) is what a bug report needs.
                      console.warn('[document-pip] requestWindow() rejected', err)
                      showToast('Could not open the mini-player — try again in a moment')
                    })
                  }}
                  title={pipWindow ? 'Close mini-player' : 'Open mini-player with zap controls'}
                  aria-label={pipWindow ? 'Close mini-player' : 'Open mini-player'}
                >
                  🗗
                </button>
              )}
              <button
                className={`player__action-btn ${isZoomed ? 'player__action-btn--active' : ''}`}
                onClick={toggleZoom}
                title={isZoomed ? 'Fit to screen' : 'Zoom to fill screen'}
                aria-label={isZoomed ? 'Fit video to screen' : 'Zoom video to fill screen'}
                aria-pressed={isZoomed}
              >
                {isZoomed ? '⊟' : '⛶'}
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

      {/* Mini-guide (S3): logo, name, now/next per row, starting at the playing channel */}
      {showChannelList && (
        <div className="player__drawer glass">
          <div className="player__drawer-header">
            <h3>Guide ({guideChannels.length})</h3>
            <button onClick={() => setShowChannelList(false)} aria-label="Close guide">✕</button>
          </div>
          <div className="player__drawer-list">
            {guideChannels.map((c) => (
              <MiniGuideRow
                key={c.id}
                channel={c}
                active={c.id === channel.id}
                hasSchedule={epgChannelIds?.has(c.id) ?? false}
                onPick={handleGuidePick}
              />
            ))}
          </div>
        </div>
      )}

      {/* Controls hint */}
      <p className="player__hint">
        ← / → switch channel · G guide · Space play/pause · M mute · C subtitles · A audio · F fullscreen · Esc return
      </p>
    </div>
  )
}
