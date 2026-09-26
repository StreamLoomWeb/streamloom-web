/**
 * Document Picture-in-Picture (Chrome/Edge desktop only, Safari has neither this API
 * nor the older element-PiP one on desktop): a real floating window with its own
 * document, so the mini-player can carry custom zap controls instead of the handful
 * of buttons the browser's native video PiP window allows.
 */

interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>
  readonly window: Window | null
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPicture
  }
}

export function isDocumentPipSupported(): boolean {
  return typeof window !== 'undefined' && 'documentPictureInPicture' in window
}

/**
 * Asks a Document PiP window to close. `window.close()` is asynchronous (Chrome
 * schedules it; `pagehide` and the window's destruction come later), so callers must
 * finish their own teardown before calling this, never after waiting on it. Nothing
 * needs to wait for it before a later `requestWindow()` either: that call closes any
 * previous PiP window itself.
 */
export function closeDocumentPipWindow(win: Window): void {
  win.close()
}

/** Copies the page's stylesheets into a PiP window so moved/portalled content keeps its styling. */
export function copyStylesInto(pipDocument: Document) {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      if (sheet.href) {
        const link = document.createElement('link')
        link.rel = 'stylesheet'
        link.href = sheet.href
        pipDocument.head.appendChild(link)
      } else if (sheet.cssRules) {
        const style = document.createElement('style')
        style.textContent = Array.from(sheet.cssRules)
          .map((rule) => rule.cssText)
          .join('\n')
        pipDocument.head.appendChild(style)
      }
    } catch {
      // Cross-origin stylesheet; cssRules throws, and there is nothing to copy.
    }
  }
}
