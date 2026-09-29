/** One source for the shortcut help overlay and Settings, so they cannot drift apart. */
export interface ShortcutGroup {
  title: string
  items: { keys: string[]; label: string }[]
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Discover',
    items: [
      { keys: ['*'], label: 'Surprise me: play a random live channel' },
      { keys: ['/'], label: 'Search' },
      { keys: ['?'], label: 'Show this list' },
      { keys: ['←', '→', '↑', '↓'], label: 'Move between channels and rows' },
      { keys: ['Enter'], label: 'Play the selected channel' },
      { keys: ['Esc'], label: 'Clear filters / go back' },
    ],
  },
  {
    title: 'While watching',
    items: [
      { keys: ['[', ']'], label: 'Previous / next channel' },
      { keys: ['0–9'], label: 'Jump to a channel number' },
      { keys: ['L'], label: 'Last channel' },
      { keys: ['G'], label: 'Guide drawer (rest on a channel for a now/next preview)' },
      { keys: ['Z'], label: 'Sleep timer: 30 / 60 / 90 min' },
      { keys: ['Space'], label: 'Play / pause' },
      { keys: ['F'], label: 'Fullscreen' },
      { keys: ['M'], label: 'Mute' },
      { keys: ['C'], label: 'Subtitles' },
      { keys: ['A'], label: 'Audio track' },
    ],
  },
]

export const OPEN_SHORTCUTS_EVENT = 'sl:open-shortcuts'

/** Open the shortcut overlay from anywhere (Settings, tips). */
export function openShortcuts() {
  window.dispatchEvent(new Event(OPEN_SHORTCUTS_EVENT))
}
