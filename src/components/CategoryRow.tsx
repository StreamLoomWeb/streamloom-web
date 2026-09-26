import { useRef, useState, useCallback, useEffect } from 'react'
import { ChannelCard } from './ChannelCard'
import type { EnrichedChannel } from '../hooks/useChannels'
import './CategoryRow.css'

interface Props {
  title: string
  channels: EnrichedChannel[]
  epgChannelIds?: Set<string>
  onWatch?: (channelId: string) => void
}

const INITIAL_CHUNK = 24
const CHUNK_SIZE = 24

/** How far ahead of the viewport a row starts mounting its cards. */
const REVEAL_ROOT_MARGIN = '600px 0px'

export function CategoryRow({ title, channels, epgChannelIds, onWatch }: Props) {
  const rowRef = useRef<HTMLDivElement>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const [visibleCount, setVisibleCount] = useState(INITIAL_CHUNK)
  const [isRevealed, setIsRevealed] = useState(false)

  /*
   * Mounting every card up front cost rows x 24 image nodes before the first
   * paint. A row now mounts its cards only as it approaches the viewport; the
   * placeholders reuse the real card markup so the height, and therefore the
   * scroll position, stays put when the cards swap in.
   */
  useEffect(() => {
    if (isRevealed) return
    const el = sectionRef.current
    if (!el) return

    if (typeof IntersectionObserver === 'undefined') {
      Promise.resolve().then(() => setIsRevealed(true))
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setIsRevealed(true)
          observer.disconnect()
        }
      },
      { rootMargin: REVEAL_ROOT_MARGIN },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [isRevealed])

  // Expand visible channels when needed
  const ensureMoreVisible = useCallback(() => {
    setVisibleCount((prev) => (prev < channels.length ? Math.min(prev + CHUNK_SIZE, channels.length) : prev))
  }, [channels.length])

  function scroll(dir: 'left' | 'right') {
    if (dir === 'right') {
      ensureMoreVisible()
    }
    rowRef.current?.scrollBy({ left: dir === 'right' ? 560 : -560, behavior: 'smooth' })
  }

  /*
   * Horizontal wheel translation - only for an explicit sideways gesture.
   *
   * A plain vertical wheel used to be cancelled and turned into a horizontal
   * scroll, which dragged the rail sideways roughly 180px per notch and blocked
   * the page from scrolling at all. Vertical input is now left alone: the page
   * scrolls normally and only Shift+wheel or a genuinely horizontal trackpad
   * delta moves the row.
   */
  useEffect(() => {
    const track = rowRef.current
    if (!track) return
    // Local const so the closure keeps the non-null narrowing.
    const el: HTMLDivElement = track

    function handleWheel(e: WheelEvent) {
      const horizontalIntent = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)
      if (!horizontalIntent) return

      // Shift+wheel arrives on deltaY; a trackpad swipe already reports deltaX
      const delta = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX
      if (delta === 0) return

      e.preventDefault()
      el.scrollBy({ left: delta * (e.shiftKey ? 1.8 : 1), behavior: 'auto' })
    }

    track.addEventListener('wheel', handleWheel, { passive: false })
    return () => track.removeEventListener('wheel', handleWheel)
  }, [])

  // Track scroll listener to load more as user swipes/scrolls horizontally
  const handleScroll = useCallback(() => {
    const track = rowRef.current
    if (!track) return
    if (track.scrollLeft + track.clientWidth >= track.scrollWidth - 400) {
      ensureMoreVisible()
    }
  }, [ensureMoreVisible])

  if (channels.length === 0) return null

  const renderedChannels = channels.slice(0, visibleCount)
  const ghostCount = Math.min(INITIAL_CHUNK, channels.length)

  return (
    <section className="category-row fade-up" ref={sectionRef}>
      <div className="category-row__header">
        <div className="category-row__title-wrap">
          <h2 className="category-row__title">{title}</h2>
          <span className="category-row__count">{channels.length}</span>
        </div>
        <div className="category-row__controls">
          <button className="category-row__arrow" onClick={() => scroll('left')} aria-label="Scroll left">
            ‹
          </button>
          <button className="category-row__arrow" onClick={() => scroll('right')} aria-label="Scroll right">
            ›
          </button>
        </div>
      </div>
      <div className="category-row__track" ref={rowRef} onScroll={handleScroll} tabIndex={-1}>
        {isRevealed
          ? renderedChannels.map((ch) => (
              <ChannelCard
                key={ch.id}
                channel={ch}
                epgChannelIds={epgChannelIds}
                onWatch={onWatch}
                playlist={channels.map((c) => c.id)}
              />
            ))
          : Array.from({ length: ghostCount }, (_, i) => (
              <div
                key={i}
                className="channel-card channel-card--medium channel-card--ghost"
                aria-hidden="true"
              >
                <div className="channel-card__thumb" />
                <div className="channel-card__info">
                  <span className="skeleton channel-card__ghost-line" style={{ width: '80%' }} />
                  <span className="skeleton channel-card__ghost-line" style={{ width: '50%' }} />
                </div>
              </div>
            ))}
      </div>
    </section>
  )
}
