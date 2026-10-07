/* 静的アセットを編集したら CACHE_NAME を必ず上げること（古いファイルが配信され続ける）

   画面のファイルはキャッシュ優先なので、先読み（install）で取った中身が次に CACHE_NAME を上げるまで使われ続ける。
   その先読みはブラウザの HTTP キャッシュを通さずサーバーから取り直す（cache: 'reload'）。GitHub Pages は max-age=600 を
   付けて返すので、ただ addAll すると公開から10分以内に取った古い app.js を先読みして、新しい index.html と混ざりうる
   （2026-10-08 にこえスタジオで見つかった）。 */
const CACHE_NAME = 'video-gallery-v8';

const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './icon.svg',
  './manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // 埋め込み iframe 等は素通し

  // シードデータは常に最新を優先（オフライン時のみキャッシュ）
  // app.js が cache: 'no-cache' で取りに来るので、request をそのまま渡せば HTTP キャッシュも通らない
  if (url.pathname.endsWith('/data/videos.json')) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(request, copy));
          return res;
        })
        .catch(() => caches.match(request)),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request)),
  );
});
