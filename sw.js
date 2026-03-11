// RoomChat Service Worker
const CACHE = 'roomchat-v2';

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// Push event (pro budoucí FCM)
self.addEventListener('push', e => {
  const data = e.data?.json() || {};
  e.waitUntil(
    self.registration.showNotification(data.title || 'PUP', {
      body: data.body || 'Nová zpráva',
      tag: 'roomchat-msg',
      renotify: true,
      silent: true,
      data: { url: data.url || self.location.origin }
    })
  );
});

// Klik na notifikaci → focus nebo otevřít okno
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = e.notification.data?.url || self.location.origin;
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
      for (const c of cs) {
        if (c.url.includes(target) || target.includes(new URL(c.url).pathname)) {
          return c.focus();
        }
      }
      for (const c of cs) {
        if ('focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});
