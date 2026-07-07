// Angadi service worker — shows push notifications even when the site is closed.
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let d = { title: 'Angadi', body: '', url: '/' };
  try { d = Object.assign(d, event.data.json()); }
  catch (e) { if (event.data) d.body = event.data.text(); }
  event.waitUntil(
    self.registration.showNotification(d.title, {
      body: d.body,
      icon: '/angadi/icon-192.png',
      badge: '/angadi/logo.webp',
      data: { url: d.url },
      vibrate: [120, 60, 120],
      requireInteraction: true,
      tag: 'angadi-order'
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) { if ('focus' in c) { c.navigate(url); return c.focus(); } }
      return self.clients.openWindow(url);
    })
  );
});
