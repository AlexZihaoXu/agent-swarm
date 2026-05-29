// Minimal PWA service worker: makes the dashboard installable and lets it boot
// offline (so the app shell loads and can show the "you're offline" popup,
// instead of the browser's dead-end error page). Network-first with a runtime
// cache — never caches the live API or per-agent proxy, so data/auth stay fresh.
const CACHE = 'agent-swarm-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Live, auth-gated, or per-agent traffic must always hit the network.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/a/')) return;

  event.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        caches
          .open(CACHE)
          .then((c) => c.put(request, copy))
          .catch(() => {});
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === 'navigate') {
          const shell = await caches.match('/');
          if (shell) return shell;
        }
        return Response.error();
      }),
  );
});
