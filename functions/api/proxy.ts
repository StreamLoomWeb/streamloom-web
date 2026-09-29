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

import { PEEK_BYTES, concatBytes, isPlaylistBytes, looksLikeHtml, peekBody, sniffKind } from './_lib/sniff'

/** A VLC-like identity: many IPTV origins allow it and refuse browser UAs. */
const VLC_UA = 'VLC/3.0.20 LibVLC/3.0.20'
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

      const fetchUpstream = (ua: string, ref: string) => {
        const headers = new Headers()
        headers.set('User-Agent', ua)
        if (isVlcUa(ua) && !ref) {
          // VLC never sends a Referer.
        } else {
          headers.set('Referer', ref || parsedTarget.origin)
        }
        if (range) headers.set('Range', range)
        return fetch(parsedTarget.toString(), {
          method: request.method,
          headers,
          redirect: 'follow',
          signal: controller.signal,
        })
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

        let baseStr = upstreamResponse.url
        if (!baseStr || baseStr === 'about:blank') {
          baseStr = parsedTarget.toString()
        }
        const baseUrl = new URL(baseStr)
        const proxyBase = `${urlObj.origin}${urlObj.pathname}`

        const buildChildUrl = (raw: string) => {
          try {
            const absolute = new URL(raw, baseUrl).toString()
            const p = new URLSearchParams()
            p.set('url', absolute)
            if (effUa) p.set('ua', effUa)
            if (effRef) p.set('ref', effRef)
            return `${proxyBase}?${p.toString()}`
          } catch {
            return raw
          }
        }

        const rewrittenText = originalText
          .split(/\r?\n/)
          .map((line) => {
            const lineTrimmed = line.trim()
            if (!lineTrimmed) return line
            if (lineTrimmed.startsWith('#')) {
              // Rewrite URIs in tags like #EXT-X-KEY:...,URI="..." or #EXT-X-MAP:URI='...'
              return lineTrimmed.replace(URI_ATTR, (_, dq, sq, bare) => `URI="${buildChildUrl(dq ?? sq ?? bare)}"`)
            }
            // Non-comment line in M3U8 is a playlist or segment URI
            return buildChildUrl(lineTrimmed)
          })
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
