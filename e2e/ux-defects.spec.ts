import { test, expect } from '@playwright/test'
import { windowPlaylist, MAX_PLAYLIST } from '../src/util/playlistWindow'
import { detectTvMode } from '../src/util/tvMode'

const ids = Array.from({ length: 3000 }, (_, i) => `c${i}`)

test.describe('windowPlaylist', () => {
  test('small lists pass through untouched', () => {
    const small = ids.slice(0, 10)
    expect(windowPlaylist(small, 'c3')).toEqual(small)
  })
  for (const cur of ['c0', 'c1500', 'c2999']) {
    test(`caps to ${MAX_PLAYLIST} and keeps ${cur}`, () => {
      const w = windowPlaylist(ids, cur)
      expect(w).toHaveLength(MAX_PLAYLIST)
      expect(w).toContain(cur)
    })
  }
})

test.describe('detectTvMode', () => {
  const fake = (ua: string, touch: number, hover: boolean, search = '') => {
    const g = globalThis as unknown as Record<string, unknown>
    g.window = {
      location: { search },
      navigator: { userAgent: ua, maxTouchPoints: touch },
      matchMedia: (q: string) => ({ matches: q.includes('hover: hover') || q.includes('pointer: fine') ? hover : false }),
    }
  }
  test.afterEach(() => { delete (globalThis as Record<string, unknown>).window })

  test('touch phone with no hover is not a TV', () => {
    fake('Mozilla/5.0 (Linux; Android 14) Mobile', 5, false)
    expect(detectTvMode()).toBe(false)
  })
  test('remote-only generic browser is a TV', () => {
    fake('Mozilla/5.0 (X11; Linux)', 0, false)
    expect(detectTvMode()).toBe(true)
  })
  test('TV UA wins even with touch points', () => {
    fake('Mozilla/5.0 (Web0S; Linux) webOS', 5, false)
    expect(detectTvMode()).toBe(true)
  })
  test('desktop is not a TV', () => {
    fake('Mozilla/5.0 (Macintosh)', 0, true)
    expect(detectTvMode()).toBe(false)
  })
})
