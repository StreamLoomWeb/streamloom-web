/**
 * Maps a failed attempt to the contract's `ERROR_CLASSES` (ADR-0032: stream faults only).
 *
 * Only ever consulted when `streamFailure.ts` has already classed the failure as `stream`: a
 * network failure, a timeout or the watchdog has no class here, on purpose, because a client's
 * own connection is never evidence about a stream.
 */

import type { ErrorClass } from '../../functions/api/_lib/telemetryContract'
import type { HlsErrorLike } from '../util/streamFailure'

const MANIFEST_DETAILS = new Set([
  'manifestParsingError',
  'manifestIncompatibleCodecsError',
  'levelEmptyError',
  'levelParsingError',
])

const CODEC_DETAILS = new Set([
  'fragParsingError',
  'bufferAddCodecError',
  'bufferIncompatibleCodecsError',
  'bufferAppendError',
  'bufferAppendingError',
])

const DRM_DETAILS = new Set(['fragDecryptError', 'keyLoadError'])

export function errorClassOfHls(error: HlsErrorLike): ErrorClass {
  const details = error.details ?? ''
  const status = error.response?.code
  if (typeof status === 'number' && status >= 500 && status <= 599) return 'http_5xx'
  if (typeof status === 'number' && status >= 400 && status <= 499) return 'http_4xx'
  if (MANIFEST_DETAILS.has(details)) return 'manifest'
  if (CODEC_DETAILS.has(details)) return 'codec'
  if (DRM_DETAILS.has(details) || /key|drm|eme/i.test(details)) return 'drm'
  return 'other'
}

/** `MediaError` codes: 3 decode, 4 source not supported; both are the stream's content. */
export function errorClassOfMedia(code: number | undefined): ErrorClass {
  if (code === 3 || code === 4) return 'codec'
  return 'other'
}
