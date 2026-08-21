/**
 * Hooks Screener — Service Worker
 * Handles background push notifications from the daily cron job
 */

const CACHE_NAME = 'hooks-screener-v1';

// Install — cache essential files for offline access
self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(clients.claim());
});

// Handle push notifications from server
self.addEventListener('push', event => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: 'Hooks Screener', body: event.data.text() };
  }

  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-72.png',
    tag: data.tag || 'hooks-screener',
    renotify: true,
    requireInteraction: data.requireInteraction || false,
    data: { url: data.url || '/' },
    actions: data.actions || [],
    vibrate: [200, 100, 200],
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'Hooks Screener', options)
  );
});

// Click notification — open the app
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // If app is already open, focus it
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new window
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
