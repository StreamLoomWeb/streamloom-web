import { useEffect, useRef } from 'react'
import type { SleepTimer } from '../hooks/useSleepTimer'
import './SleepTimer.css'

/** The dimming veil (never blocks input) and the closing card. */
export function SleepOverlay({ timer, onExit }: { timer: SleepTimer; onExit: () => void }) {
  const keepRef = useRef<HTMLButtonElement>(null)
  const { phase } = timer
  useEffect(() => {
    if (phase === 'done') keepRef.current?.focus()
  }, [phase])

  if (timer.dim <= 0 && phase !== 'done') return null
  return (
    <>
      <div className="sleep__veil" style={{ opacity: timer.dim }} aria-hidden="true" />
      {phase === 'done' && (
        <div className="sleep__card" role="dialog" aria-modal="true" aria-labelledby="sleep-title">
          <p className="sleep__moon" aria-hidden="true">🌙</p>
          <h2 id="sleep-title" className="sleep__title">Good night</h2>
          <p className="sleep__sub">Sleep well. The stream is paused.</p>
          <div className="sleep__actions">
            <button ref={keepRef} type="button" className="sleep__btn" onClick={timer.keepWatching}>
              Keep watching
            </button>
            <button type="button" className="sleep__btn sleep__btn--quiet" onClick={onExit}>
              Close
            </button>
          </div>
        </div>
      )}
    </>
  )
}
