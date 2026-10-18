// 카페드명 재고체크 — 서비스 워커. 앱 껍데기만 저장해 두고, 동기화 서버와 폰트 요청은 건드리지 않는다.
const CACHE = 'cdm-shell-v7';
const SHELL = ['./', './index.html', './config.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/maskable-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // ntfy, 폰트 등은 그대로 네트워크로
  const freshFirst = req.mode === 'navigate' || url.pathname.endsWith('/config.js') || url.pathname.endsWith('/index.html') || url.pathname.endsWith('/img/manifest.json');
  if (freshFirst) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then(hit => {
      if (hit) return hit;
      // 꺼진 상태에서 앱 화면 주소(확장자 없는 경로)만 앱으로 연다. guide.pdf 같은 파일이 앱으로 바뀌어 열리지 않게.
      const appPath = url.pathname.endsWith('/') || url.pathname.endsWith('/index.html') || !/\.[a-z0-9]+$/i.test(url.pathname);
      return appPath ? caches.match('./index.html').then(r => r || Response.error()) : Response.error();
    })));
  } else {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    })));
  }
});
