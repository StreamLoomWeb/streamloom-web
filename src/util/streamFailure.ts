/**
 * Decides whether a failed play is evidence that the *stream* is broken.
 *
 * A channel is only ever flagged broken (and so hidden, when the user has turned
 * "hide failed channels" on) when the failure is provably the stream's fault. A
 * failure caused by the user's own network must never change what is shown, so
 * the classes below are kept apart:
 *
 * - `stream`       the origin answered with an error status, or the payload will
 *                  not parse or decode. Reproducible for anyone.
 * - `network`      no response at all (offline, DNS, TLS, CORS, connection reset).
 *                  Says as much about the user's connection as about the stream.
 * - `inconclusive` a timeout, stall, abort or anything unrecognised. A slow link
 *                  looks identical to a dead origin, so it is never evidence.
 *
 * Kept free of hls.js imports (detail names are matched by their string values)
 * so it stays out of the code-split media engine chunk.
 */

import { markStreamBroken } from './stream'

export type FailureClass = 'stream' | 'network' | 'inconclusive'

/** The subset of an hls.js `ErrorData` the classifier reads. */
export interface HlsErrorLike {
  type?: string
  details?: string
  response?: { code?: number }
}

/** Detail values (`Hls.ErrorDetails`) where the stream's own content was rejected. */
const CONTENT_ERROR_DETAILS = new Set([
  'manifestParsingError',
  'manifestIncompatibleCodecsError',
  'levelEmptyError',
  'levelParsingError',
  'fragParsingError',
  'fragDecryptError',
  'bufferAddCodecError',
  'bufferIncompatibleCodecsError',
  'bufferAppendError',
  'bufferAppendingError',
])

/** Detail values raised when a request completes with an error or not at all. */
const LOAD_ERROR_DETAILS = new Set([
  'manifestLoadError',
  'levelLoadError',
  'fragLoadError',
  'audioTrackLoadError',
  'subtitleTrackLoadError',
  'keyLoadError',
])

/** Statuses that describe the request or the caller, not the stream. */
const TRANSIENT_STATUSES = new Set([408, 425, 429])

/** Classifies an HTTP status returned for a stream request. */
export function classifyHttpStatus(status: number | undefined): FailureClass {
  if (!status) return 'network'
  if (TRANSIENT_STATUSES.has(status)) return 'inconclusive'
  return status >= 400 && status <= 599 ? 'stream' : 'inconclusive'
}

/** Classifies a fatal hls.js error. */
export function classifyHlsError(error: HlsErrorLike): FailureClass {
  const details = error.details ?? ''
  if (/time-?out$/i.test(details)) return 'inconclusive'
  if (CONTENT_ERROR_DETAILS.has(details)) return 'stream'
  if (LOAD_ERROR_DETAILS.has(details)) return classifyHttpStatus(error.response?.code)
  return 'inconclusive'
}

/**
 * Classifies an `HTMLMediaElement` error, used by the native HLS path (Safari,
 * iOS, some smart TVs) where no HTTP status is exposed.
 * `MediaError` codes: 1 aborted, 2 network, 3 decode, 4 source not supported.
 */
export function classifyMediaElementError(code: number | undefined): FailureClass {
  if (code === 2) return 'network'
  if (code === 3 || code === 4) return 'stream'
  return 'inconclusive'
}

/**
 * True when every candidate stream of the channel was tried and each one's last
 * attempt failed for a stream-specific reason. One timeout or network failure
 * among the candidates leaves open that the channel works.
 */
export function isStreamSpecificFailure(
  verdicts: ReadonlyMap<number, FailureClass>,
  candidateCount: number
): boolean {
  if (candidateCount <= 0 || verdicts.size < candidateCount) return false
  for (let idx = 0; idx < candidateCount; idx++) {
    if (verdicts.get(idx) !== 'stream') return false
  }
  return true
}

/**
 * Same-origin asset, fetched with a query string and `no-store` so the request
 * always reaches the network.
 */
const PROBE_PATH = '/favicon.svg'

/**
 * Confirms the user's own connection works: the browser reports online and a
 * request to a known-good URL on our own origin succeeds.
 */
export async function confirmConnectivity(timeoutMs = 4000): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${PROBE_PATH}?probe=${Date.now()}`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export interface StreamFailureOutcome {
  /** The connectivity check passed. */
  reachable: boolean
  /** The channel was flagged broken. */
  recorded: boolean
}

/**
 * Flags the channel as broken only when connectivity is confirmed, the failure
 * is stream-specific for every candidate, and the caller still cares
 * (`isCurrent`, checked after the async probe).
 */
export async function recordStreamFailure(
  channelId: string,
  verdicts: ReadonlyMap<number, FailureClass>,
  candidateCount: number,
  isCurrent: () => boolean = () => true
): Promise<StreamFailureOutcome> {
  const reachable = await confirmConnectivity()
  if (!reachable) return { reachable, recorded: false }
  if (!isCurrent() || !isStreamSpecificFailure(verdicts, candidateCount)) {
    return { reachable, recorded: false }
  }
  markStreamBroken(channelId)
  return { reachable, recorded: true }
}
