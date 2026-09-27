import { useEffect, useMemo, useRef, useState } from 'react'
import { ChannelCard } from './ChannelCard'
import { fetchFastTrackFromR2, fetchPicksFromR2 } from '../api/r2'
import { orderPickItems } from '../api/r2Contract'
import type { FastTrackEntry, PickItem, PicksDocument } from '../api/r2Contract'
import type { EnrichedChannel } from '../hooks/useChannels'
import type { Stream } from '../api/types'
import './PicksRow.css'

/**
 * The author's-picks rows (ADR-0033 §3).
 *
 * The one rule that matters here: **a pinned channel is never hidden**. Not by a
 * broken-stream mark, not by the user's own hide-broken or auto-skip settings,
 * not by having no stream at all. Removal is the author's act in the portal and
 * nothing else. That is why this component takes `channels` from `allChannels` —
 * the list before `useChannels` applies the hidden and broken filters — and why
 * it never consults `getBrokenSet`, `getHiddenSet` or the settings that drive
 * them. The stream-failure rules of WO-11 are untouched: a pinned channel that
 * fails still records its failure and still marks itself broken; the mark simply
 * does not remove it from this row.
 *
 * A pin whose channel has no stream is shown, greyed, labelled "No stream
 * available" — it is what the author asked for and it is honest about the state.
 *
 * A pin not in the live generation resolves two ways, in order:
 *
 * 1. **A fast-track entry (ADR-0043, WO-19)** — a real, probed stream a narrow backend job
 *    found within seconds of the save, before the next scheduled sync. Rendered exactly like a
 *    live-generation match: playable, no "pending" label, because it carries a verdict as real
 *    as the scheduled sync's own.
 * 2. **The identity snapshot the portal saved alongside the pin (ADR-0042)** — name, country,
 *    categories, no stream, no logo — when there is no fast-track entry yet either. Labelled
 *    "Not yet in the catalogue" rather than "No stream available": the two are different facts
 *    (one may still get a stream; the other has been probed and genuinely has none), and
 *    conflating them would tell the author their save did nothing.
 *
 * A pin with none of the three — only possible for a document saved before ADR-0042 existed —
 * still counts as "pending" and is left out, exactly as every pin was before either of these.
 *
 * Any read failure renders nothing at all: an absent row is better than a broken one, and
 * neither `picks.json` nor `fast-track.json` may ever have been published.
 */

interface Props {
  /**
   * The **unfiltered** channel list (`allChannels`). Passing the filtered list
   * would let a broken mark hide a pin, which is exactly what ADR-0033 forbids.
   */
  channels: EnrichedChannel[]
  onWatch?: (channelId: string) => void
  /**
   * A Home-screen filter (category/country/quality/search), applied only to what
   * is displayed. Identity resolution above still runs against the unfiltered
   * `channels`, so a pin that fails this predicate reads as "filtered out", never
   * as "not yet in the catalogue" — the two are different facts and ADR-0033
   * §3 already draws that line for broken marks. A group with no matches is
   * hidden, same as a group the author left empty.
   */
  filter?: (channel: EnrichedChannel) => boolean
  epgChannelIds?: Set<string>
}

interface ResolvedPick {
  channel: EnrichedChannel
  note?: string
  /** True when `channel` was built from the save-time snapshot, not the live generation (ADR-0042). */
  pending: boolean
}

interface ResolvedGroup {
  title: string
  picks: ResolvedPick[]
  /** Ids of channels that only start playing when they are published. Shown as a count. */
  pendingCount: number
}

/**
 * Builds a card-renderable channel from an item's save-time snapshot, or null
 * when it did not carry one (ADR-0042). Never has a stream: a channel this
 * client's own catalogue does not know about cannot have one either.
 */
function synthesizeChannel(item: PickItem): EnrichedChannel | null {
  if (!item.name) return null
  return {
    id: item.channelId,
    name: item.name,
    logo: null,
    country: item.country ?? null,
    is_active: true,
    channel_categories: (item.categories ?? []).map((category_id) => ({ category_id })),
    stream: undefined,
    streams: [],
    categoryIds: item.categories ?? [],
  }
}

/**
 * Builds a playable channel from a fast-track entry (ADR-0043) — the one case here with a real
 * `stream`, because it is the one case built from a real probe rather than an absence of one.
 */
function synthesizeFastTrackChannel(entry: FastTrackEntry): EnrichedChannel {
  const stream: Stream = { channel_id: entry.channelId, url: entry.stream.url, quality: entry.stream.quality, status: 'active' }
  return {
    id: entry.channelId,
    name: entry.name,
    logo: entry.icon,
    country: entry.country,
    is_active: true,
    channel_categories: entry.categories.map((category_id) => ({ category_id })),
    stream,
    streams: [stream],
    categoryIds: entry.categories,
  }
}

export function PicksRow({ channels, onWatch, filter, epgChannelIds }: Props) {
  const [picks, setPicks] = useState<PicksDocument | null>(null)
  const [fastTrack, setFastTrack] = useState<FastTrackEntry[] | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchPicksFromR2()
      .then((document) => {
        if (!cancelled) setPicks(document)
      })
      .catch(() => {
        // Absent on any read error, by design.
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    // Independent of the picks fetch above and never blocks it: fast-track.json is a bonus, not
    // a dependency — a failure or a slow read here still leaves ADR-0042's identity card working.
    fetchFastTrackFromR2()
      .then((entries) => {
        if (!cancelled) setFastTrack(entries)
      })
      .catch(() => {
        // Absent on any read error, by design.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const byId = useMemo(() => {
    const map = new Map<string, EnrichedChannel>()
    for (const channel of channels) map.set(channel.id, channel)
    return map
  }, [channels])

  const byFastTrack = useMemo(() => {
    const map = new Map<string, FastTrackEntry>()
    for (const entry of fastTrack ?? []) map.set(entry.channelId, entry)
    return map
  }, [fastTrack])

  const groups = useMemo<ResolvedGroup[]>(() => {
    if (!picks) return []
    const out: ResolvedGroup[] = []
    for (const group of picks.groups) {
      const resolved: ResolvedPick[] = []
      let pendingCount = 0
      for (const item of orderPickItems(group.items)) {
        const channel = byId.get(item.channelId)
        if (channel) {
          resolved.push({ channel, note: item.note, pending: false })
          continue
        }
        const fastTracked = byFastTrack.get(item.channelId)
        if (fastTracked) {
          resolved.push({ channel: synthesizeFastTrackChannel(fastTracked), note: item.note, pending: false })
          continue
        }
        const synthesized = synthesizeChannel(item)
        if (!synthesized) {
          pendingCount += 1
          continue
        }
        resolved.push({ channel: synthesized, note: item.note, pending: true })
      }
      const displayed = filter ? resolved.filter((pick) => filter(pick.channel)) : resolved
      // A group is hidden when the author left it empty, nothing in it has
      // reached the catalogue yet, or (with a Home filter active) none of its
      // picks match it — never because its channels look broken.
      if (displayed.length === 0) continue
      out.push({ title: group.title, picks: displayed, pendingCount })
    }
    return out
  }, [picks, byId, byFastTrack, filter])

  if (groups.length === 0) return null

  return (
    <>
      {groups.map((group) => (
        <PicksGroupSection key={group.title} group={group} onWatch={onWatch} epgChannelIds={epgChannelIds} />
      ))}
    </>
  )
}

/**
 * One picks group's own row, with the same ‹ › scroll controls every other
 * row on Home has (`.category-row__arrow`, reused as-is rather than
 * reinvented). Split out from `PicksRow` because each group needs its own
 * scroll container ref, which a `.map()` callback cannot give a hook.
 */
function PicksGroupSection({
  group,
  onWatch,
  epgChannelIds,
}: {
  group: ResolvedGroup
  onWatch?: (channelId: string) => void
  epgChannelIds?: Set<string>
}) {
  const trackRef = useRef<HTMLDivElement>(null)

  function scroll(dir: 'left' | 'right') {
    trackRef.current?.scrollBy({ left: dir === 'right' ? 560 : -560, behavior: 'smooth' })
  }

  // Keyboard next/previous should not land on a pin that cannot play.
  const playlist = group.picks.filter((pick) => pick.channel.stream).map((pick) => pick.channel.id)

  return (
    <section className="picks-row fade-up" aria-label={`Picks: ${group.title}`}>
      <div className="picks-row__header">
        <h2 className="picks-row__title">
          <span aria-hidden="true">★ </span>
          {group.title}
        </h2>
        <span className="picks-row__count">{group.picks.length}</span>
        {group.pendingCount > 0 && (
          <span className="picks-row__pending" title="Pinned, but not in the published catalogue yet">
            {group.pendingCount} pending
          </span>
        )}
        <div className="category-row__controls picks-row__controls">
          <button className="category-row__arrow" onClick={() => scroll('left')} aria-label="Scroll left">
            ‹
          </button>
          <button className="category-row__arrow" onClick={() => scroll('right')} aria-label="Scroll right">
            ›
          </button>
        </div>
      </div>

      <div className="picks-row__track" ref={trackRef}>
        {group.picks.map(({ channel, note, pending }) => (
          <div className="picks-row__item" key={channel.id}>
            <ChannelCard
              channel={channel}
              epgChannelIds={epgChannelIds}
              onWatch={onWatch}
              playlist={playlist.length > 1 ? playlist : undefined}
            />
            {note && (
              <p className="picks-row__note" title={note}>
                {note}
              </p>
            )}
            {!channel.stream && (
              <p className="picks-row__unavailable">
                {pending ? 'Not yet in the catalogue' : 'No stream available'}
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
