/**
 * Stream utility helpers for protocol resolution, CORS proxy routing,
 * and broken-stream state management.
 */

import { clearNativeHlsMarks } from './nativeHls'

const BROKEN_STREAMS_KEY = 'sl_broken_streams_v2'
const BROKEN_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

// Invalidate and purge legacy v1 cache to unblock falsely marked channels
try {
  localStorage.removeItem('sl_broken_streams_v1')
} catch {}

/**
 * Marks written before failures were classified (see streamFailure.ts) may have
 * come from the user's own network dropping, so they cannot be trusted. Drop
 * them once; the versioned key stops this from running again, and bumping the
 * version re-runs it if a later change invalidates marks the same way.
 */
const BROKEN_RESET_KEY = 'sl_broken_reset_v1'
try {
  if (!localStorage.getItem(BROKEN_RESET_KEY)) {
    localStorage.removeItem(BROKEN_STREAMS_KEY)
    localStorage.setItem(BROKEN_RESET_KEY, '1')
  }
} catch {}

interface BrokenRecord {
  timestamp: number
}

function getBrokenMap(): Record<string, BrokenRecord> {
  try {
    const raw = localStorage.getItem(BROKEN_STREAMS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, BrokenRecord>
    const now = Date.now()
    const valid: Record<string, BrokenRecord> = {}
    for (const [id, rec] of Object.entries(parsed)) {
      if (now - rec.timestamp < BROKEN_TTL_MS) {
        valid[id] = rec
      }
    }
    return valid
  } catch {
    return {}
  }
}

const HIDE_BROKEN_KEY = 'sl_hide_broken'

let _cachedHideBroken: boolean | null = null
let _cachedBrokenSet: Set<string> | null = null
const _streamListeners = new Set<() => void>()

export function onStreamStateChange(listener: () => void): () => void {
  _streamListeners.add(listener)
  return () => {
    _streamListeners.delete(listener)
  }
}

export function notifyStreamStateChange() {
  _streamListeners.forEach((fn) => {
    try {
      fn()
    } catch {}
  })
}

/** Off unless the user turned it on: a channel is hidden only by an explicit choice. */
export function isHideBrokenStreamsEnabled(): boolean {
  if (_cachedHideBroken !== null) return _cachedHideBroken
  try {
    _cachedHideBroken = localStorage.getItem(HIDE_BROKEN_KEY) === 'true'
  } catch {
    _cachedHideBroken = false
  }
  return _cachedHideBroken
}

export function setHideBrokenStreamsEnabled(enabled: boolean) {
  _cachedHideBroken = enabled
  try {
    localStorage.setItem(HIDE_BROKEN_KEY, enabled ? 'true' : 'false')
  } catch {}
  notifyStreamStateChange()
}

const AUTO_SKIP_KEY = 'sl_auto_skip'
let _cachedAutoSkip: boolean | null = null

export function isAutoSkipEnabled(): boolean {
  if (_cachedAutoSkip !== null) return _cachedAutoSkip
  try {
    _cachedAutoSkip = localStorage.getItem(AUTO_SKIP_KEY) === 'true'
  } catch {
    _cachedAutoSkip = false
  }
  return _cachedAutoSkip
}

export function setAutoSkipEnabled(enabled: boolean) {
  _cachedAutoSkip = enabled
  try {
    localStorage.setItem(AUTO_SKIP_KEY, enabled ? 'true' : 'false')
  } catch {}
  notifyStreamStateChange()
}

export function getBrokenSet(): Set<string> {
  if (_cachedBrokenSet) return _cachedBrokenSet
  const map = getBrokenMap()
  _cachedBrokenSet = new Set(Object.keys(map))
  return _cachedBrokenSet
}

export function isStreamBroken(channelId: string): boolean {
  return getBrokenSet().has(channelId)
}

/**
 * Low-level writer. Play failures must go through `recordStreamFailure`
 * (streamFailure.ts), which only calls this for stream-specific evidence.
 */
export function markStreamBroken(channelId: string) {
  try {
    const map = getBrokenMap()
    map[channelId] = { timestamp: Date.now() }
    localStorage.setItem(BROKEN_STREAMS_KEY, JSON.stringify(map))
    _cachedBrokenSet = null
    notifyStreamStateChange()
  } catch {
    // ignore quota
  }
}

export function unmarkStreamBroken(channelId: string) {
  try {
    const map = getBrokenMap()
    if (map[channelId]) {
      delete map[channelId]
      localStorage.setItem(BROKEN_STREAMS_KEY, JSON.stringify(map))
      _cachedBrokenSet = null
      notifyStreamStateChange()
    }
  } catch {
    // ignore
  }
}

export function getBrokenCount(): number {
  return getBrokenSet().size
}

export function clearBrokenStreams() {
  try {
    localStorage.removeItem(BROKEN_STREAMS_KEY)
    localStorage.removeItem('sl_broken_streams_v1')
    _cachedBrokenSet = null
    notifyStreamStateChange()
  } catch {
    // ignore
  }
}

// ---- User-hidden channels ----
// A channel the user chose to hide. Unlike a broken mark this is an explicit
// choice, so it never expires, is not touched by the broken-mark purge or the
// cache reset, and applies whether or not "hide failed channels" is on.
const HIDDEN_CHANNELS_KEY = 'sl_hidden_channels_v1'
let _cachedHiddenSet: Set<string> | null = null

function readHiddenFromStorage(): Set<string> {
  let ids: string[] = []
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HIDDEN_CHANNELS_KEY) ?? '[]')
    if (Array.isArray(parsed)) ids = parsed.filter((id): id is string => typeof id === 'string')
  } catch {
    // unreadable value: treat as nothing hidden
  }
  return new Set(ids)
}

export function getHiddenSet(): Set<string> {
  if (!_cachedHiddenSet) _cachedHiddenSet = readHiddenFromStorage()
  return _cachedHiddenSet
}

// Another tab changed the list: drop the cache so the next read sees it.
try {
  window.addEventListener('storage', (e) => {
    if (e.key !== HIDDEN_CHANNELS_KEY) return
    _cachedHiddenSet = null
    notifyStreamStateChange()
  })
} catch {}

function saveHiddenSet(set: Set<string>) {
  _cachedHiddenSet = set
  try {
    localStorage.setItem(HIDDEN_CHANNELS_KEY, JSON.stringify([...set]))
  } catch {
    // ignore quota: stays hidden for this session
  }
  notifyStreamStateChange()
}

export function isChannelHidden(channelId: string): boolean {
  return getHiddenSet().has(channelId)
}

// Read-modify-write starts from storage, not the cache, so a change made in
// another tab is merged rather than overwritten.
export function hideChannel(channelId: string) {
  const current = readHiddenFromStorage()
  if (current.has(channelId)) {
    _cachedHiddenSet = current
    return
  }
  saveHiddenSet(current.add(channelId))
}

export function unhideChannel(channelId: string) {
  const current = readHiddenFromStorage()
  if (!current.delete(channelId)) return
  saveHiddenSet(current)
}

export function clearHiddenChannels() {
  saveHiddenSet(new Set())
}

// ---- Verified Working Streams Cache ----
const WORKING_STREAMS_KEY = 'sl_working_streams_v1'
const WORKING_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export interface WorkingStreamRecord {
  url: string
  useProxy: boolean
  quality?: string | null
  timestamp: number
}

function getWorkingMap(): Record<string, WorkingStreamRecord> {
  try {
    const raw = localStorage.getItem(WORKING_STREAMS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, WorkingStreamRecord>
    const now = Date.now()
    const valid: Record<string, WorkingStreamRecord> = {}
    for (const [id, rec] of Object.entries(parsed)) {
      if (now - rec.timestamp < WORKING_TTL_MS) {
        valid[id] = rec
      }
    }
    return valid
  } catch {
    return {}
  }
}

/**
 * Snapshot of the working-stream cache, resolved once per call.
 *
 * enrichChannels used to call getCachedWorkingStream() once per channel, so the
 * whole localStorage map was re-read and re-parsed on every one of ~40k rows.
 * Callers now take a single snapshot and look up from it.
 */
export function getWorkingMapSnapshot(): Record<string, WorkingStreamRecord> {
  return getWorkingMap()
}

export function getCachedWorkingStream(
  channelId: string
): { url: string; useProxy: boolean; quality?: string | null } | null {
  const map = getWorkingMap()
  const rec = map[channelId]
  if (!rec) return null
  return { url: rec.url, useProxy: rec.useProxy, quality: rec.quality }
}

export function cacheWorkingStream(
  channelId: string,
  url: string,
  useProxy = false,
  quality?: string | null
) {
  try {
    const map = getWorkingMap()
    map[channelId] = { url, useProxy, quality: quality ?? null, timestamp: Date.now() }
    localStorage.setItem(WORKING_STREAMS_KEY, JSON.stringify(map))
  } catch {
    // ignore quota
  }
}

export function clearWorkingStreams() {
  clearNativeHlsMarks()
  try {
    localStorage.removeItem(WORKING_STREAMS_KEY)
  } catch {
    // ignore
  }
}

export interface EdgeStreamCheckResult {
  channelId: string
  workingStream: string | null
  workingCandidates: string[]
  deadCandidates: string[]
  edgeNode?: string
  timestamp: number
}

/**
 * Global verification record (the same shape `fetchEdgeVerifiedStreams`
 * returns, minus the per-POP `edgeNode` field) plus the TTL the server
 * advertised when it published the record. `verifiedAt` is the server's
 * wall-clock timestamp at publish time.
 */
export interface KnownStreamVerification {
  channelId: string
  workingStream: string | null
  workingCandidates: string[]
  deadCandidates: string[]
  verifiedAt: number
  ttlMs: number
}

/**
 * Reads the global stream-verification record for a channel from the
 * edge-published R2 store. Returns `null` when no record exists, when the
 * record is older than `ttlMs`, or on any transport error — the caller
 * falls back to a live probe in all three cases.
 *
 * The R2 store is geo-replicated by Cloudflare, so any POP that reads this
 * sees the same answer — eliminating the cross-POP inconsistency where a
 * channel "works" for one user and not another. The freshness check is
 * done client-side because R2 has no native TTL primitive.
 */
export async function fetchKnownStreams(
  channelId: string,
  timeoutMs = 1500,
): Promise<KnownStreamVerification | null> {
  if (!channelId) return null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(`/api/streams/known/${encodeURIComponent(channelId)}`, {
      method: 'GET',
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (res.status === 304 || res.status === 404) return null
    if (!res.ok) return null
    const data = (await res.json()) as KnownStreamVerification
    if (!data || typeof data.verifiedAt !== 'number' || typeof data.ttlMs !== 'number') return null
    if (Date.now() - data.verifiedAt > data.ttlMs) return null
    return data
  } catch {
    return null
  }
}

/**
 * Probes candidate stream URLs via edge node (/api/streams)
 * Returns pre-filtered working and dead stream candidates.
 *
 * Each candidate's resolution label is sent alongside its URL so the edge can
 * rank verified candidates by resolution instead of arrival order.
 */
export async function fetchEdgeVerifiedStreams(
  channelId: string,
  candidateUrls: string[],
  qualities?: (string | null | undefined)[],
  timeoutMs = 3000
): Promise<EdgeStreamCheckResult | null> {
  if (!candidateUrls || candidateUrls.length === 0) return null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const params = new URLSearchParams()
    params.set('channelId', channelId)
    // Repeated `url` params: stream URLs can contain commas.
    for (const u of candidateUrls) params.append('url', u)
    if (qualities && qualities.length > 0) {
      params.set(
        'qualities',
        candidateUrls.map((_, i) => qualities[i] ?? '').join(',')
      )
    }

    const res = await fetch(`/api/streams?${params.toString()}`, {
      method: 'GET',
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return null
    const data = (await res.json()) as EdgeStreamCheckResult
    return data
  } catch {
    return null
  }
}

/**
 * Builds the proxy URL for a given stream endpoint.
 * Protects against double-proxying and appends multi-candidate fallbacks.
 */
export function getProxyStreamUrl(
  rawUrl: string,
  userAgent?: string | null,
  referrer?: string | null,
  fallbacks?: string[],
  channelId?: string,
  repack?: boolean
): string {
  if (!rawUrl) return ''
  if (rawUrl.startsWith('/api/proxy') || rawUrl.includes('/api/proxy?url=')) {
    return rawUrl
  }
  const params = new URLSearchParams()
  params.set('url', rawUrl)
  if (repack) params.set('repack', '1')
  if (userAgent) params.set('ua', userAgent)
  if (referrer) params.set('ref', referrer)
  if (fallbacks && fallbacks.length > 0) {
    for (const fb of fallbacks) {
      if (fb && fb !== rawUrl) {
        params.append('fallback', fb)
      }
    }
  }
  if (channelId) {
    params.set('channelId', channelId)
  }
  return `/api/proxy?${params.toString()}`
}

/**
 * Checks if the current page protocol is HTTPS while the stream is HTTP.
 */
export function isMixedContent(url: string): boolean {
  if (typeof window === 'undefined') return false
  return window.location.protocol === 'https:' && url.startsWith('http://')
}

/**
 * Upgrades http:// to https://
 */
export function tryUpgradeToHttps(url: string): string {
  if (url.startsWith('http://')) {
    return url.replace(/^http:\/\//i, 'https://')
  }
  return url
}

/**
 * Checks if a response payload is HTML (e.g. SPA index.html returned by unconfigured proxy).
 */
export function isHtmlResponse(text: string): boolean {
  if (!text) return false
  const trimmed = text.trimStart().toLowerCase()
  return (
    trimmed.startsWith('<!doctype html') ||
    trimmed.startsWith('<html') ||
    trimmed.startsWith('<head') ||
    trimmed.startsWith('<body')
  )
}
