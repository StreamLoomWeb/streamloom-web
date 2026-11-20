// Boot-time theme application (moved out of index.html so script-src can be 'self'
// with no 'unsafe-inline': an inline <script> block cannot be allow-listed by a
// static Cloudflare Pages _headers file without a per-deploy hash).
// Runs synchronously, before first paint, so there is no flash of the wrong theme.
(function () {
  try {
    var theme = localStorage.getItem('sl_theme') || 'dark'
    document.documentElement.setAttribute('data-theme', theme)
    document.documentElement.classList.add(theme === 'light' ? 'light-theme' : 'dark-theme')
  } catch {
    // localStorage can throw in a locked-down context (private mode, blocked storage);
    // the app still renders in the default dark theme.
  }

  // The Inter stylesheet loads as print media (non-blocking) and swaps to all
  // media once it arrives (font-display: swap pattern). This was previously an
  // inline onload="" attribute, which CSP's script-src also governs.
  var fontLink = document.getElementById('sl-font-css')
  if (fontLink) {
    fontLink.onload = function () {
      this.media = 'all'
    }
  }
})()
