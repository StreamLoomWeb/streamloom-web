import { useState, useEffect, useCallback } from 'react'
import {
  getStoredTheme,
  getStoredPreference,
  setTheme as setGlobalTheme,
  toggleTheme as toggleGlobalTheme,
  onThemeChange,
  type Theme,
  type ThemePreference,
} from '../util/theme'

export function useTheme() {
  const [theme, setLocalTheme] = useState<Theme>(() => getStoredTheme())
  const [preference, setLocalPreference] = useState<ThemePreference>(() => getStoredPreference())

  useEffect(() => {
    return onThemeChange((next) => {
      setLocalTheme(next)
      setLocalPreference(getStoredPreference())
    })
  }, [])

  const setTheme = useCallback((next: ThemePreference) => {
    setGlobalTheme(next)
    setLocalPreference(next)
  }, [])

  const toggleTheme = useCallback(() => {
    return toggleGlobalTheme()
  }, [])

  return {
    theme,
    preference,
    isDark: theme === 'dark',
    setTheme,
    toggleTheme,
  }
}
