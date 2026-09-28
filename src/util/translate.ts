import { useSyncExternalStore } from 'react'


/**
 * Program-title translation for the TV guide.
 *
 * Titles arrive in the broadcaster's own language and script, which makes a
 * multi-language guide hard to scan. Translation is opt-in: the caller turns it
 * on and this module resolves English text for a batch of titles, then keeps it
 * in a two-level cache so a title is never translated twice.
 *
 * Level 1 is an in-memory Map (per session), level 2 is localStorage (survives
 * reloads). Both are keyed by the source text, so repeated titles — and the same
 * title across channels — cost one lookup.
 *
 * The network side talks to a LibreTranslate-compatible endpoint, falling back
 * to the public MyMemory API when no endpoint is configured. Both are plain
 * JSON over HTTPS, so no SDK is involved. Failures are silent for the offending
 * title: the guide keeps the original string rather than retrying forever.
 */

/** Vite injects `import.meta.env`; guard so the module also loads under Node. */
const ENV: Record<string, string | undefined> =
  (import.meta as { env?: Record<string, string | undefined> }).env ?? {}

/** Optional self-hosted / configured endpoint. Empty means "use MyMemory". */
const TRANSLATE_URL = (
  ENV.VITE_TRANSLATE_URL ||
  ENV.VITE_LIBRETRANSLATE_URL ||
  ''
).replace(/\/$/, '')

const TRANSLATE_API_KEY = ENV.VITE_TRANSLATE_API_KEY || ''

const STORAGE_KEY = 'sl_epg_translations_v1'

/** Titles cached on disk before the oldest entries are dropped. */
const DISK_LIMIT = 600

/** Requests are coalesced into one call this long after the last enqueue. */
const DEBOUNCE_MS = 220

/** Concurrent translation requests allowed at once. */
const MAX_INFLIGHT = 3

/** Per-request timeout. A stalled provider must not hold the guide hostage. */
const REQUEST_TIMEOUT_MS = 8000

// ---- Cache ----

const memory = new Map<string, string>()

/** Bumped whenever cached results or the toggle change. */
let _version = 0
let _enabled = false
const listeners = new Set<() => void>()

try {
  _enabled = localStorage.getItem('sl_epg_translate') === 'true'
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw) {
    const parsed = JSON.parse(raw) as Record<string, string>
    for (const [source, translated] of Object.entries(parsed)) {
      memory.set(source, translated)
    }
  }
} catch {
  // Cache is best-effort; a corrupt entry must never break the guide.
}

function notify() {
  _version += 1
  listeners.forEach((fn) => fn())
}

/** Subscribes to translation-state changes (toggle on/off, new results). */
export function onTranslationChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Subscribes to the translation store and returns the current version.
 *
 * Exposed as a hook so components can derive a translated title during render
 * instead of writing it to state from an effect — the latter costs an extra
 * render pass for every translated programme on screen.
 */
export function useTranslationVersion(): number {
  return useSyncExternalStore(subscribeTranslation, getTranslationVersion, getTranslationVersion)
}

/** Stable subscribe callback for `useSyncExternalStore`. */
function subscribeTranslation(fn: () => void): () => void {
  return onTranslationChange(fn)
}

/** Current state version, so React can detect cache writes without polling. */
export function getTranslationVersion(): number {
  return _version
}

/** True when translated titles are being shown. */
export function isTranslationEnabled(): boolean {
  return _enabled
}

/**
 * Reactive read of the global "Translate to English" preference, for any
 * surface that renders an EPG-sourced title (channel tiles, the hero, the
 * guide, the player). Re-renders the caller when the toggle flips or a title
 * it's waiting on lands, so every surface stays in sync off one flag.
 */
export function useTranslateEnabled(): boolean {
  useTranslationVersion()
  return isTranslationEnabled()
}

/** Turns translation on or off and persists the choice. */
export function setTranslationEnabled(enabled: boolean) {
  if (_enabled === enabled) return
  _enabled = enabled
  try {
    if (enabled) localStorage.setItem('sl_epg_translate', 'true')
    else localStorage.removeItem('sl_epg_translate')
  } catch {
    // Private-mode storage denials are non-fatal.
  }
  if (enabled) flush()
  notify()
}

// ---- Script / language heuristics ----

/**
 * Non-Latin scripts. Anything in these ranges is unambiguously not English, so
 * it always qualifies for translation.
 */
const NON_LATIN = /[\u0600-\u06FF\u0750-\u077F\u0400-\u04FF\u0590-\u05FF\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u0A80-\u0AFF\u0B00-\u0B7F\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0D00-\u0D7F\u0E00-\u0E7F\u0E80-\u0EFF\u0F00-\u0FFF\u1000-\u109F\u1780-\u17FF\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/

/** Words that only appear in English titles; used to skip already-English text. */
const ENGLISH_HINTS = new Set([
  'the', 'and', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'news',
  'live', 'show', 'movie', 'world', 'life', 'day', 'night', 'new', 'tv',
  'channel', 'story', 'love', 'family', 'sport', 'sports', 'music', 'today',
])

/** Function words that are not also English words, grouped by language. */
const NON_ENGLISH_HINTS = new Set([
  'le', 'la', 'les', 'des', 'du', 'une', 'et', 'avec', 'pour', 'dans',
  'der', 'die', 'das', 'und', 'mit', 'fur', 'fuer', 'ein', 'eine',
  'los', 'las', 'una', 'con', 'para', 'del', 'que', 'por',
  'os', 'um', 'com', 'nao', 'da', 'do', 'dos', 'das',
  'het', 'een', 'van', 'il', 'lo', 'gli', 'della', 'che', 'non',
])

/**
 * Cheap gate in front of the network call. Non-Latin scripts always qualify;
 * Latin text qualifies only when it looks like a non-English European language,
 * detected from diacritics and common function words. Spanish and Portuguese
 * titles that look English are a known miss, but a false positive only costs
 * one cached lookup.
 */
export function needsTranslation(title: string): boolean {
  const text = title.trim()
  if (text.length < 2) return false
  if (NON_LATIN.test(text)) return true

  const words = text.toLowerCase().split(/[^a-z\u00e0-\u00ff]+/).filter(Boolean)
  if (words.length === 0) return false
  if (words.some((w) => ENGLISH_HINTS.has(w))) return false

  // Diacritics in a mostly-ASCII title almost always means a Latin language
  // other than English (Portuguese, Turkish, Vietnamese, Polish, ...).
  if (/[\u00e0-\u00f6\u00f8-\u00ff]/i.test(text)) return true

  return words.some((w) => NON_ENGLISH_HINTS.has(w))
}

/** Returns the cached English title, or null when it is not translated yet. */
export function getTranslation(title: string): string | null {
  return memory.get(title) ?? null
}

// ---- Persistence ----

let diskTimer: ReturnType<typeof setTimeout> | null = null

function persist() {
  if (diskTimer) return
  diskTimer = setTimeout(() => {
    diskTimer = null
    try {
      const trimmed = [...memory.entries()].slice(-DISK_LIMIT)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(trimmed)))
    } catch {
      // Quota errors are non-fatal; the memory cache still serves this session.
    }
  }, 1000)
}

// ---- Network ----

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fn(controller.signal)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** LibreTranslate-compatible call. Returns null on any failure. */
async function translateViaEndpoint(texts: string[]): Promise<string[] | null> {
  if (!TRANSLATE_URL) return null
  const result = await withTimeout(async (signal) => {
    const res = await fetch(TRANSLATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: texts,
        source: 'auto',
        target: 'en',
        format: 'text',
        ...(TRANSLATE_API_KEY ? { api_key: TRANSLATE_API_KEY } : {}),
      }),
      signal,
    })
    if (!res.ok) throw new Error('translate endpoint failed')
    const body = (await res.json()) as {
      translatedText?: string | string[]
      error?: string
    }
    if (body.error) throw new Error(body.error)
    const out = body.translatedText
    if (Array.isArray(out)) return out
    return typeof out === 'string' ? [out] : null
  })
  return result && result.length === texts.length ? result : null
}

/**
 * MyMemory fallback: one GET per title, which is why it is only used when no
 * endpoint is configured and why callers batch and cache aggressively.
 */
async function translateViaMyMemory(texts: string[]): Promise<(string | null)[] | null> {
  const results = await Promise.all(
    texts.map((text) =>
      withTimeout(async (signal) => {
        const url =
          'https://api.mymemory.translated.net/get?q=' +
          encodeURIComponent(text) +
          '&langpair=autodetect|en'
        const res = await fetch(url, { signal })
        if (!res.ok) throw new Error('mymemory failed')
        const body = (await res.json()) as {
          responseData?: { translatedText?: string }
        }
        const out = body.responseData?.translatedText
        // MyMemory echoes the query back when it has no match; treat as a miss.
        if (!out || out.trim().toUpperCase() === text.trim().toUpperCase()) return null
        return out.trim()
      }),
    ),
  )
  return results.some((r) => r !== null) ? results : null
}

/** Resolves English titles for a batch, skipping the API for cached titles. */
async function translateBatch(texts: string[]): Promise<(string | null)[]> {
  const pending = texts.filter((t) => !memory.has(t) && needsTranslation(t))
  if (pending.length === 0) return texts.map((t) => memory.get(t) ?? null)

  const translated =
    (await translateViaEndpoint(pending)) ?? (await translateViaMyMemory(pending))

  if (translated) {
    pending.forEach((source, i) => {
      const value = translated[i]
      if (value && value.trim() && value !== source) memory.set(source, value.trim())
    })
    persist()
  }
  return texts.map((t) => memory.get(t) ?? null)
}

// ---- Queue ----

/** Titles waiting to be translated, in request order. */
const queue = new Set<string>()
let queueTimer: ReturnType<typeof setTimeout> | null = null
let inflight = 0

async function drainQueue() {
  if (inflight >= MAX_INFLIGHT || queue.size === 0) return

  const batch = [...queue].slice(0, 25)
  batch.forEach((t) => queue.delete(t))
  inflight += 1

  try {
    const result = await translateBatch(batch)
    // Only wake subscribers when something was actually learned.
    if (result.some((r) => r !== null)) notify()
  } finally {
    inflight -= 1
    if (queue.size > 0) scheduleDrain()
  }
}

function scheduleDrain() {
  if (queueTimer) return
  queueTimer = setTimeout(() => {
    queueTimer = null
    // Top up all available slots.
    for (let i = 0; i < MAX_INFLIGHT - inflight; i += 1) drainQueue()
  }, DEBOUNCE_MS)
}

/** Flushes the queue immediately (used when the toggle flips on). */
function flush() {
  if (queueTimer) {
    clearTimeout(queueTimer)
    queueTimer = null
  }
  for (let i = 0; i < MAX_INFLIGHT - inflight; i += 1) drainQueue()
}

/**
 * Requests English titles for `titles`.
 *
 * Cached results short-circuit, so calling this on every render is safe: only
 * titles that are neither cached nor already queued incur work. Results land in
 * the store, which subscribers observe through `useTranslationVersion`.
 */
export function requestTranslations(titles: string[]): void {
  if (!_enabled || titles.length === 0) return

  let queued = false
  for (const title of titles) {
    if (memory.has(title) || queue.has(title)) continue
    if (!needsTranslation(title)) continue
    queue.add(title)
    queued = true
  }

  if (queued) scheduleDrain()
}

/** Clears both cache levels. Exposed for the Settings cache reset. */
export function clearTranslationCache() {
  memory.clear()
  queue.clear()
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Ignore storage denials.
  }
  notify()
}

