import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchCatalogueFromR2, fetchR2Meta } from '../api/r2'
import { PICKS_SCHEMA } from '../api/r2Contract'
import type { PickGroup, PicksDocument } from '../api/r2Contract'
import './Admin.css'

/**
 * The author's-picks portal (ADR-0033 §5), at an unlisted `/admin`.
 *
 * Unlisted means: nothing links here, it is in no sitemap, the route is served
 * `X-Robots-Tag: noindex, nofollow` and `Cache-Control: no-store` by
 * `public/_headers`, and the page sets a `robots` meta tag of its own for the
 * crawler that ignores the header. Unlisted is not a security control — the
 * Access application in front of the route is, and the Function behind it
 * verifies the Access JWT itself whatever the route configuration says.
 *
 * Everything this page can do, it does through `/api/picks`, which is
 * authenticated. The page holds no credential of any kind: there is no token in
 * the bundle, no `VITE_` variable for the bucket, and the R2 write capability
 * exists only as a binding on the Function. If the browser is not signed in
 * through Access, every request here simply returns 401 and the page says so.
 *
 * It is one user, so it is plain: labelled inputs, real buttons, a live status
 * line, and no state that is not on screen.
 */

interface Flags {
  closed: string | null
  replacedBy: string | null
  nsfw: boolean
  blocked: string | null
}

interface SearchResult extends Flags {
  id: string
  name: string
  country: string | null
  categories: string[]
}

interface LoadedPicks {
  picks: PicksDocument | null
  etag: string | null
}

type Phase = 'loading' | 'ready' | 'unauthorised' | 'unconfigured' | 'failed'

const EMPTY_GROUPS: PickGroup[] = []
const SEARCH_DEBOUNCE_MS = 250

/** Same ceilings the Function enforces; mirrored so the UI can stop before a 400. */
const MAX_GROUPS = 12
/** Applied to a group whose own limit hasn't been set — the value every group used before this existed. */
const DEFAULT_ITEMS_PER_GROUP = 50
/** Widest a single group's own limit may go (owner request, 2026-09-24: let the admin size each list). */
const MAX_ITEMS_PER_GROUP_CEILING = 200
const MAX_TOTAL_ITEMS = 200
const MAX_NOTE_CHARS = 140
const MAX_TITLE_CHARS = 60

/**
 * A hand-added channel (WO-21): stored shape plus a `localKey` for React identity that never
 * leaves this component. A new entry has no `id` yet — the server assigns one on save
 * (`_lib/customChannelsSchema.ts`) — so `localKey` is what list rendering and removal key on
 * until the next successful save fills `id` in from the response.
 */
interface CustomChannelDraft {
  localKey: string
  id?: string
  name: string
  streamUrl: string
  iconUrl?: string
  country?: string
}

/** Same ceiling `_lib/customChannelsSchema.ts` enforces. */
const MAX_CUSTOM_CHANNELS = 50
const MAX_CUSTOM_NAME_CHARS = 100

const newLocalKey = (): string =>
  typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `local-${Date.now()}-${Math.random()}`

/** Same check the write path makes: this is a URL the player or icon pipeline fetches directly. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function flagLabels(flags: Flags): string[] {
  const out: string[] = []
  if (flags.blocked) out.push(`blocklisted (${flags.blocked})`)
  if (flags.nsfw) out.push('NSFW')
  if (flags.closed) out.push(`closed ${flags.closed}`)
  if (flags.replacedBy) out.push(`replaced by ${flags.replacedBy}`)
  return out
}

/** A channel iptv-org forbids can be seen in the picker but never added (ADR-0033 §4). */
const isRefused = (flags: Flags): boolean => Boolean(flags.blocked) || flags.nsfw

export function Admin() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [problem, setProblem] = useState<string | null>(null)

  const [groups, setGroups] = useState<PickGroup[]>(EMPTY_GROUPS)
  const [etag, setEtag] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)

  const [query, setQuery] = useState('')
  const [country, setCountry] = useState('')
  const [category, setCategory] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [resultTotal, setResultTotal] = useState(0)
  const [searching, setSearching] = useState(false)
  /** Narrows the search to `catalogue/active-channel-ids.json` (WO-21). */
  const [liveOnly, setLiveOnly] = useState(false)
  /** Whether the last response actually applied the filter — the bucket read is best-effort. */
  const [liveFilterApplied, setLiveFilterApplied] = useState(true)

  const [customChannels, setCustomChannels] = useState<CustomChannelDraft[]>([])
  const [customEtag, setCustomEtag] = useState<string | null>(null)
  const [customDirty, setCustomDirty] = useState(false)
  const [customLoadError, setCustomLoadError] = useState<string | null>(null)
  const [customStatus, setCustomStatus] = useState('')
  const [customErrors, setCustomErrors] = useState<string[]>([])
  const [customSaving, setCustomSaving] = useState(false)
  const [newChannelName, setNewChannelName] = useState('')
  const [newStreamUrl, setNewStreamUrl] = useState('')
  const [newIconUrl, setNewIconUrl] = useState('')
  const [newCountry, setNewCountry] = useState('')

  const [targetGroup, setTargetGroup] = useState(0)
  const [newGroupTitle, setNewGroupTitle] = useState('')
  const [newGroupLimit, setNewGroupLimit] = useState(DEFAULT_ITEMS_PER_GROUP)

  const [status, setStatus] = useState<string>('')
  const [warnings, setWarnings] = useState<string[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  /** Channel ids in the live generation, and their names, for the pending/published marks. */
  const [liveIds, setLiveIds] = useState<Set<string> | null>(null)
  const [liveNames, setLiveNames] = useState<Map<string, string>>(new Map())
  const [liveGeneration, setLiveGeneration] = useState<number | null>(null)
  const [liveCategories, setLiveCategories] = useState<string[]>([])
  const [liveCountries, setLiveCountries] = useState<string[]>([])

  // Unlisted: tell a crawler not to index this even if it ignores the header.
  useEffect(() => {
    const previousTitle = document.title
    document.title = 'Picks portal'
    const meta = document.createElement('meta')
    meta.name = 'robots'
    meta.content = 'noindex, nofollow, noarchive'
    document.head.appendChild(meta)
    return () => {
      document.title = previousTitle
      meta.remove()
    }
  }, [])

  const applyLoaded = useCallback((loaded: LoadedPicks) => {
    setGroups(loaded.picks?.groups ?? [])
    setEtag(loaded.etag)
    setUpdatedAt(loaded.picks?.updatedAt ?? null)
    setDirty(false)
  }, [])

  const load = useCallback(async () => {
    setPhase('loading')
    setProblem(null)
    try {
      const res = await fetch('/api/picks', {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      if (res.status === 401 || res.status === 403) {
        setPhase('unauthorised')
        return
      }
      if (res.status === 503) {
        // An unauthenticated 503 carries no detail on purpose (it must not tell a
        // stranger which variable is missing), so the page falls back to pointing
        // at the setup steps rather than inventing a cause.
        const body = (await res.json().catch(() => null)) as { detail?: string } | null
        setProblem(
          body?.detail ??
            'The portal is not configured yet, or this browser is not signed in through Cloudflare Access. See "The author\'s-picks portal" in README.md for the four setup steps.',
        )
        setPhase('unconfigured')
        return
      }
      if (!res.ok) {
        setProblem(`The portal returned ${res.status}.`)
        setPhase('failed')
        return
      }
      const body = (await res.json()) as LoadedPicks
      applyLoaded(body)
      setPhase('ready')
    } catch {
      // A thrown fetch never completed. Besides an outage, that is what an expired Access
      // session looks like: the redirect to the Access login is cross-origin, so CORS
      // blocks it. Say how to sign in again, or "Try again" repeats the same failure.
      setProblem(
        'The portal could not be reached. If your Cloudflare Access session has expired, open /api/picks in a new tab to sign in again, then press "Try again".',
      )
      setPhase('failed')
    }
  }, [applyLoaded])

  // On a microtask, not synchronously: `load` sets state on its first line, and a
  // synchronous setState at the root of an effect is a cascading render (and an
  // oxlint warning, which this project treats as an error).
  useEffect(() => {
    void Promise.resolve().then(load)
  }, [load])

  // The live generation, read through the same public R2 client the site uses.
  // It answers one question only: is this pin already published, or pending
  // until the next sync (ADR-0033 §7)?
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const meta = await fetchR2Meta()
      if (!meta || cancelled) return
      const catalogue = await fetchCatalogueFromR2(meta)
      if (!catalogue || cancelled) return
      const ids = new Set<string>()
      const names = new Map<string, string>()
      const countries = new Set<string>()
      for (const channel of catalogue.channels) {
        ids.add(channel.id)
        names.set(channel.id, channel.name)
        if (channel.country) countries.add(channel.country)
      }
      setLiveIds(ids)
      setLiveNames(names)
      setLiveGeneration(meta.generation)
      setLiveCategories(catalogue.categories.map((c) => c.id).sort())
      setLiveCountries([...countries].sort())
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Search, debounced. An empty form asks for nothing rather than for everything — except
  // "live only" on its own is a real question ("what can I actually pin right now?"), so it
  // counts as something to search for even with no text, country or category typed in.
  const searchSeq = useRef(0)
  useEffect(() => {
    if (phase !== 'ready') return
    const seq = (searchSeq.current += 1)
    // Clearing happens inside the timer too, so nothing sets state synchronously
    // at the root of the effect.
    const timer = setTimeout(() => {
      if (!query.trim() && !country.trim() && !category.trim() && !liveOnly) {
        setResults([])
        setResultTotal(0)
        return
      }
      setSearching(true)
      const params = new URLSearchParams()
      if (query.trim()) params.set('q', query.trim())
      if (country.trim()) params.set('country', country.trim())
      if (category.trim()) params.set('category', category.trim())
      if (liveOnly) params.set('live', 'true')
      fetch(`/api/picks/channels?${params.toString()}`, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(String(res.status))
          return (await res.json()) as { total: number; results: SearchResult[]; live: boolean }
        })
        .then((body) => {
          if (seq !== searchSeq.current) return
          setResults(body.results)
          setResultTotal(body.total)
          setLiveFilterApplied(body.live)
        })
        .catch(() => {
          if (seq !== searchSeq.current) return
          setResults([])
          setResultTotal(0)
        })
        .finally(() => {
          if (seq === searchSeq.current) setSearching(false)
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, country, category, liveOnly, phase])

  // The custom-channels document, loaded once the portal itself is authenticated and ready —
  // same gate as the live-generation read above, but this one needs the Access session, so it
  // cannot run before `phase` says so.
  const loadCustomChannels = useCallback(async () => {
    try {
      const res = await fetch('/api/picks/custom-channels', {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      if (!res.ok) {
        setCustomLoadError(`Custom channels could not be loaded (${res.status}).`)
        return
      }
      const body = (await res.json()) as {
        channels: Omit<CustomChannelDraft, 'localKey'>[]
        etag: string | null
      }
      setCustomChannels(body.channels.map((c) => ({ ...c, localKey: c.id ?? newLocalKey() })))
      setCustomEtag(body.etag)
      setCustomLoadError(null)
      setCustomDirty(false)
    } catch {
      setCustomLoadError('Custom channels could not be reached.')
    }
  }, [])

  useEffect(() => {
    if (phase !== 'ready') return
    // On a microtask, not synchronously: `loadCustomChannels` sets state on its first
    // line, same reason `load` itself is deferred above.
    void Promise.resolve().then(loadCustomChannels)
  }, [phase, loadCustomChannels])

  const addCustomChannel = useCallback(() => {
    const name = newChannelName.trim()
    const streamUrl = newStreamUrl.trim()
    const iconUrl = newIconUrl.trim()
    const country = newCountry.trim()
    if (!name || !streamUrl) return
    if (customChannels.length >= MAX_CUSTOM_CHANNELS) {
      setCustomErrors([`At most ${MAX_CUSTOM_CHANNELS} custom channels.`])
      return
    }
    if (!isHttpUrl(streamUrl)) {
      setCustomErrors(['Stream URL must be a http:// or https:// URL.'])
      return
    }
    if (iconUrl && !isHttpUrl(iconUrl)) {
      setCustomErrors(['Icon URL must be a http:// or https:// URL, or left blank.'])
      return
    }
    setCustomErrors([])
    setCustomChannels((prev) => [
      ...prev,
      {
        localKey: newLocalKey(),
        name,
        streamUrl,
        ...(iconUrl ? { iconUrl } : {}),
        ...(country ? { country: country.toUpperCase() } : {}),
      },
    ])
    setCustomDirty(true)
    setCustomStatus('')
    setNewChannelName('')
    setNewStreamUrl('')
    setNewIconUrl('')
    setNewCountry('')
  }, [customChannels.length, newChannelName, newCountry, newIconUrl, newStreamUrl])

  const removeCustomChannel = useCallback((localKey: string) => {
    setCustomChannels((prev) => prev.filter((c) => c.localKey !== localKey))
    setCustomDirty(true)
    setCustomStatus('')
  }, [])

  const saveCustomChannels = useCallback(async () => {
    setCustomSaving(true)
    setCustomErrors([])
    setCustomStatus('Saving…')
    try {
      const body = {
        schema: 1,
        channels: customChannels.map(({ localKey: _localKey, ...rest }) => rest),
      }
      const res = await fetch('/api/picks/custom-channels', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(customEtag ? { 'if-match': customEtag } : {}),
        },
        body: JSON.stringify(body),
      })
      const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null

      if (res.status === 412) {
        setCustomErrors([
          String(payload?.detail ?? 'Someone else saved a newer copy.') +
            ' The newer copy has been loaded; re-apply your changes and save again.',
        ])
        const channels = (payload?.channels as Omit<CustomChannelDraft, 'localKey'>[] | undefined) ?? []
        setCustomChannels(channels.map((c) => ({ ...c, localKey: c.id ?? newLocalKey() })))
        setCustomEtag((payload?.etag as string | null) ?? null)
        setCustomStatus('Not saved: a newer copy was loaded.')
        return
      }
      if (res.status === 401 || res.status === 403) {
        setPhase('unauthorised')
        return
      }
      if (!res.ok) {
        const list = Array.isArray(payload?.errors) ? (payload.errors as string[]) : []
        setCustomErrors(list.length > 0 ? list : [String(payload?.detail ?? `The save failed (${res.status}).`)])
        setCustomStatus('Not saved.')
        return
      }

      const channels = (payload?.channels as Omit<CustomChannelDraft, 'localKey'>[] | undefined) ?? []
      setCustomChannels(channels.map((c) => ({ ...c, localKey: c.id ?? newLocalKey() })))
      setCustomEtag((payload?.etag as string) ?? null)
      setCustomDirty(false)
      setCustomStatus(`Saved at ${String(payload?.updatedAt ?? 'now')}.`)
    } catch {
      setCustomErrors(['The save could not be sent.'])
      setCustomStatus('Not saved.')
    } finally {
      setCustomSaving(false)
    }
  }, [customChannels, customEtag])

  const totalItems = useMemo(
    () => groups.reduce((n, group) => n + group.items.length, 0),
    [groups],
  )

  const pinnedIds = useMemo(() => {
    const set = new Set<string>()
    for (const group of groups) for (const item of group.items) set.add(item.channelId)
    return set
  }, [groups])

  const mutate = useCallback((next: PickGroup[]) => {
    setGroups(next)
    setDirty(true)
    setStatus('')
  }, [])

  const addGroup = useCallback(() => {
    const title = newGroupTitle.trim()
    if (!title) return
    if (groups.length >= MAX_GROUPS) return
    if (groups.some((g) => g.title.toLowerCase() === title.toLowerCase())) {
      setErrors([`There is already a group called "${title}".`])
      return
    }
    const limit = Math.min(Math.max(Math.trunc(newGroupLimit) || 1, 1), MAX_ITEMS_PER_GROUP_CEILING)
    setErrors([])
    mutate([...groups, { title, items: [], limit }])
    setTargetGroup(groups.length)
    setNewGroupTitle('')
    setNewGroupLimit(DEFAULT_ITEMS_PER_GROUP)
  }, [groups, mutate, newGroupTitle, newGroupLimit])

  /** A list's limit can be raised or lowered after creation too — a typo at creation is not a dead end. */
  const setGroupLimit = useCallback(
    (index: number, limit: number) => {
      const clamped = Math.min(Math.max(Math.trunc(limit) || 1, 1), MAX_ITEMS_PER_GROUP_CEILING)
      mutate(groups.map((g, i) => (i === index ? { ...g, limit: clamped } : g)))
    },
    [groups, mutate],
  )

  const removeGroup = useCallback(
    (index: number) => {
      mutate(groups.filter((_, i) => i !== index))
      setTargetGroup((current) => (current >= index && current > 0 ? current - 1 : current))
    },
    [groups, mutate],
  )

  const moveGroup = useCallback(
    (index: number, delta: number) => {
      const to = index + delta
      if (to < 0 || to >= groups.length) return
      const next = [...groups]
      const [moved] = next.splice(index, 1)
      next.splice(to, 0, moved)
      mutate(next)
    },
    [groups, mutate],
  )

  const addPick = useCallback(
    (channel: SearchResult) => {
      if (isRefused(channel)) return
      const group = groups[targetGroup]
      if (!group) {
        setErrors(['Create a group first, then add channels to it.'])
        return
      }
      if (group.items.some((item) => item.channelId === channel.id)) return
      const groupLimit = group.limit ?? DEFAULT_ITEMS_PER_GROUP
      if (group.items.length >= groupLimit) {
        setErrors([`"${group.title}" already has the maximum of ${groupLimit} channels.`])
        return
      }
      if (totalItems >= MAX_TOTAL_ITEMS) {
        setErrors([`At most ${MAX_TOTAL_ITEMS} pinned channels in total.`])
        return
      }
      setErrors([])
      mutate(
        groups.map((g, i) =>
          i === targetGroup ? { ...g, items: [...g.items, { channelId: channel.id }] } : g,
        ),
      )
    },
    [groups, mutate, targetGroup, totalItems],
  )

  /** Removal is the only way a pin ends (ADR-0033 §2). */
  const removePick = useCallback(
    (groupIndex: number, channelId: string) => {
      mutate(
        groups.map((g, i) =>
          i === groupIndex ? { ...g, items: g.items.filter((it) => it.channelId !== channelId) } : g,
        ),
      )
    },
    [groups, mutate],
  )

  const movePick = useCallback(
    (groupIndex: number, itemIndex: number, delta: number) => {
      const group = groups[groupIndex]
      const to = itemIndex + delta
      if (!group || to < 0 || to >= group.items.length) return
      const items = [...group.items]
      const [moved] = items.splice(itemIndex, 1)
      items.splice(to, 0, moved)
      mutate(groups.map((g, i) => (i === groupIndex ? { ...g, items } : g)))
    },
    [groups, mutate],
  )

  const setNote = useCallback(
    (groupIndex: number, channelId: string, note: string) => {
      mutate(
        groups.map((g, i) =>
          i === groupIndex
            ? {
                ...g,
                items: g.items.map((item) =>
                  item.channelId === channelId
                    ? note.trim()
                      ? { ...item, note: note.slice(0, MAX_NOTE_CHARS) }
                      : { channelId: item.channelId, ...(item.rank !== undefined ? { rank: item.rank } : {}) }
                    : item,
                ),
              }
            : g,
        ),
      )
    },
    [groups, mutate],
  )

  const save = useCallback(async () => {
    setSaving(true)
    setErrors([])
    setWarnings([])
    setStatus('Saving…')
    try {
      // `rank` is the author's order made explicit, so a reader that does not
      // preserve array order still shows the row the way it was built.
      const body = {
        schema: PICKS_SCHEMA,
        groups: groups.map((group) => ({
          title: group.title,
          ...(group.limit !== undefined ? { limit: group.limit } : {}),
          items: group.items.map((item, index) => ({
            channelId: item.channelId,
            ...(item.note ? { note: item.note } : {}),
            rank: index,
          })),
        })),
      }
      const res = await fetch('/api/picks', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(etag ? { 'if-match': etag } : {}),
        },
        body: JSON.stringify(body),
      })
      const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null

      if (res.status === 412) {
        setErrors([
          String(payload?.detail ?? 'Someone else saved a newer copy.') +
            ' The newer copy has been loaded; re-apply your changes and save again.',
        ])
        applyLoaded({
          picks: (payload?.picks as PicksDocument | null) ?? null,
          etag: (payload?.etag as string | null) ?? null,
        })
        setStatus('Not saved: a newer copy was loaded.')
        return
      }
      if (res.status === 401 || res.status === 403) {
        setPhase('unauthorised')
        return
      }
      if (!res.ok) {
        const list = Array.isArray(payload?.errors) ? (payload.errors as string[]) : []
        setErrors(list.length > 0 ? list : [String(payload?.detail ?? `The save failed (${res.status}).`)])
        setStatus('Not saved.')
        return
      }

      setEtag(String(payload?.etag ?? '') || null)
      setUpdatedAt(String(payload?.updatedAt ?? '') || null)
      setWarnings(Array.isArray(payload?.warnings) ? (payload.warnings as string[]) : [])
      setDirty(false)
      setStatus(
        `Saved at ${String(payload?.updatedAt ?? 'now')}. Published pins appear on the site within about a minute; pending ones at the next sync.`,
      )
    } catch {
      setErrors(['The save could not be sent.'])
      setStatus('Not saved.')
    } finally {
      setSaving(false)
    }
  }, [applyLoaded, etag, groups])

  if (phase === 'loading') {
    return (
      <main className="admin">
        <p className="admin__status" role="status">
          Loading the portal…
        </p>
      </main>
    )
  }

  if (phase === 'unauthorised') {
    return (
      <main className="admin">
        <h1 className="admin__heading">Picks portal</h1>
        <p className="admin__problem">
          This browser is not signed in through Cloudflare Access, or the session has expired.{' '}
          Sign in at{' '}
          <a href="/api/picks" target="_blank" rel="noopener noreferrer">
            /api/picks
          </a>{' '}
          — it needs its own Cloudflare Access sign-in, same as this page does — then come back and
          press &quot;Try again&quot;.
        </p>
        <button className="admin__btn" onClick={() => void load()}>
          Try again
        </button>
      </main>
    )
  }

  if (phase === 'unconfigured' || phase === 'failed') {
    return (
      <main className="admin">
        <h1 className="admin__heading">Picks portal</h1>
        <p className="admin__problem">{problem}</p>
        <button className="admin__btn" onClick={() => void load()}>
          Try again
        </button>
      </main>
    )
  }

  return (
    <main className="admin">
      <h1 className="admin__heading">Picks portal</h1>
      <p className="admin__sub">
        {totalItems} pinned channel{totalItems === 1 ? '' : 's'} in {groups.length} group
        {groups.length === 1 ? '' : 's'}
        {updatedAt ? ` · last saved ${updatedAt}` : ' · never saved'}
        {liveGeneration !== null ? ` · live generation g${liveGeneration}` : ''}
      </p>

      <p className="admin__status" role="status" aria-live="polite">
        {status}
      </p>
      {errors.length > 0 && (
        <ul className="admin__errors" aria-label="Problems">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      {warnings.length > 0 && (
        <ul className="admin__warnings" aria-label="Warnings">
          {warnings.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}

      <div className="admin__actions">
        <button className="admin__btn admin__btn--primary" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save picks'}
        </button>
        <button className="admin__btn" onClick={() => void load()} disabled={saving}>
          Discard and reload
        </button>
        {dirty && <span className="admin__dirty">Unsaved changes</span>}
      </div>

      <section className="admin__panel" aria-labelledby="admin-groups-heading">
        <h2 id="admin-groups-heading">Groups</h2>
        <p className="admin__hint">
          Each group's channel limit defaults to {DEFAULT_ITEMS_PER_GROUP} and can be set up to{' '}
          {MAX_ITEMS_PER_GROUP_CEILING} — at creation, or any time after from the group's own "Limit" field.
        </p>

        <div className="admin__field-row">
          <label className="admin__label" htmlFor="admin-new-group">
            New group title
          </label>
          <input
            id="admin-new-group"
            className="admin__input"
            value={newGroupTitle}
            maxLength={MAX_TITLE_CHARS}
            placeholder="e.g. News, Sport, Late night"
            onChange={(e) => setNewGroupTitle(e.target.value)}
          />
          <label className="admin__label" htmlFor="admin-new-group-limit">
            Channel limit
          </label>
          <input
            id="admin-new-group-limit"
            className="admin__input admin__input--short"
            type="number"
            min={1}
            max={MAX_ITEMS_PER_GROUP_CEILING}
            value={newGroupLimit}
            onChange={(e) => setNewGroupLimit(Number(e.target.value))}
          />
          <button
            className="admin__btn"
            onClick={addGroup}
            disabled={!newGroupTitle.trim() || groups.length >= MAX_GROUPS}
          >
            Add group
          </button>
        </div>

        {groups.length === 0 && <p className="admin__empty">No groups yet. Add one to start pinning.</p>}

        {groups.map((group, groupIndex) => (
          <article className="admin__group" key={group.title}>
            <header className="admin__group-head">
              <h3>{group.title}</h3>
              <span className="admin__pill">
                {group.items.length} / {group.limit ?? DEFAULT_ITEMS_PER_GROUP}
              </span>
              <label className="admin__target">
                Limit
                <input
                  className="admin__input admin__input--short"
                  type="number"
                  min={1}
                  max={MAX_ITEMS_PER_GROUP_CEILING}
                  value={group.limit ?? DEFAULT_ITEMS_PER_GROUP}
                  aria-label={`Channel limit for ${group.title}`}
                  onChange={(e) => setGroupLimit(groupIndex, Number(e.target.value))}
                />
              </label>
              <button
                className="admin__btn admin__btn--small"
                onClick={() => moveGroup(groupIndex, -1)}
                disabled={groupIndex === 0}
                aria-label={`Move group ${group.title} up`}
              >
                ↑
              </button>
              <button
                className="admin__btn admin__btn--small"
                onClick={() => moveGroup(groupIndex, 1)}
                disabled={groupIndex === groups.length - 1}
                aria-label={`Move group ${group.title} down`}
              >
                ↓
              </button>
              <button
                className="admin__btn admin__btn--small"
                onClick={() => removeGroup(groupIndex)}
                aria-label={`Remove group ${group.title}`}
              >
                Remove group
              </button>
              <label className="admin__target">
                <input
                  type="radio"
                  name="admin-target-group"
                  checked={targetGroup === groupIndex}
                  onChange={() => setTargetGroup(groupIndex)}
                />
                Add search results here
              </label>
            </header>

            {group.items.length === 0 && (
              <p className="admin__empty">Empty. An empty group is not shown on the site.</p>
            )}

            <ol className="admin__picks">
              {group.items.map((item, itemIndex) => {
                const published = liveIds?.has(item.channelId) ?? null
                const name = liveNames.get(item.channelId) ?? item.channelId
                return (
                  <li className="admin__pick" key={item.channelId}>
                    <div className="admin__pick-main">
                      <span className="admin__pick-name">{name}</span>
                      <code className="admin__pick-id">{item.channelId}</code>
                      {published === null ? (
                        <span className="admin__tag">generation unknown</span>
                      ) : published ? (
                        <span className="admin__tag admin__tag--live">in the live generation</span>
                      ) : (
                        <span className="admin__tag admin__tag--pending">pending until the next sync</span>
                      )}
                    </div>
                    <label className="admin__note-label">
                      <span className="admin__visually-hidden">Note for {name}</span>
                      <input
                        className="admin__input admin__input--note"
                        value={item.note ?? ''}
                        maxLength={MAX_NOTE_CHARS}
                        placeholder="Note (optional)"
                        onChange={(e) => setNote(groupIndex, item.channelId, e.target.value)}
                      />
                    </label>
                    <div className="admin__pick-actions">
                      <button
                        className="admin__btn admin__btn--small"
                        onClick={() => movePick(groupIndex, itemIndex, -1)}
                        disabled={itemIndex === 0}
                        aria-label={`Move ${name} up`}
                      >
                        ↑
                      </button>
                      <button
                        className="admin__btn admin__btn--small"
                        onClick={() => movePick(groupIndex, itemIndex, 1)}
                        disabled={itemIndex === group.items.length - 1}
                        aria-label={`Move ${name} down`}
                      >
                        ↓
                      </button>
                      <button
                        className="admin__btn admin__btn--small"
                        onClick={() => removePick(groupIndex, item.channelId)}
                        aria-label={`Remove ${name}`}
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                )
              })}
            </ol>
          </article>
        ))}
      </section>

      <section className="admin__panel" aria-labelledby="admin-search-heading">
        <h2 id="admin-search-heading">Find a channel</h2>
        <p className="admin__hint">
          Searches the whole iptv-org channel list, not only what is published. Blocklisted and NSFW
          channels are shown so you can see why they are unavailable; they cannot be pinned.
        </p>

        <div className="admin__field-row">
          <label className="admin__label" htmlFor="admin-q">
            Name or id
          </label>
          <input
            id="admin-q"
            className="admin__input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. BBC News"
          />

          <label className="admin__label" htmlFor="admin-country">
            Country
          </label>
          <input
            id="admin-country"
            className="admin__input admin__input--short"
            value={country}
            list="admin-countries"
            onChange={(e) => setCountry(e.target.value)}
            placeholder="GB"
          />
          <datalist id="admin-countries">
            {liveCountries.map((code) => (
              <option key={code} value={code} />
            ))}
          </datalist>

          <label className="admin__label" htmlFor="admin-category">
            Category
          </label>
          <input
            id="admin-category"
            className="admin__input admin__input--short"
            value={category}
            list="admin-categories"
            onChange={(e) => setCategory(e.target.value)}
            placeholder="news"
          />
          <datalist id="admin-categories">
            {liveCategories.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>

          <label className="admin__target">
            <input
              type="checkbox"
              checked={liveOnly}
              onChange={(e) => setLiveOnly(e.target.checked)}
            />
            Live only
          </label>
        </div>

        <p className="admin__status" role="status" aria-live="polite">
          {searching
            ? 'Searching…'
            : resultTotal > 0
              ? `${resultTotal} match${resultTotal === 1 ? '' : 'es'}, showing ${results.length}`
              : ''}
        </p>
        {liveOnly && !searching && !liveFilterApplied && (
          <p className="admin__hint">
            The live filter is unavailable right now — showing every match instead.
          </p>
        )}

        <ul className="admin__results">
          {results.map((channel) => {
            const flags = flagLabels(channel)
            const refused = isRefused(channel)
            const already = pinnedIds.has(channel.id)
            return (
              <li className="admin__result" key={channel.id}>
                <div className="admin__pick-main">
                  <span className="admin__pick-name">{channel.name}</span>
                  <code className="admin__pick-id">{channel.id}</code>
                  {channel.country && <span className="admin__tag">{channel.country}</span>}
                  {channel.categories.slice(0, 3).map((c) => (
                    <span className="admin__tag" key={c}>
                      {c}
                    </span>
                  ))}
                  {flags.map((label) => (
                    <span
                      className={`admin__tag ${refused ? 'admin__tag--refused' : 'admin__tag--warn'}`}
                      key={label}
                    >
                      {label}
                    </span>
                  ))}
                  {liveIds?.has(channel.id) ? (
                    <span className="admin__tag admin__tag--live">in the live generation</span>
                  ) : (
                    <span className="admin__tag admin__tag--pending">pending until the next sync</span>
                  )}
                </div>
                <button
                  className="admin__btn admin__btn--small"
                  onClick={() => addPick(channel)}
                  disabled={refused || already || groups.length === 0}
                  title={
                    refused
                      ? 'iptv-org forbids this channel'
                      : already
                        ? 'Already pinned'
                        : groups.length === 0
                          ? 'Add a group first'
                          : undefined
                  }
                >
                  {already ? 'Pinned' : refused ? 'Not allowed' : 'Add'}
                </button>
              </li>
            )
          })}
        </ul>
      </section>

      <section className="admin__panel" aria-labelledby="admin-custom-heading">
        <h2 id="admin-custom-heading">Custom channels</h2>
        <p className="admin__hint">
          Channels outside the iptv-org list. The stream URL is not checked — you vouch for it.
          Up to {MAX_CUSTOM_CHANNELS}, and they publish on the next sync without going through the
          usual stream check (WO-21).
        </p>

        {customLoadError && <p className="admin__problem">{customLoadError}</p>}

        {customStatus && (
          <p className="admin__status" role="status" aria-live="polite">
            {customStatus}
          </p>
        )}
        {customErrors.length > 0 && (
          <ul className="admin__errors" aria-label="Problems">
            {customErrors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        )}

        <div className="admin__actions">
          <button
            className="admin__btn admin__btn--primary"
            onClick={() => void saveCustomChannels()}
            disabled={customSaving || !customDirty}
          >
            {customSaving ? 'Saving…' : 'Save custom channels'}
          </button>
          <button
            className="admin__btn"
            onClick={() => void loadCustomChannels()}
            disabled={customSaving}
          >
            Discard and reload
          </button>
          {customDirty && <span className="admin__dirty">Unsaved changes</span>}
        </div>

        {customChannels.length === 0 && (
          <p className="admin__empty">No custom channels yet. Add one below.</p>
        )}

        <ol className="admin__picks">
          {customChannels.map((channel) => {
            const published = channel.id ? (liveIds?.has(channel.id) ?? null) : false
            return (
              <li className="admin__pick" key={channel.localKey}>
                <div className="admin__pick-main">
                  <span className="admin__pick-name">{channel.name}</span>
                  {channel.id ? (
                    <code className="admin__pick-id">{channel.id}</code>
                  ) : (
                    <span className="admin__tag admin__tag--pending">not yet saved</span>
                  )}
                  {channel.country && <span className="admin__tag">{channel.country}</span>}
                  {channel.id &&
                    (published === null ? (
                      <span className="admin__tag">generation unknown</span>
                    ) : published ? (
                      <span className="admin__tag admin__tag--live">in the live generation</span>
                    ) : (
                      <span className="admin__tag admin__tag--pending">pending until the next sync</span>
                    ))}
                </div>
                <button
                  className="admin__btn admin__btn--small"
                  onClick={() => removeCustomChannel(channel.localKey)}
                  aria-label={`Remove ${channel.name}`}
                >
                  Remove
                </button>
              </li>
            )
          })}
        </ol>

        <div className="admin__field-row">
          <label className="admin__label" htmlFor="admin-custom-name">
            Name
          </label>
          <input
            id="admin-custom-name"
            className="admin__input"
            value={newChannelName}
            maxLength={MAX_CUSTOM_NAME_CHARS}
            placeholder="e.g. Community Radio TV"
            onChange={(e) => setNewChannelName(e.target.value)}
          />

          <label className="admin__label" htmlFor="admin-custom-url">
            Stream URL
          </label>
          <input
            id="admin-custom-url"
            className="admin__input"
            value={newStreamUrl}
            placeholder="https://example.com/stream.m3u8"
            onChange={(e) => setNewStreamUrl(e.target.value)}
          />

          <label className="admin__label" htmlFor="admin-custom-icon">
            Icon URL
          </label>
          <input
            id="admin-custom-icon"
            className="admin__input"
            value={newIconUrl}
            placeholder="Optional"
            onChange={(e) => setNewIconUrl(e.target.value)}
          />

          <label className="admin__label" htmlFor="admin-custom-country">
            Country
          </label>
          <input
            id="admin-custom-country"
            className="admin__input admin__input--short"
            value={newCountry}
            list="admin-countries"
            placeholder="Optional"
            onChange={(e) => setNewCountry(e.target.value)}
          />

          <button
            className="admin__btn"
            onClick={addCustomChannel}
            disabled={!newChannelName.trim() || !newStreamUrl.trim() || customChannels.length >= MAX_CUSTOM_CHANNELS}
          >
            Add channel
          </button>
        </div>
      </section>
    </main>
  )
}
