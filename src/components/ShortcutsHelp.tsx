import { useEffect, useRef, useState } from 'react'
import { OPEN_SHORTCUTS_EVENT, SHORTCUT_GROUPS } from '../util/shortcutList'
import './ShortcutsHelp.css'

/**
 * The `?` cheat sheet. Mounted once at the app root so it works on every page, player included.
 * Uses a modal <dialog>, so Escape closes it without the Home filter-clearing handler firing.
 */
export function ShortcutsHelp() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      e.preventDefault()
      setOpen((v) => !v)
    }
    const onOpen = () => setOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener(OPEN_SHORTCUTS_EVENT, onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(OPEN_SHORTCUTS_EVENT, onOpen)
    }
  }, [])

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    else if (!open && d.open) d.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className="shortcuts-help glass"
      aria-label="Keyboard shortcuts"
      onClose={() => setOpen(false)}
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false)
      }}
    >
      <div className="shortcuts-help__head">
        <h2>Keyboard shortcuts</h2>
        <button type="button" onClick={() => setOpen(false)} aria-label="Close shortcuts">
          ✕
        </button>
      </div>
      <div className="shortcuts-help__body">
        {SHORTCUT_GROUPS.map((g) => (
          <section key={g.title}>
            <h3>{g.title}</h3>
            <ul>
              {g.items.map((it) => (
                <li key={it.label}>
                  <span className="shortcuts-help__keys">
                    {it.keys.map((k) => (
                      <kbd key={k}>{k}</kbd>
                    ))}
                  </span>
                  <span>{it.label}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </dialog>
  )
}
