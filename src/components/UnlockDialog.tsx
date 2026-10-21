import { useEffect, useRef, useState } from 'react'
import { CODE_LENGTH, getOrCreateClientCode, isWellFormedCode, redeemUnlockCode, sanitizeCodeInput } from '../util/unlock'
import './UnlockDialog.css'

interface UnlockDialogProps {
  open: boolean
  onClose: () => void
}

/**
 * The consumer side of the full-catalogue unlock (ADR-0059/0060). Opened from Settings after
 * tapping the version string seven times. Shows this device's client code (read to the admin
 * over phone/chat) and takes the unlock code the admin reads back, redeeming it through the
 * public `/api/unlock-validate`. On success the catalogue filter in `useChannels` lifts
 * everywhere at once — no reload needed, since `redeemUnlockCode` fires the same change bus
 * hidden/broken state uses.
 */
export function UnlockDialog({ open, onClose }: UnlockDialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  // The caller remounts this component with a fresh `key` each time it reopens (Settings.tsx),
  // so every field below can simply initialize once per mount instead of being reset by an
  // effect when `open` flips back to true.
  const [clientCode] = useState(getOrCreateClientCode)
  const [unlockInput, setUnlockInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    else if (!open && d.open) d.close()
  }, [open])

  const handleCopy = () => {
    navigator.clipboard
      ?.writeText(clientCode)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      })
      .catch(() => {})
  }

  const handleSubmit = async () => {
    const code = sanitizeCodeInput(unlockInput)
    if (!isWellFormedCode(code)) {
      setError(`Enter the ${CODE_LENGTH}-character code exactly as given.`)
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const valid = await redeemUnlockCode(code)
      if (valid) {
        onClose()
        return
      }
      setError('That code did not match. Check it and try again.')
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <dialog
      ref={ref}
      className="unlock-dialog glass"
      aria-label="Unlock full catalogue"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="unlock-dialog__head">
        <h2>Unlock full catalogue</h2>
        <button type="button" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="unlock-dialog__body">
        <p className="unlock-dialog__hint">
          By default this app shows only the legally-cleared subset of channels. To see the full
          catalogue, read the code below to whoever manages this app and enter the code they give
          you back.
        </p>

        <div className="unlock-dialog__field">
          <span className="unlock-dialog__label">Your code</span>
          <div className="unlock-dialog__code-row">
            <code className="unlock-dialog__code">{clientCode}</code>
            <button type="button" className="unlock-dialog__copy" onClick={handleCopy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>

        <div className="unlock-dialog__field">
          <label className="unlock-dialog__label" htmlFor="unlock-dialog-input">
            Code they give you
          </label>
          <input
            id="unlock-dialog-input"
            className="unlock-dialog__input"
            value={unlockInput}
            onChange={(e) => {
              setUnlockInput(sanitizeCodeInput(e.target.value))
              setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSubmit()
            }}
            placeholder={'A'.repeat(CODE_LENGTH)}
            maxLength={CODE_LENGTH}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
          />
        </div>

        {error && (
          <p className="unlock-dialog__error" role="alert">
            {error}
          </p>
        )}

        <button
          type="button"
          className="unlock-dialog__submit"
          onClick={() => void handleSubmit()}
          disabled={submitting || unlockInput.length !== CODE_LENGTH}
        >
          {submitting ? 'Checking…' : 'Unlock'}
        </button>
      </div>
    </dialog>
  )
}
