/**
 * Theme utility for managing Dark and Light appearance modes.
 * Defaults to 'system' (following the OS) with persistence in localStorage
 * ('sl_theme'). 'system' resolves live: an OS-level change is picked up
 * without a reload while that preference is selected.
 */

export type Theme = 'dark' | 'light'
export type ThemePreference = Theme | 'system'

const THEME_KEY = 'sl_theme'
const listeners = new Set<(theme: Theme) => void>()
let mediaQuery: MediaQueryList | null = null

function systemTheme(): Theme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function resolve(pref: ThemePreference): Theme {
  return pref === 'system' ? systemTheme() : pref
}

export function getStoredPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(THEME_KEY)
    if (saved === 'light' || saved === 'dark' || saved === 'system') {
      return saved
    }
  } catch {
    // ignore
  }
  return 'system'
}

export function getStoredTheme(): Theme {
  return resolve(getStoredPreference())
}

export function applyThemeToDom(theme: Theme) {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', theme)
  document.documentElement.classList.toggle('light-theme', theme === 'light')
  document.documentElement.classList.toggle('dark-theme', theme === 'dark')

  const metaTheme = document.querySelector('meta[name="theme-color"]')
  if (metaTheme) {
    metaTheme.setAttribute('content', theme === 'light' ? '#f4f4f7' : '#0a0a0f')
  }
}

function syncSystemListener(pref: ThemePreference) {
  if (typeof window === 'undefined' || !window.matchMedia) return
  if (!mediaQuery) mediaQuery = window.matchMedia('(prefers-color-scheme: light)')
  mediaQuery.onchange = pref === 'system' ? () => setTheme('system') : null
}

export function setTheme(preference: ThemePreference) {
  try {
    localStorage.setItem(THEME_KEY, preference)
  } catch {
    // ignore
  }
  const resolved = resolve(preference)
  applyThemeToDom(resolved)
  syncSystemListener(preference)
  listeners.forEach((fn) => {
    try {
      fn(resolved)
    } catch {
      // ignore
    }
  })
}

export function toggleTheme(): Theme {
  const next = getStoredTheme() === 'light' ? 'dark' : 'light'
  setTheme(next)
  return next
}

export function onThemeChange(listener: (theme: Theme) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// Initial application
if (typeof window !== 'undefined') {
  const preference = getStoredPreference()
  applyThemeToDom(resolve(preference))
  syncSystemListener(preference)
}
