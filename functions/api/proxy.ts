/**
 * Cloudflare Pages Function: /api/proxy
 * 
 * High-performance edge streaming proxy with:
 * - Multi-candidate server-side fallback: automatically fails over to alternate candidates
 *   without requiring multiple client-side round trips.
 * - Edge POP caching: prioritizes pre-verified working streams from caches.default.
 * - Dynamic M3U8 manifest rewriting for CORS bypass and mixed-content resolution.
 * - Content-length and content-encoding stripping to prevent body truncation.
 */

import { fetchUpstream as fetchUpstreamHop } from './_lib/rawHttp'
import { repackSegment } from './_lib/tsTrim'
import { PEEK_BYTES, concatBytes, isPlaylistBytes, looksLikeHtml, peekBody, sniffKind } from './_lib/sniff'

/** A VLC-like identity: many IPTV origins allow it and refuse browser UAs. */
const VLC_UA = 'VLC/3.0.20 LibVLC/3.0.20'
/** Largest TS segment the repacker will buffer. */
const MAX_REPACK_BYTES = 4 * 1024 * 1024
/** How long a fetched segment is kept so the next request for it does not go upstream again. */
const SEGMENT_CACHE_SECONDS = 40
const isVlcUa = (ua: string) => /^VLC\//i.test(ua)
/** A playlist larger than this is not a playlist worth rewriting in memory. */
const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024
/** `URI="x"`, `URI='x'` or `URI=x` (unquoted, ends at a comma or whitespace). */
const URI_ATTR = /URI=(?:"([^"]*)"|'([^']*)'|([^,\s"']+))/g

function updateEdgeCacheWorkingStream(channelId: string, workingUrl: string, colo: string, context: any) {
  if (!channelId || channelId === 'unknown') return
  const cacheKey = `https://streamloom.internal/edge-streams/${encodeURIComponent(channelId)}`
  const updateJob = async () => {
    try {
      // @ts-ignore
      if (typeof caches === 'undefined' || !caches.default) return
      // @ts-ignore
      const edgeCache = caches.default
      let existingData: any = null
      try {
        const match = await edgeCache.match(cacheKey)
        if (match) {
          existingData = await match.json()
        }
      } catch {}

      const workingCandidates = Array.from(new Set([workingUrl, ...(existingData?.workingCandidates || [])]))
      const deadCandidates = (existingData?.deadCandidates || []).filter((u: string) => u !== workingUrl)

      const payload = {
        channelId,
        workingStream: workingUrl,
        workingCandidates,
        deadCandidates,
        edgeNode: colo,
        timestamp: Date.now(),
      }

      const cacheResponse = new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=7200',
          'Access-Control-Allow-Origin': '*',
        },
      })
      await edgeCache.put(cacheKey, cacheResponse)
    } catch {
      // Ignore edge cache write errors
    }
  }

  if (typeof context.waitUntil === 'function') {
    context.waitUntil(updateJob())
  } else {
    updateJob().catch(() => {})
  }
}

const segmentCacheKey = (url: string) => `https://streamloom.internal/seg/${encodeURIComponent(url)}`

async function cachedSegment(url: string): Promise<Uint8Array | null> {
  try {
    // @ts-ignore
    if (typeof caches === 'undefined' || !caches.default) return null
    // @ts-ignore
    const hit = await caches.default.match(segmentCacheKey(url))
    return hit ? new Uint8Array(await hit.arrayBuffer()) : null
  } catch {
    return null
  }
}

function cacheSegment(url: string, bytes: Uint8Array, context: any) {
  try {
    // @ts-ignore
    if (typeof caches === 'undefined' || !caches.default) return
    // @ts-ignore
    const put = caches.default.put(
      segmentCacheKey(url),
      new Response(bytes, { headers: { 'Cache-Control': `public, max-age=${SEGMENT_CACHE_SECONDS}` } })
    )
    context?.waitUntil?.(put)
  } catch {
    // caching is an optimisation only
  }
}

/** Whole body of a small upstream resource (a TS segment), or null when it cannot be had. */
async function fetchWholeSegment(url: string, ua: string, ref: string, range: string | null): Promise<Uint8Array | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12000)
  try {
    const target = new URL(url)
    if (!['http:', 'https:'].includes(target.protocol)) return null
    const attempt = async (u: string, r: string) => {
      const headers = new Headers()
      headers.set('User-Agent', u)
      if (!(isVlcUa(u) && !r)) headers.set('Referer', r || target.origin)
      if (range) headers.set('Range', range)
      return (await fetchUpstreamHop(target, { method: 'GET', headers, signal: controller.signal })).response
    }
    let res = await attempt(ua, ref)
    if ((res.status === 401 || res.status === 403) && !isVlcUa(ua)) {
      try { await res.body?.cancel() } catch {}
      res = await attempt(VLC_UA, '')
    }
    if (!res.ok) {
      try { await res.body?.cancel() } catch {}
      return null
    }
    const reader = res.body?.getReader()
    if (!reader) return null
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        total += value.length
      }
      if (total > MAX_REPACK_BYTES) {
        try { await reader.cancel() } catch {}
        return null
      }
    }
    const all = new Uint8Array(total)
    let at = 0
    for (const c of chunks) {
      all.set(c, at)
      at += c.length
    }
    return all
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export const onRequest: PagesFunction = async (context) => {
  const { request } = context
  const urlObj = new URL(request.url)
  const targetUrl = urlObj.searchParams.get('url')

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400',
      },
    })
  }

  if (!targetUrl) {
    return new Response('Missing target url query parameter', {
      status: 400,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'text/plain',
      },
    })
  }

  const channelId = urlObj.searchParams.get('channelId') || ''
  const rawFallbacks = urlObj.searchParams.getAll('fallback')
    .flatMap((f) => f.split(','))
    .map((f) => f.trim())
    .filter(Boolean)

  const cfColo = (request as any).cf?.colo || 'UNKNOWN'

  // Candidate URLs list
  let candidateUrls = Array.from(new Set([targetUrl, ...rawFallbacks]))

  // Check if edge cache already verified a working stream for this channel
  if (channelId) {
    try {
      // @ts-ignore
      if (typeof caches !== 'undefined' && caches.default) {
        // @ts-ignore
        const cachedMatch = await caches.default.match(
          `https://streamloom.internal/edge-streams/${encodeURIComponent(channelId)}`
        )
        if (cachedMatch) {
          const cachedData = await cachedMatch.json()
          if (cachedData.workingStream && candidateUrls.includes(cachedData.workingStream)) {
            // Prioritize cached working candidate to index 0
            candidateUrls = [
              cachedData.workingStream,
              ...candidateUrls.filter((u) => u !== cachedData.workingStream),
            ]
          }
        }
      }
    } catch {
      // Ignore cache lookup errors
    }
  }

  const defaultUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  const customUa = urlObj.searchParams.get('ua') || defaultUa
  const customRef = urlObj.searchParams.get('ref') || ''
  const sniff = urlObj.searchParams.get('sniff') === '1'
  const range = sniff ? null : request.headers.get('Range')

  // Safari's native HLS player cannot start on a segment that opens mid-GOP, and some restreams
  // cut their segments on the clock. `repack=1&seg=1` re-cuts a segment on its first I-picture and
  // appends the head of the next one, so no picture is lost and every output starts on a key frame.
  const repack = urlObj.searchParams.get('repack') === '1'
  const isSegmentRequest = repack && urlObj.searchParams.get('seg') === '1' && !sniff && (request.method === 'GET' || request.method === 'HEAD')
  if (isSegmentRequest) {
    const nextUrl = urlObj.searchParams.get('next')
    const curBytes = (await cachedSegment(targetUrl)) ?? (await fetchWholeSegment(targetUrl, customUa, customRef, null))
    if (curBytes && curBytes.length >= 188 * 4 && curBytes[0] === 0x47) {
      cacheSegment(targetUrl, curBytes, context)
      let nextBytes: Uint8Array | null = null
      if (nextUrl) {
        nextBytes = (await cachedSegment(nextUrl)) ?? (await fetchWholeSegment(nextUrl, customUa, customRef, null))
        if (nextBytes) cacheSegment(nextUrl, nextBytes, context)
      }
      let out: Uint8Array = curBytes
      try {
        out = repackSegment(curBytes, nextBytes)
      } catch {
        out = curBytes
      }
      // The player may ask for a byte range or only the headers: answer from the repacked bytes so
      // it never sees the original, mid-GOP segment.
      const headers: Record<string, string> = {
        'Content-Type': 'video/MP2T',
        'Cache-Control': 'no-cache',
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': '*',
        'X-Segment-Repacked': nextBytes ? 'with-next' : 'alone',
      }
      const total = out.length
      const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null
      if (m && (m[1] !== '' || m[2] !== '')) {
        let start = m[1] === '' ? Math.max(0, total - Number(m[2])) : Number(m[1])
        let end = m[1] === '' || m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1)
        if (start >= total || start > end) {
          return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${total}` } })
        }
        end = Math.max(end, start)
        start = Math.min(start, total - 1)
        headers['Content-Range'] = `bytes ${start}-${end}/${total}`
        headers['Content-Length'] = String(end - start + 1)
        return new Response(request.method === 'HEAD' ? null : out.subarray(start, end + 1), { status: 206, headers })
      }
      headers['Content-Length'] = String(total)
      return new Response(request.method === 'HEAD' ? null : out, { status: 200, headers })
    }
    // Could not repack (fetch failed or not TS): fall through to the ordinary path.
  }

  let lastError: string | null = null
  let lastHttpStatus = 0
  let lastFetchFailure: 'unreachable' | 'timeout' | 'blocked' | null = null

  // Fallback loop over candidates
  for (let i = 0; i < candidateUrls.length; i++) {
    const candidate = candidateUrls[i]

    let parsedTarget: URL
    try {
      parsedTarget = new URL(candidate)
      if (!['http:', 'https:'].includes(parsedTarget.protocol)) {
        continue
      }
    } catch {
      continue
    }

    const controller = new AbortController()
    const timeoutMs = candidateUrls.length > 1 ? 5000 : 10000
    // Stays armed until the first bytes (the peek) have arrived, so a server
    // that sends headers and then nothing cannot hold the request open.
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)

    try {
      // The effective identity for this candidate. A 401/403 retry switches to
      // a VLC-like UA with no referer, and child URLs inherit that choice.
      let effUa = customUa
      let effRef = customRef

      let finalUrl = parsedTarget.toString()
      let via = 'fetch'
      const fetchUpstream = async (ua: string, ref: string) => {
        const headers = new Headers()
        headers.set('User-Agent', ua)
        if (isVlcUa(ua) && !ref) {
          // VLC never sends a Referer.
        } else {
          headers.set('Referer', ref || parsedTarget.origin)
        }
        if (range) headers.set('Range', range)
        // Redirects are followed by hand so each hop can choose a raw socket (plain-http
        // IP / non-standard-port origins that Workers fetch() refuses) or fetch().
        const r = await fetchUpstreamHop(parsedTarget, { method: request.method, headers, signal: controller.signal })
        finalUrl = r.finalUrl
        via = r.via
        return r.response
      }

      let upstreamResponse = await fetchUpstream(effUa, effRef)
      if ((upstreamResponse.status === 401 || upstreamResponse.status === 403) && !isVlcUa(effUa)) {
        try {
          await upstreamResponse.body?.cancel()
        } catch {}
        effUa = VLC_UA
        effRef = ''
        upstreamResponse = await fetchUpstream(effUa, effRef)
      }

      const contentType = (upstreamResponse.headers.get('content-type') || '').toLowerCase()

      if (!upstreamResponse.ok && upstreamResponse.status !== 206) {
        lastHttpStatus = upstreamResponse.status
        lastError = `Candidate ${candidate} returned HTTP ${upstreamResponse.status}`
        try {
          await upstreamResponse.body?.cancel()
        } catch {}
        continue
      }

      // Peek the first bytes; never buffer an unbounded body.
      const reader = upstreamResponse.body ? upstreamResponse.body.getReader() : null
      let peeked: Uint8Array = new Uint8Array(0)
      let bodyDone = reader === null
      if (reader) {
        const peek = await peekBody(reader, PEEK_BYTES)
        peeked = peek.bytes
        bodyDone = peek.done
      }
      clearTimeout(timer)

      // If upstream responded with HTML (error page, challenge, or paywall), reject
      if (contentType.includes('text/html') && looksLikeHtml(peeked)) {
        lastError = `Candidate ${candidate} returned HTML error page`
        try {
          await reader?.cancel()
        } catch {}
        continue
      }

      if (sniff) {
        try {
          await reader?.cancel()
        } catch {}
        return new Response(JSON.stringify({ kind: sniffKind(peeked), contentType }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Expose-Headers': '*',
          },
        })
      }

      // Success! Update edge cache if channelId is known
      if (channelId) {
        updateEdgeCacheWorkingStream(channelId, candidate, cfColo, context)
      }

      const responseHeaders = new Headers(upstreamResponse.headers)
      responseHeaders.set('Access-Control-Allow-Origin', '*')
      responseHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
      responseHeaders.set('Access-Control-Allow-Headers', '*')
      responseHeaders.set('Access-Control-Expose-Headers', '*')
      responseHeaders.set('X-Stream-Resolved', candidate)
      responseHeaders.set('X-Edge-POP', cfColo)
      // socket = raw TCP (plain-http IP / non-standard port), fetch = Workers fetch(). Diagnostic.
      responseHeaders.set('X-Upstream-Via', via)
      responseHeaders.delete('X-Frame-Options')
      responseHeaders.delete('Content-Security-Policy')
      // The upstream is whatever the caller named, and this response is served
      // from the app's own origin. Anyone can craft a link to
      // /api/proxy?url=<their host>, so an SVG/XHTML/XML body would otherwise run
      // its script with the app's origin if opened as a page. `sandbox` gives
      // such a document an opaque origin with no script; it has no effect on
      // playlists, segments or <video>, which are fetched rather than navigated
      // to. Cookies are dropped because the proxy never forwards them upstream.
      responseHeaders.set('Content-Security-Policy', 'sandbox')
      responseHeaders.delete('Set-Cookie')

      // Decide by content, not label: only a body that starts with #EXTM3U
      // (after an optional BOM) is a playlist, whatever its Content-Type says.
      if (isPlaylistBytes(peeked)) {
        let all = peeked
        if (!bodyDone && reader) {
          const rest = setTimeout(() => controller.abort(), timeoutMs)
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              if (value) all = concatBytes(all, value)
              if (all.length > MAX_PLAYLIST_BYTES) {
                try {
                  await reader.cancel()
                } catch {}
                lastError = `Candidate ${candidate} playlist too large`
                all = new Uint8Array(0)
                break
              }
            }
          } finally {
            clearTimeout(rest)
          }
          if (all.length === 0) continue
        }
        const originalText = new TextDecoder().decode(all).replace(/^﻿/, '')

        const baseUrl = new URL(finalUrl)
        const proxyBase = `${urlObj.origin}${urlObj.pathname}`

        const buildChildUrl = (raw: string, extra?: { seg?: boolean; next?: string | null }) => {
          try {
            const absolute = new URL(raw, baseUrl).toString()
            const p = new URLSearchParams()
            p.set('url', absolute)
            if (effUa) p.set('ua', effUa)
            if (effRef) p.set('ref', effRef)
            if (repack) p.set('repack', '1')
            if (extra?.seg) p.set('seg', '1')
            if (extra?.next) p.set('next', extra.next)
            return `${proxyBase}?${p.toString()}`
          } catch {
            return raw
          }
        }

        const lines = originalText.split(/\r?\n/)
        // For a repacked media playlist: each segment names the one after it (its tail comes from
        // there), and the newest live segment is held back until its successor exists.
        const isMedia = repack && lines.some((l) => l.startsWith('#EXTINF'))
        const hasEndList = lines.some((l) => l.trim() === '#EXT-X-ENDLIST')
        const segIdx: number[] = []
        if (isMedia) lines.forEach((l, i) => { if (l.trim() && !l.trim().startsWith('#')) segIdx.push(i) })
        const dropLines = new Set<number>()
        if (isMedia && !hasEndList && segIdx.length > 1) {
          const last = segIdx[segIdx.length - 1]
          dropLines.add(last)
          for (let k = last - 1; k >= 0 && lines[k].trim().startsWith('#'); k--) {
            if (lines[k].startsWith('#EXTINF')) { dropLines.add(k); break }
            dropLines.add(k)
          }
        }
        const absOf = (raw: string) => { try { return new URL(raw, baseUrl).toString() } catch { return null } }

        const rewrittenText = lines
          .map((line, i) => {
            if (dropLines.has(i)) return null
            const lineTrimmed = line.trim()
            if (!lineTrimmed) return line
            if (lineTrimmed.startsWith('#')) {
              // Rewrite URIs in tags like #EXT-X-KEY:...,URI="..." or #EXT-X-MAP:URI='...'
              return lineTrimmed.replace(URI_ATTR, (_, dq, sq, bare) => `URI="${buildChildUrl(dq ?? sq ?? bare)}"`)
            }
            // Non-comment line in M3U8 is a playlist or segment URI
            if (isMedia) {
              const at = segIdx.indexOf(i)
              const nextRaw = at >= 0 && at + 1 < segIdx.length ? lines[segIdx[at + 1]].trim() : null
              return buildChildUrl(lineTrimmed, { seg: true, next: nextRaw ? absOf(nextRaw) : null })
            }
            return buildChildUrl(lineTrimmed)
          })
          .filter((l): l is string => l !== null)
          .join('\n')

        responseHeaders.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8')
        responseHeaders.set('Cache-Control', 'no-store')
        responseHeaders.delete('content-length')
        responseHeaders.delete('content-encoding')
        responseHeaders.delete('Content-Range')
        return new Response(request.method === 'HEAD' ? null : rewrittenText, {
          status: upstreamResponse.status,
          headers: responseHeaders,
        })
      }

      // Anything else (segments, TS, MP4, text): stream through, peeked bytes first.
      responseHeaders.set('Accept-Ranges', 'bytes')
      if (responseHeaders.has('content-encoding')) {
        responseHeaders.delete('content-length')
        responseHeaders.delete('content-encoding')
      }
      let body: BodyInit | null
      if (request.method === 'HEAD' || !reader) {
        body = null
        try {
          await reader?.cancel()
        } catch {}
      } else if (bodyDone) {
        body = peeked
      } else {
        const upstreamReader = reader
        body = new ReadableStream<Uint8Array>({
          start(c) {
            if (peeked.length > 0) c.enqueue(peeked)
          },
          async pull(c) {
            try {
              const { done, value } = await upstreamReader.read()
              if (done) c.close()
              else if (value) c.enqueue(value)
            } catch (err) {
              c.error(err)
            }
          },
          cancel(reason) {
            controller.abort()
            return upstreamReader.cancel(reason).catch(() => {})
          },
        })
      }
      return new Response(body, {
        status: upstreamResponse.status,
        headers: responseHeaders,
      })
    } catch (err: any) {
      clearTimeout(timer)
      lastError = `Candidate ${candidate} error: ${err?.message || err}`
      lastFetchFailure = timedOut || err?.name === 'AbortError' || err?.name === 'TimeoutError'
        ? 'timeout'
        : /blocked|not allowed|forbidden|itself|loop/i.test(String(err?.message || ''))
          ? 'blocked'
          : 'unreachable'
      continue
    }
  }

  const failHeaders: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': '*',
    'Content-Type': 'text/plain',
    'Cache-Control': 'no-store',
  }
  // No upstream response at all: report it as a proxy-side reachability
  // failure (523) rather than a stream verdict; the client treats it as
  // inconclusive.
  if (lastFetchFailure && lastHttpStatus === 0) {
    failHeaders['X-Proxy-Error'] = lastFetchFailure
    return new Response(`Proxy Error: upstream ${lastFetchFailure}. ${lastError || ''}`, { status: 523, headers: failHeaders })
  }
  if (lastHttpStatus === 401 || lastHttpStatus === 403) failHeaders['X-Proxy-Error'] = 'blocked'
  return new Response(`Proxy Error: All candidates failed. ${lastError || ''}`, {
    status: 502,
    headers: failHeaders,
  })
}
