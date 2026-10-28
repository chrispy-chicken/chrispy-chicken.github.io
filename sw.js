// Offline support. Network first (so edits to your PGNs show up right away),
// falling back to the cached copy when you're offline or the network is slow.
const CACHE = 'reptrain-v1';
const TIMEOUT_MS = 3500;

const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/config.js',
  'js/pgn.js',
  'js/sound.js',
  'js/store.js',
  'vendor/chess.js',
  'vendor/chessground.js',
  'vendor/chessground.base.css',
  'vendor/chessground.cburnett.css',
  'fonts/spectral-latin-500-normal.woff2',
  'fonts/spectral-latin-600-normal.woff2',
  'fonts/spectral-latin-400-italic.woff2',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];
const INDEX = 'repertoires/index.json';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})));
    // Also cache every PGN listed in the index so the first offline launch works.
    try {
      const res = await fetch(INDEX, { cache: 'no-cache' });
      if (res.ok) {
        const index = await res.clone().json();
        await cache.put(INDEX, res);
        const base = new URL(INDEX, self.registration.scope);
        const files = [];
        for (const rep of index.repertoires || []) {
          if (rep.pgn) files.push(rep.pgn);
          for (const ch of rep.chapters || []) if (ch.pgn) files.push(ch.pgn);
        }
        await Promise.all(files.map((f) => cache.add(new URL(f, base)).catch(() => {})));
      }
    } catch { /* offline during install: fine */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const network = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  const timeout = new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS));
  try {
    const res = await Promise.race([network, timeout]);
    if (res) return res;
  } catch { /* network failed: use the cache */ }
  const cached = await cache.match(req, { ignoreSearch: true });
  if (cached) return cached;
  return network.catch(() => new Response('Offline and not cached yet.', { status: 503, headers: { 'Content-Type': 'text/plain' } }));
}
