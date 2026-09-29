import { useState } from 'react'
import { markTipSeen, markTipShown, nextTip, type TipId } from '../util/tips'
import { openShortcuts } from '../util/shortcutList'
import './FeatureTip.css'

interface Props {
  onSurprise: () => void
}

const COPY: Record<TipId, { icon: string; text: string; action: string }> = {
  surprise: { icon: '🎲', text: 'Not sure what to watch? Let StreamLoom pick a live channel for you.', action: 'Surprise me' },
  sleep: { icon: '🌙', text: 'Falling asleep to TV? Press Z in the player for a sleep timer that fades out gently.', action: 'Got it' },
  keys: { icon: '⌨️', text: 'Press ? any time to see every keyboard and remote shortcut.', action: 'Show shortcuts' },
}

/** One dismissible tip on Home. Touch-only devices skip the keyboard tip. */
export function FeatureTip({ onSurprise }: Props) {
  const [id, setId] = useState<TipId | null>(() => {
    const touchOnly = typeof matchMedia === 'function' && matchMedia('(hover: none)').matches
    const tip = nextTip(touchOnly ? ['keys'] : [])
    if (tip) markTipShown()
    return tip
  })
  if (!id) return null
  const tip = COPY[id]
  const done = () => {
    markTipSeen(id)
    setId(null)
  }
  return (
    <div className="feature-tip" role="note">
      <span className="feature-tip__icon" aria-hidden="true">{tip.icon}</span>
      <p className="feature-tip__text">{tip.text}</p>
      <button
        type="button"
        className="feature-tip__go"
        onClick={() => {
          done()
          if (id === 'surprise') onSurprise()
          else if (id === 'keys') openShortcuts()
        }}
      >
        {tip.action}
      </button>
      <button type="button" className="feature-tip__x" aria-label="Dismiss tip" onClick={done}>
        ✕
      </button>
    </div>
  )
}
