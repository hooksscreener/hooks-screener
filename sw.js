/**
 * Hooks Screener — Service Worker
 * Handles real Web Push notifications from the daily cron job via VAPID
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

// Handle incoming push from server
self.addEventListener('push', event => {
  if (!event.data) return;
  let data;
  try { data = event.data.json(); }
  catch { data = { title: 'Hooks Screener', body: event.data.text() }; }

  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-72.png',
    tag: data.tag || 'hooks-screener',
    renotify: true,
    requireInteraction: data.requireInteraction || false,
    data: { url: data.url || '/' },
    vibrate: [200, 100, 200],
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'Hooks Screener', options)
  );
});

// Tap notification → open app
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes(self.location.origin) && 'focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
