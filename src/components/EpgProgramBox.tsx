import { memo, useEffect, useRef, useState } from 'react'
import type { EpgProgram } from '../api/types'
import { PIXELS_PER_MINUTE, formatTime, offsetMinutes } from '../util/epgTime'
import {
  getTranslation,
  requestTranslations,
  useTranslationVersion,
} from '../util/translate'

interface Props {
  program: EpgProgram
  origin: number
  nowOffset: number
  translate: boolean
  onPick: (channelId: string) => void
  /**
   * Right edge of this programme's slot, in minutes from the origin.
   *
   * A programme's own end time is not enough: feeds publish gaps, overlaps and
   * duplicate boundaries, and honouring them literally makes boxes collide.
   * The row computes the next programme's start and passes it here, so every box
   * ends exactly where the following one begins.
   */
  slotEnd: number
}

/**
 * One programme cell.
 *
 * Positioned in the grid's own coordinate space (minutes from the window
 * origin), so it stays aligned with the ruler and the now-line at every scroll
 * position. Width comes from the row's slot calculation rather than the raw end
 * time, which is what keeps neighbouring boxes from overlapping.
 *
 * When translation is on the title is derived during render from the module
 * cache — subscribing to its version rather than mirroring it into state — so a
 * batch of translations lands in a single pass with no second render. The
 * original title is always kept as the tooltip.
 *
 * The description used to live only in that tooltip, reachable by mouse hover
 * alone — unusable by touch, keyboard or TV remote. A programme with one gets
 * a dedicated details button; activating it (click, tap, or Enter/Space while
 * it has focus) opens a native <dialog> with the full text, matching the
 * modal pattern FilterSheet already uses so it escapes the grid's own
 * scroll/clipping instead of trying to expand in place within a fixed-height
 * absolutely-positioned row.
 */
export const EpgProgramBox = memo(function EpgProgramBox({
  program,
  origin,
  nowOffset,
  translate,
  onPick,
  slotEnd,
}: Props) {
  // Re-reads the cache whenever a batch of translations lands.
  useTranslationVersion()

  useEffect(() => {
    if (translate) requestTranslations([program.title])
  }, [translate, program.title])

  const [detailsOpen, setDetailsOpen] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (detailsOpen && !dialog.open) dialog.showModal()
    else if (!detailsOpen && dialog.open) dialog.close()
  }, [detailsOpen])

  const start = offsetMinutes(program.start_time, origin)
  const end = offsetMinutes(program.end_time, origin)
  // Snap to the pixel grid: `slotEnd` comes from the next programme's snapped
  // start, so the left edge must be snapped the same way or the two disagree by
  // a sub-pixel and adjacent boxes can still clip each other.
  const left = Math.round(start * PIXELS_PER_MINUTE)
  // Exact fit to the slot the row allocated. A minimum width would push the box
  // into its neighbour, which is precisely the overlap this grid must not have;
  // very short programmes stay legible through the title tooltip instead.
  const width = Math.max(Math.round(slotEnd * PIXELS_PER_MINUTE) - left - GUTTER, 0)
  const isNow = nowOffset >= start && nowOffset < end

  const translated = translate ? getTranslation(program.title) : null
  const title = translated ?? program.title
  const time = formatTime(program.start_time)
  const description = program.description?.trim()

  return (
    <>
      <div
        className={`epg-guide__program${isNow ? ' epg-guide__program--now' : ''}`}
        style={{ transform: `translateX(${left}px)`, width }}
        title={`${time} – ${program.title}${description ? '\n' + description : ''}`}
        onClick={() => onPick(program.channel_id)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onPick(program.channel_id)
          }
        }}
      >
        <span className="epg-guide__prog-title">{title}</span>
        {width > 90 && <span className="epg-guide__prog-time">{time}</span>}
        {description && (
          <button
            type="button"
            className="epg-guide__prog-info"
            tabIndex={0}
            aria-label={`Show details for ${title}`}
            onClick={(e) => {
              e.stopPropagation()
              setDetailsOpen(true)
            }}
            onKeyDown={(e) => {
              // Keydown bubbles to the box's own handler before the browser's
              // click-on-Enter/Space fires, which would also tune the channel.
              if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
            }}
          >
            <span aria-hidden="true">ⓘ</span>
          </button>
        )}
      </div>

      {description && (
        <dialog
          ref={dialogRef}
          className="epg-guide__prog-dialog-backdrop"
          onClose={() => setDetailsOpen(false)}
          onClick={(e) => {
            if (e.target === dialogRef.current) setDetailsOpen(false)
          }}
        >
          <div className="epg-guide__prog-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="epg-guide__prog-dialog-header">
              <span className="epg-guide__prog-dialog-time">{time}</span>
              <button
                type="button"
                className="epg-guide__prog-dialog-close"
                onClick={() => setDetailsOpen(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <h3 className="epg-guide__prog-dialog-title">{title}</h3>
            <p className="epg-guide__prog-dialog-desc">{description}</p>
          </div>
        </dialog>
      )}
    </>
  )
})

/** Gap kept between adjacent boxes, in px. */
const GUTTER = 2


