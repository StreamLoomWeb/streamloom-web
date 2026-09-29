/**
 * Browser-side harness for e2e/store-subscription.spec.ts, served by the Vite dev
 * server through storeHarness.html (no app shell, so no other component shares
 * the stores while a probe mutates them).
 *
 * Each probe changes its store **during its own first render**, i.e. after it has
 * read the store and before React has committed it and run its effects. That is
 * the window a lazy route such as /watch lands in when the IndexedDB catalogue
 * arrives while the route chunk resolves: a hook that subscribes in `useEffect`
 * misses that notification and keeps showing what it rendered (the "Loading…"
 * screen that never went away). A correct hook re-renders with the new value.
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { useChannels, useFavourites, useRecent } from '../../src/hooks/useChannels'
import { getHiddenSet, hideChannel } from '../../src/util/stream'

/** Probes that have already made their change; each makes it once, in its first render. */
const changed = new Set<string>()

/** True the first time `probe` asks, false after: a render-time "only once" without a ref. */
function firstRender(probe: string): boolean {
  if (changed.has(probe)) return false
  changed.add(probe)
  return true
}

function CatalogueProbe({ channelId }: { channelId: string }) {
  useChannels()
  const size = getHiddenSet().size
  if (firstRender('catalogue')) hideChannel(channelId)
  return createElement('p', { 'data-probe': 'catalogue' }, String(size))
}

function FavouritesProbe({ channelId }: { channelId: string }) {
  const { favouriteIds, toggle } = useFavourites()
  const has = favouriteIds.has(channelId)
  if (firstRender('favourites')) toggle(channelId)
  return createElement('p', { 'data-probe': 'favourites' }, has ? 'yes' : 'no')
}

function RecentProbe({ channelId }: { channelId: string }) {
  const { recentIds, addRecent } = useRecent()
  const top = recentIds[0] ?? ''
  if (firstRender('recent')) addRecent(channelId)
  return createElement('p', { 'data-probe': 'recent' }, top)
}

export function mountProbes(channelId: string): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  createRoot(host).render(
    createElement(
      'div',
      null,
      createElement(CatalogueProbe, { channelId }),
      createElement(FavouritesProbe, { channelId }),
      createElement(RecentProbe, { channelId }),
    ),
  )
}
