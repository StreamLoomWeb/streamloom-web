import { useCallback, useEffect, useRef, useState } from 'react'
import { closeDocumentPipWindow, copyStylesInto, isDocumentPipSupported } from '../util/documentPip'

/**
 * Opens and tracks a Document Picture-in-Picture window. Doesn't move any content
 * itself — the caller reparents its own video node and portals its own controls into
 * the returned `pipWindow`, since only the caller knows what belongs in the window.
 *
 * Ownership rule: `pipWindowRef` names the one window this instance currently owns,
 * and every teardown path clears it synchronously, before anything asynchronous
 * happens. So:
 *
 * - `close()` (the app's own close / "Return here" / back) tears down immediately:
 *   `onWillClose` moves the video back while the PiP document is still attached (the
 *   only time Chrome keeps the media player across the move), state goes null in the
 *   same tick, and only then is the window asked to close. Nothing waits on
 *   `pagehide`, whose timing `window.close()` does not promise.
 * - `pagehide` handles closes the page didn't start (the window's own ✕, Chrome's
 *   "back to tab", another tab opening its own PiP window). It acts only while its
 *   window is still the owned one, so a late `pagehide` from an older window can't
 *   pull the video out of, or null the state of, a newer one.
 * - A `requestWindow()` that resolves after unmount closes the window it got rather
 *   than leaving an orphaned, uncloseable one open for the rest of the session.
 *
 * `open()` never touches `documentPictureInPicture.window` itself. The spec's
 * requestWindow() steps close any previous PiP window as part of opening the new one
 * (Chrome does it browser-side, in PictureInPictureWindowManager, before it shows the
 * new window). A second, script-initiated `close()` on that old window just puts
 * another asynchronous close in flight alongside the browser's own replacement.
 */
export function useDocumentPip(onWillClose?: () => void) {
  const [pipWindow, setPipWindow] = useState<Window | null>(null)
  const pipWindowRef = useRef<Window | null>(null)
  const onWillCloseRef = useRef(onWillClose)
  const isOpeningRef = useRef(false)
  const isMountedRef = useRef(true)
  const isSupported = isDocumentPipSupported()

  useEffect(() => {
    onWillCloseRef.current = onWillClose
  }, [onWillClose])

  const close = useCallback(() => {
    const win = pipWindowRef.current
    if (!win) return
    pipWindowRef.current = null
    onWillCloseRef.current?.()
    setPipWindow(null)
    closeDocumentPipWindow(win)
  }, [])

  const open = useCallback(
    async (options?: { width?: number; height?: number }): Promise<Window | null> => {
      if (!isSupported || isOpeningRef.current) return null
      const current = pipWindowRef.current
      if (current && !current.closed) return current
      isOpeningRef.current = true
      let win: Window
      try {
        // Nothing may run before this call that could spend the click's transient
        // user activation, and nothing is awaited ahead of it.
        win = await window.documentPictureInPicture!.requestWindow(options)
      } finally {
        isOpeningRef.current = false
      }

      if (!isMountedRef.current) {
        // The player unmounted (back pressed) while the request was in flight: no
        // one is left to own or close this window.
        closeDocumentPipWindow(win)
        return null
      }
      if (win.closed) {
        console.warn('[document-pip] requestWindow() resolved with a window that is already closed')
        return null
      }

      win.addEventListener(
        'pagehide',
        () => {
          if (pipWindowRef.current !== win) return
          pipWindowRef.current = null
          onWillCloseRef.current?.()
          setPipWindow(null)
        },
        { once: true }
      )
      // Owned before anything below can throw, so every teardown path covers it.
      pipWindowRef.current = win
      setPipWindow(win)
      copyStylesInto(win.document)
      win.document.body.style.margin = '0'
      win.document.body.style.background = '#000'
      return win
    },
    [isSupported]
  )

  // Unmount (any route change, including the browser's own back): close whatever
  // this instance owns. The video's move-back is not attempted here: by the time a
  // passive cleanup runs React has already detached the caller's refs, and the
  // node goes away with the window.
  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      const win = pipWindowRef.current
      pipWindowRef.current = null
      if (win) closeDocumentPipWindow(win)
    }
  }, [])

  return { isSupported, pipWindow, open, close }
}
