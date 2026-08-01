const CACHE = 'bluewave-v103';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.origin !== self.location.origin) return; // API + external (e.g. Razorpay) always network
  e.respondWith(
    fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request).then(m => m || caches.match('/')))
  );
});

/* ---------- push: works with the app closed, shows on the lock screen ---------- */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'Blue Wave', body: e.data ? e.data.text() : '' }; }
  const title = d.title || 'Blue Wave';
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: d.kind === 'order' ? 'bw-order' : 'bw-' + (d.kind || 'info'),
    renotify: true,
    vibrate: [80, 40, 80],
    data: { kind: d.kind || 'info', at: d.at || Date.now() }
  }));
});

/* tapping the notification opens the app on the notifications screen */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = '/#notifications';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.startsWith(self.location.origin)) {
        await c.focus();
        c.postMessage({ bw: 'open-notifications' });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
