// RoomChat Service Worker v4
// DŮLEŽITÉ: Změna verze vynutí re-cache všech souborů

const CACHE_NAME = 'roomchat-v4';

const PRECACHE = [
  '/',
  '/offline.html',
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
];

// ── INSTALL ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())  // okamžitě aktivuj nový SW
  );
});

// ── ACTIVATE: smaž staré cache ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => {
            console.log('[SW] Deleting old cache:', k);
            return caches.delete(k);
          })
      ))
      .then(() => self.clients.claim())  // převezmi všechny otevřené stránky
  );
});

// ── FETCH ──
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  if (e.request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  // Nikdy necachuj Firebase, Giphy, Metered
  if (url.hostname.includes('firestore.googleapis.com')) return;
  if (url.hostname.includes('firebase')) return;
  if (url.hostname.includes('giphy.com')) return;
  if (url.hostname.includes('metered.live')) return;
  if (url.hostname.includes('googleapis.com') && !url.hostname.includes('fonts')) return;

  // HTML: vždy network-first, cache fallback
  // DŮLEŽITÉ: Nikdy neservíruj cache pro HTML — vždy čerstvé JS soubory
  if (e.request.headers.get('accept')?.includes('text/html')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() =>
          caches.match(e.request)
            .then(cached => cached || caches.match('/offline.html'))
        )
    );
    return;
  }

  // JS soubory: network-first (vždy čerstvé)
  if (url.pathname.startsWith('/js/') || url.pathname.startsWith('/css/')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Fonty + ikony + manifest: cache-first
  if (
    url.hostname.includes('fonts.') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.json' ||
    url.pathname === '/favicon.ico'
  ) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          if (res.ok) caches.open(CACHE_NAME).then(c => c.put(e.request, res.clone()));
          return res;
        });
      })
    );
    return;
  }

  // Firebase SDK: network-first, cache fallback
  if (url.hostname.includes('gstatic.com')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok) caches.open(CACHE_NAME).then(c => c.put(e.request, res.clone()));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
  }
});

// ── PUSH NOTIFICATIONS ──
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data?.json() || {}; } catch { data = { title: 'PUP', body: e.data?.text() || 'Nová zpráva' }; }

  const title   = data.title || 'PUP';
  const options = {
    body:     data.body || 'Nová zpráva v místnosti',
    icon:     '/icons/icon-192x192.png',
    badge:    '/icons/icon-72x72.png',
    tag:      data.tag || 'roomchat-msg',
    renotify: true,
    silent:   false,
    vibrate:  [200, 100, 200],
    data:     { url: data.url || self.location.origin, roomId: data.roomId || null },
    actions:  [
      { action: 'open',    title: 'Otevřít chat' },
      { action: 'dismiss', title: 'Zavřít'       },
    ],
  };

  e.waitUntil(
    self.registration.showNotification(title, options).then(() => {
      if ('setAppBadge' in self.navigator) self.navigator.setAppBadge(1).catch(() => {});
    })
  );
});

// ── NOTIFICATION CLICK ──
self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;

  const roomId  = e.notification.data?.roomId;
  const openUrl = roomId
    ? `${self.location.origin}/?room=${roomId}`
    : self.location.origin;

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
      for (const c of cs) {
        if (c.url.startsWith(self.location.origin)) {
          c.postMessage({ type: 'NOTIFICATION_CLICK', roomId });
          return c.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(openUrl);
    })
  );
});

// ── NOTIFICATION CLOSE ──
self.addEventListener('notificationclose', e => {
  self.registration.getNotifications().then(notifs => {
    if (notifs.length === 0 && 'clearAppBadge' in self.navigator) {
      self.navigator.clearAppBadge().catch(() => {});
    }
  });
});

// ── MESSAGES FROM APP ──
self.addEventListener('message', e => {
  if (e.data?.type === 'CLEAR_BADGE') {
    if ('clearAppBadge' in self.navigator) self.navigator.clearAppBadge().catch(() => {});
    self.registration.getNotifications().then(notifs => notifs.forEach(n => n.close()));
  }
  if (e.data?.type === 'SET_BADGE') {
    const count = e.data.count || 0;
    if ('setAppBadge' in self.navigator) {
      (count > 0 ? self.navigator.setAppBadge(count) : self.navigator.clearAppBadge()).catch(() => {});
    }
  }
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
