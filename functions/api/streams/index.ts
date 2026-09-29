/**
 * Cloudflare Pages Function: /api/streams
 *
 * Probes candidate stream URLs via short Range requests and returns the verified
 * working + dead list, cached per edge POP in `caches.default` (2 h TTL) so a
 * swarm of visitors on the same POP never re-probes.
 *
 * The first candidate (and the second if the first fails) is probed
 * synchronously so the request returns within ~5 s of the user tapping a
 * channel. The remaining candidates are probed in the background via
 * `context.waitUntil()`.
 *
 * This route does not write to R2. It used to publish every result to
 * `stream-verify/<channelId>.json`, but the channel id and the candidate URLs
 * both come from the query string of an unauthenticated request, so any caller
 * could overwrite the record `/api/streams/known/:channelId` serves to every
 * visitor. A record other visitors trust has to be written by something that
 * can be trusted, which a public route cannot be without a secret. The reader
 * stays; its writer is the backend probe.
 *
 * Honesty: a stream that is "live" from one POP can still be geo-fenced for
 * a different POP, so verification is best-effort, not a guarantee.
 */

import { isPlaylistBytes, looksLikeHtml, peekBody, sniffKind } from '../_lib/sniff'
interface EdgeStreamsPayload {
  channelId: string
  workingStream: string | null
  workingCandidates: string[]
  deadCandidates: string[]
  edgeNode: string
  timestamp: number
}

/** Higher score wins. Unknown resolutions rank lowest so named ones always win. */
function rankResolution(quality: string | null | undefined): number {
  if (!quality) return 0
  const q = quality.toLowerCase()
  if (q.includes('4k') || q.includes('2160') || q.includes('uhd')) return 4
  if (q.includes('1080') || q.includes('fhd') || q.includes('full hd')) return 3
  if (q.includes('720') || q.includes('hd')) return 2
  if (q.includes('576') || q.includes('480') || q.includes('360') || q.includes('sd')) return 1
  return 0
}

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const PROBE_READ_BYTES = 2048
const POSITIVE_TTL_S = 7200
/** A negative verdict is often transient (a busy origin, one bad POP); keep it short. */
const NEGATIVE_TTL_S = 600

interface ProbeIdentity {
  ua?: string
  ref?: string
}

async function probeStreamEndpoint(url: string, timeoutMs = 2500, identity: ProbeIdentity = {}): Promise<boolean> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return false
    }

    const res = await fetch(parsed.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': identity.ua || DEFAULT_UA,
        Referer: identity.ref || parsed.origin,
        Range: 'bytes=0-2048',
      },
      signal: controller.signal,
      redirect: 'follow',
    })

    if (!res.ok && res.status !== 206) {
      try {
        await res.body?.cancel()
      } catch {}
      return false
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase()
    const reader = res.body ? res.body.getReader() : null
    if (!reader) return false
    try {
      // At most ~2 KB, then cancel: a live TS stream never ends.
      const peek = await peekBody(reader, PROBE_READ_BYTES)
      const bytes = peek.bytes
      if (contentType.includes('text/html') && looksLikeHtml(bytes)) return false
      if (isPlaylistBytes(bytes)) return true
      if (
        contentType.includes('mpegurl') ||
        contentType.includes('video/') ||
        contentType.includes('audio/')
      ) {
        return true
      }
      // Mislabelled or unlabelled (video/mp2t, octet-stream, none): trust the bytes.
      return sniffKind(bytes) !== 'unknown'
    } finally {
      try {
        await reader.cancel()
      } catch {}
    }
  } catch {
    return false
  } finally {
    clearTimeout(timeoutId)
  }
}

async function urlSetHash(urls: string[]): Promise<string> {
  const data = new TextEncoder().encode([...urls].sort().join('\n'))
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')
}

export const onRequest: PagesFunction = async (context) => {
  const { request } = context
  const urlObj = new URL(request.url)

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400',
      },
    })
  }

  const channelId = urlObj.searchParams.get('channelId') || 'unknown'
  const urlsParam = urlObj.searchParams.get('urls') || ''
  const urlParams = urlObj.searchParams.getAll('url')

  // Collect and deduplicate candidate URLs
  const rawCandidateList: string[] = []
  if (urlParams.length > 0) {
    // Repeated `url` params: a URL may itself contain commas, so these are never split.
    rawCandidateList.push(...urlParams.map((u) => u.trim()))
  } else if (urlsParam) {
    // Legacy comma-separated form, only when no repeated `url` was sent.
    rawCandidateList.push(...urlsParam.split(',').map((u) => u.trim()))
  }

  // Resolution labels arrive positionally aligned with the `urls` list.
  const qualitiesParam = urlObj.searchParams.get('qualities') || ''
  const qualitiesList = qualitiesParam ? qualitiesParam.split(',') : []
  const qualityByUrl = new Map<string, string>()
  rawCandidateList.forEach((u, i) => {
    const q = qualitiesList[i]?.trim()
    if (u.length > 0 && q && !qualityByUrl.has(u)) qualityByUrl.set(u, q)
  })

  const candidateUrls = Array.from(new Set(rawCandidateList.filter((u) => u.length > 0)))
    // Probe highest resolution first: the first working candidate wins.
    .sort((a, b) => rankResolution(qualityByUrl.get(b)) - rankResolution(qualityByUrl.get(a)))

  const cfColo = (request as any).cf?.colo || 'UNKNOWN'

  if (candidateUrls.length === 0) {
    return new Response(JSON.stringify({ error: 'Missing candidate stream URLs' }), {
      status: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    })
  }

  // Check edge POP cache
  const identity: ProbeIdentity = {
    ua: urlObj.searchParams.get('ua') || undefined,
    ref: urlObj.searchParams.get('ref') || undefined,
  }
  // The verdict is about this set of URLs, so the key carries a hash of it.
  const cacheKey = `https://streamloom.internal/edge-streams/${encodeURIComponent(channelId)}/${await urlSetHash(candidateUrls)}`
  let edgeCache: any = null
  try {
    // @ts-ignore
    if (typeof caches !== 'undefined' && caches.default) {
      // @ts-ignore
      edgeCache = caches.default
    }
  } catch {}

  if (edgeCache) {
    try {
      const cachedResponse = await edgeCache.match(cacheKey)
      if (cachedResponse) {
        const cachedData = await cachedResponse.json()
        return new Response(JSON.stringify(cachedData), {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'X-Cache': 'HIT',
            'X-Edge-POP': cfColo,
          },
        })
      }
    } catch {
      // Continue to live probe on cache error
    }
  }

  // Fast synchronous probe on candidate 1
  const workingCandidates: string[] = []
  const deadCandidates: string[] = []

  const firstCandidate = candidateUrls[0]
  const firstIsWorking = await probeStreamEndpoint(firstCandidate, 2500, identity)

  if (firstIsWorking) {
    workingCandidates.push(firstCandidate)
  } else {
    deadCandidates.push(firstCandidate)
    // Try candidate 2 synchronously if available
    if (candidateUrls.length > 1) {
      const secondCandidate = candidateUrls[1]
      const secondIsWorking = await probeStreamEndpoint(secondCandidate, 2500, identity)
      if (secondIsWorking) {
        workingCandidates.push(secondCandidate)
      } else {
        deadCandidates.push(secondCandidate)
      }
    }
  }

  const payload: EdgeStreamsPayload = {
    channelId,
    workingStream: workingCandidates[0] || null,
    workingCandidates: [...workingCandidates],
    deadCandidates: [...deadCandidates],
    edgeNode: cfColo,
    timestamp: Date.now(),
  }

  // Populate edge cache immediately with initial sync probe result
  if (edgeCache) {
    try {
      const initialToCache = new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': `public, max-age=${payload.workingStream ? POSITIVE_TTL_S : NEGATIVE_TTL_S}`,
          'Access-Control-Allow-Origin': '*',
        },
      })
      if (typeof context.waitUntil === 'function') {
        context.waitUntil(edgeCache.put(cacheKey, initialToCache))
      } else {
        edgeCache.put(cacheKey, initialToCache).catch(() => {})
      }
    } catch {
      // Ignore cache storage errors
    }
  }

  // Background job to probe remaining candidates and populate edge cache
  const remainingCandidates = candidateUrls.filter(
    (u) => !workingCandidates.includes(u) && !deadCandidates.includes(u)
  )

  const backgroundJob = async () => {
    for (const url of remainingCandidates) {
      const ok = await probeStreamEndpoint(url, 3000, identity)
      if (ok) {
        if (!payload.workingCandidates.includes(url)) {
          payload.workingCandidates.push(url)
        }
        if (!payload.workingStream) {
          payload.workingStream = url
        }
      } else {
        if (!payload.deadCandidates.includes(url)) {
          payload.deadCandidates.push(url)
        }
      }
    }

    if (edgeCache) {
      try {
        const toCache = new Response(JSON.stringify(payload), {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': `public, max-age=${payload.workingStream ? POSITIVE_TTL_S : NEGATIVE_TTL_S}`, // 2-hour TTL at edge
            'Access-Control-Allow-Origin': '*',
          },
        })
        await edgeCache.put(cacheKey, toCache)
      } catch {
        // Ignore cache storage errors
      }
    }
  }

  if (typeof context.waitUntil === 'function') {
    context.waitUntil(backgroundJob())
  } else {
    backgroundJob().catch(() => {})
  }

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'X-Cache': 'MISS',
      'X-Edge-POP': cfColo,
    },
  })
}
