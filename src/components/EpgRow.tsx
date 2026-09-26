import { memo, useMemo } from 'react'
import type { EnrichedChannel, EpgProgram } from '../api/types'
import { LOGO_SIZE, logoUrl, handleLogoError } from '../util/logo'
import { PIXELS_PER_MINUTE, offsetMinutes } from '../util/epgTime'
import { EpgProgramBox } from './EpgProgramBox'

interface Props {
  channel: EnrichedChannel
  programs: EpgProgram[]
  origin: number
  nowOffset: number
  /** Total minutes the grid covers, from its origin. */
  spanMinutes: number
  translate: boolean
  sidebarWidth: number
  rowHeight: number
  /** Absolute row offset inside the virtualized spacer, in px. */
  top: number
  /** Position in the full (unwindowed) channel list — the guide's arrow-key nav targets rows by this. */
  rowIndex: number
  onPick: (channelId: string) => void
}

/** How far before the grid start a row still renders a programme tail. */
const LEAD_MINUTES = 15

/**
 * One channel row of the guide.
 *
 * Memoized on its props so a schedule arriving for channel B never re-renders
 * channel A — the single largest source of jank in the previous implementation,
 * which rewrote one big map and re-rendered every row on each batch.
 *
 * Programs are windowed horizontally too: anything that ended well before the
 * grid starts, or begins after the last visible hour, is skipped instead of
 * being laid out off-screen where it still costs layout and paint.
 */
export const EpgRow = memo(function EpgRow({
  channel,
  programs,
  origin,
  nowOffset,
  spanMinutes,
  translate,
  sidebarWidth,
  rowHeight,
  top,
  rowIndex,
  onPick,
}: Props) {
  const logoSrc = logoUrl(channel.logo)

  // Visible span in minutes from the grid origin. Programmes overlapping this
  // range are rendered; anything wholly outside it is skipped rather than laid
  // out off-screen.
  const gridStart = -LEAD_MINUTES
  const gridEnd = spanMinutes

  /**
   * Packs the visible programmes into non-overlapping slots.
   *
   * Feeds publish overlapping entries, zero-length gaps and duplicate
   * boundaries; laying those out from their raw end times makes boxes collide.
   * Each programme is instead given the next programme's start as its right
   * edge, which is what a guide is supposed to look like. Boundaries are also
   * rounded to the pixel grid so adjacent boxes meet without a drifting seam.
   */
  const slots = useMemo(() => {
    if (programs.length === 0) return []

    const windowed: { program: EpgProgram; start: number; end: number }[] = []
    for (const p of programs) {
      const start = offsetMinutes(p.start_time, origin)
      const end = offsetMinutes(p.end_time, origin)
      if (end <= gridStart || start >= gridEnd) continue
      windowed.push({ program: p, start, end })
    }
    windowed.sort((a, b) => a.start - b.start || a.end - b.end)

    // Feeds republish the same slot, and publish zero-length entries, for a
    // channel. Rendering those stacks boxes on one another at zero width, so
    // duplicates are collapsed to the longest entry and empty slots dropped.
    const deduped: typeof windowed = []
    for (const w of windowed) {
      const prev = deduped[deduped.length - 1]
      if (prev && Math.abs(prev.start - w.start) < 0.5) {
        if (w.end > prev.end) deduped[deduped.length - 1] = w
        continue
      }
      deduped.push(w)
    }

    // Only slots wide enough to paint: a box narrower than its own padding would
    // spill into its neighbour, which is what produced the overlaps. 26px is the
    // padding plus a sliver of visible card.
    const MIN_SLOT_PX = 26
    const usable = deduped.filter((w, i) => {
      const next = deduped[i + 1]
      return ((next ? next.start : w.end) - w.start) * PIXELS_PER_MINUTE >= MIN_SLOT_PX
    })
    if (usable.length === 0) return []

    return usable.map((w, i) => ({
      program: w.program,
      // Run to the next programme's start. A real gap keeps its gap; overlaps
      // and duplicate boundaries are absorbed so the boxes stay flush.
      slotEnd: Math.max(usable[i + 1]?.start ?? w.end, w.start),
    }))
  }, [programs, origin, gridStart, gridEnd])

  return (
    <div
      className="epg-guide__row"
      style={{ transform: `translateY(${top}px)`, height: rowHeight }}
      data-row-index={rowIndex}
    >
      <div
        className="epg-guide__channel"
        style={{ width: sidebarWidth }}
        onClick={() => onPick(channel.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onPick(channel.id)
          }
        }}
        role="button"
        tabIndex={0}
        title={channel.name}
        data-channel-id={channel.id}
      >
        {logoSrc ? (
          <img
            src={logoSrc}
            alt=""
            width={LOGO_SIZE}
            height={LOGO_SIZE}
            decoding="async"
            loading="lazy"
            onError={handleLogoError}
            className="epg-guide__channel-logo"
          />
        ) : (
          <span className="epg-guide__channel-initials">
            {channel.name.slice(0, 2).toUpperCase()}
          </span>
        )}
        <span className="epg-guide__channel-name">{channel.name}</span>
      </div>

      <div className="epg-guide__programs">
        {slots.length > 0 ? (
          slots.map((slot) => (
            <EpgProgramBox
              key={slot.program.id}
              program={slot.program}
              origin={origin}
              nowOffset={nowOffset}
              translate={translate}
              slotEnd={slot.slotEnd}
              onPick={onPick}
            />
          ))
        ) : (
          <span className="epg-guide__no-prog">No schedule data</span>
        )}
      </div>
    </div>
  )
})

