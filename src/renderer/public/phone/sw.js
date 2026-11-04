/*
 * CLI Manager phone page — service worker. Shows the Mac's alerts (a session asks a
 * question, a turn ended) and opens that session's Chat when one is tapped: an open
 * page is told where to go, otherwise a new window opens there.
 *
 * Follows ovis public/sw.js (MIT, Copyright (c) 2026 devswha) — push → notification,
 * notificationclick → focus an open client or open one — rewritten small: no caching,
 * no offline page (the Mac is the server; without it there is nothing to show).
 */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
    let payload = { title: 'CLI Manager', body: '', url: '/', tag: 'climanager' }
    try {
        payload = { ...payload, ...event.data.json() }
    } catch {
        // a push without JSON still shows something
    }
    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        // the page in front already shows it
        if (windows.some((client) => client.focused && client.visibilityState === 'visible')) return
        await self.registration.showNotification(payload.title, {
            body: payload.body,
            tag: payload.tag,
            renotify: true,
            icon: '/phone/icon-192.png',
            badge: '/phone/icon-192.png',
            data: { url: payload.url }
        })
    })())
})

self.addEventListener('notificationclick', (event) => {
    event.notification.close()
    const target = new URL(event.notification.data?.url || '/', self.location.origin)
    if (target.origin !== self.location.origin) return
    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        for (const client of windows) {
            if (new URL(client.url).origin !== self.location.origin) continue
            client.postMessage({ type: 'open', url: target.pathname + target.search })
            if ('focus' in client) return client.focus()
        }
        return self.clients.openWindow(target.href)
    })())
})
