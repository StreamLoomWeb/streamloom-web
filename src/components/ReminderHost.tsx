import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { dueReminders, removeReminder, type Reminder } from '../util/reminders'
import './StartingSoon.css'

/** Toast a reminder this long before its programme starts. */
const LEAD_MS = 60_000
const CHECK_MS = 20_000
const AUTO_DISMISS_MS = 30_000

/**
 * Fires the in-app reminders set from "Starting soon" chips. It only ever renders inside the
 * page (no Notification API, no push), so nothing reaches a user who is not already here.
 * A fired reminder is removed, so it shows once.
 */
export function ReminderHost() {
  const navigate = useNavigate()
  const [toast, setToast] = useState<Reminder | null>(null)

  useEffect(() => {
    const check = () => {
      const due = dueReminders(Date.now(), LEAD_MS)
      if (!due.length) return
      const first = due[0]
      removeReminder(first)
      setToast(first)
    }
    const id = window.setInterval(check, CHECK_MS)
    const first = window.setTimeout(check, 2000)
    return () => {
      window.clearInterval(id)
      window.clearTimeout(first)
    }
  }, [])

  useEffect(() => {
    if (!toast) return
    const id = window.setTimeout(() => setToast(null), AUTO_DISMISS_MS)
    return () => window.clearTimeout(id)
  }, [toast])

  if (!toast) return null
  return (
    <div className="reminder-toast" role="status" aria-live="polite">
      <span className="reminder-toast__text">
        <strong>{toast.p}</strong> is about to start on {toast.n}
      </span>
      <button
        type="button"
        onClick={() => {
          setToast(null)
          navigate(`/watch/${encodeURIComponent(toast.c)}`, { state: { returnTo: '/' } })
        }}
      >
        Watch
      </button>
      <button type="button" className="reminder-toast__dismiss" onClick={() => setToast(null)} aria-label="Dismiss reminder">
        ✕
      </button>
    </div>
  )
}
