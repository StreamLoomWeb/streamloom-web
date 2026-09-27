import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Navbar } from './components/Navbar'
import { Home } from './pages/Home'
import { Guide } from './pages/Guide'
import { Favorites } from './pages/Favorites'
import { Settings } from './pages/Settings'
import { afterCatalogue } from './hooks/useChannels'
import { connectionInfo } from './util/bandwidth'
import { loadWatch } from './util/watchChunk'
import { applyTvMode } from './util/tvMode'

// Runs once at module load, before the first paint: a TV browser's overscan
// padding and type scale (see index.css) need to be in the initial CSSOM,
// not applied after a flash of the desktop layout.
applyTvMode()

/*
 * The watch route is the only consumer of VideoPlayer, which pulls in hls.js
 * (~575 kB raw). Loading it on demand keeps the media engine out of the
 * initial payload so the catalogue grid can paint without waiting on it.
 */
const Watch = lazy(() => loadWatch().then((m) => ({ default: m.Watch })))

/*
 * ...but the first channel a visitor opens then waits on that download and parse
 * (measured 0.4-0.8 s before the player could even start). So the chunk is fetched
 * once a catalogue is on screen and the page is idle, so it never competes with the
 * first paint or the catalogue download, unless the visitor asked to save data or
 * is on a 2G-class link.
 */
function usePrefetchPlayer() {
  useEffect(() => {
    const c = connectionInfo()
    if (c?.saveData || /2g/.test(c?.effectiveType ?? '')) return
    let cancelIdle = () => {}
    const stop = afterCatalogue(() => {
      const prefetch = () => void loadWatch().catch(() => {})
      if ('requestIdleCallback' in window) {
        const id = requestIdleCallback(prefetch, { timeout: 3000 })
        cancelIdle = () => cancelIdleCallback(id)
      } else {
        const id = setTimeout(prefetch, 1000)
        cancelIdle = () => clearTimeout(id)
      }
    })
    return () => {
      stop()
      cancelIdle()
    }
  }, [])
}

/*
 * The picks portal (ADR-0033). Unlisted: nothing links to it, it is in no
 * sitemap, and `public/_headers` serves it `noindex` and `no-store`. Lazy so the
 * editor is a chunk of its own and never reaches a visitor who does not ask for
 * it — and so the catalogue grid is not made slower by a page one person uses.
 *
 * Being unlisted is not the security control: Cloudflare Access is, and the
 * Function behind `/api/picks` verifies the Access JWT itself, so this route
 * being reachable gives nobody the ability to write anything.
 */
const Admin = lazy(() => import('./pages/Admin').then((m) => ({ default: m.Admin })))

export default function App() {
  usePrefetchPlayer()
  return (
    <BrowserRouter>
      <Routes>
        {/* Watch page hides the navbar for an immersive full screen experience */}
        <Route
          path="/watch/:channelId"
          element={
            <Suspense fallback={<div style={{ minHeight: '100dvh', background: 'var(--bg-base)' }} />}>
              <Watch />
            </Suspense>
          }
        />

        {/* All other pages show the navbar */}
        <Route
          path="*"
          element={
            <>
              <Navbar />
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/guide" element={<Guide />} />
                <Route path="/favourites" element={<Favorites />} />
                <Route path="/settings" element={<Settings />} />
                <Route
                  path="/admin"
                  element={
                    <Suspense fallback={<div style={{ minHeight: '50dvh' }} />}>
                      <Admin />
                    </Suspense>
                  }
                />
                <Route path="*" element={<Home />} />
              </Routes>
            </>
          }
        />
      </Routes>
    </BrowserRouter>
  )
}
