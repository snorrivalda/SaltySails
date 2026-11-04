// SaltySails service worker: app shell is precached so the app opens with no
// signal; chart tiles you have viewed are cached so they keep working offline.
const VERSION = 'v3';
const SHELL = `saltysails-shell-${VERSION}`;
const TILES = 'saltysails-tiles';
const MAX_TILES = 6000;

const SHELL_FILES = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/geo.js',
  'data/depth-labels.json',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/layers-2x.png',
  'vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-shadow.png',
];

const TILE_HOSTS = [
  'tile.openstreetmap.org',
  'tiles.openseamap.org',
  'server.arcgisonline.com',
  'gis.natt.is', // LHG nautical charts
  'gis.lmi.is', // LHG depth contours, maritime limits
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('saltysails-shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trimTiles() {
  const cache = await caches.open(TILES);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
}

let pendingTrim = null;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Tiles: cache-first, refresh in the background when online.
  if (TILE_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.open(TILES).then(async (cache) => {
        const cached = await cache.match(req);
        const network = fetch(req)
          .then((res) => {
            if (res.ok || res.type === 'opaque') {
              cache.put(req, res.clone());
              clearTimeout(pendingTrim);
              pendingTrim = setTimeout(trimTiles, 10000);
            }
            return res;
          })
          .catch(() => cached || Response.error());
        return cached || network;
      }),
    );
    return;
  }

  // App shell: network-first so updates arrive, cache fallback when offline.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(SHELL).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
    );
  }
});
