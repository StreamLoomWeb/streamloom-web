// Retires the service worker that earlier builds installed (ADR-0045). This site no
// longer has one: a browser that still runs the old worker fetches this file on its
// next visit, and this version empties the old caches, unregisters itself and reloads
// its tabs onto the live build. Keep it deployed; a browser that has been away for
// months still needs it to find.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await Promise.all((await caches.keys()).map((key) => caches.delete(key)))
      await self.registration.unregister()
      // The picks portal may hold unsaved edits; once uncontrolled, its next load is live anyway.
      for (const client of await self.clients.matchAll({ type: 'window' })) {
        if (!new URL(client.url).pathname.startsWith('/admin')) client.navigate(client.url).catch(() => {})
      }
    })(),
  )
})
