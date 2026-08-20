/**
 * Switchboard service worker.
 *
 * Two jobs, and deliberately only two:
 *
 *  1. Cache the app shell so opening the Home Screen icon on a phone that has
 *     just woken up shows something immediately instead of a white screen —
 *     even before the tailnet link comes back.
 *  2. Receive Web Push, which on iOS only works from an installed PWA. This is
 *     the whole reason the manifest exists: an approval request that arrives
 *     ten minutes late is the same as one that never arrived.
 *
 * Run data is never cached. A stale run list is worse than no run list — it
 * would show a finished run as still going, or hide one that needs approval.
 */

const SHELL_CACHE = 'swb-shell-v4';
const SHELL = ['/', '/app.css', '/app.js', '/icon-192.png', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  // Anything live goes straight to the network, always.
  if (url.pathname.startsWith('/api/') || url.pathname === '/events' || url.pathname === '/voice') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cached only as an offline fallback — the network answer always wins
        // while there is one, so an edit is never hidden behind a stale copy.
        if (response.ok && SHELL.includes(url.pathname)) {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((hit) => hit ?? caches.match('/'))),
  );
});

// ------------------------------------------------------------------- push

self.addEventListener('push', (event) => {
  let payload = { title: 'Switchboard', body: '' };
  try {
    payload = event.data ? event.data.json() : payload;
  } catch {
    payload = { title: 'Switchboard', body: event.data ? event.data.text() : '' };
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: payload.tag,
      renotify: Boolean(payload.tag),
      requireInteraction: Boolean(payload.requireInteraction),
      actions: (payload.actions ?? []).slice(0, 2).map((a) => ({ action: a.action, title: a.title })),
      data: { ...(payload.data ?? {}), url: payload.url ?? '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  const { action } = event;
  const data = event.notification.data ?? {};
  event.notification.close();

  // Approve and deny are answered from the notification itself — the entire
  // point of the push is not having to open anything.
  const match = /^(approve|deny):(.+)$/.exec(action ?? '');
  if (match) {
    const [, verb, confirmId] = match;
    event.waitUntil(
      fetch(`/api/confirmations/${confirmId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approve: verb === 'approve' }),
      }).catch(() =>
        // If we couldn't answer, open the app so it can be answered by hand
        // rather than leaving the run parked with the human believing it's done.
        self.clients.openWindow(data.url ?? '/'),
      ),
    );
    return;
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.navigate?.(data.url ?? '/');
          return client.focus();
        }
      }
      return self.clients.openWindow(data.url ?? '/');
    }),
  );
});
