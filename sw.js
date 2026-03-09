// RoomChat Service Worker
const CACHE = 'roomchat-v1';

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// Push event — pro budoucí FCM integraci
self.addEventListener('push', e => {
  const data = e.data?.json() || {};
  e.waitUntil(
    self.registration.showNotification(data.title || 'PUP', {
      body: data.body || '',
      icon: data.icon || '/icon-192.png',
      badge: '/badge-72.png',
      tag: 'roomchat-msg',
      renotify: true,
      vibrate: [100, 50, 100],
      data: { url: data.url || '/' }
    })
  );
});

// Klik na notifikaci → otevřít/focusnout chat
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
      for (const c of cs) {
        if (c.url && 'focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});
