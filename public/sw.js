// Service Worker：页面与脚本走网络优先（保证新版本立即生效），其余静态资源缓存优先，API 始终走网络
const CACHE = "icucoach-v44";
const STATIC = ["/", "/index.html", "/style.css", "/app.js", "/manifest.json", "/icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIC)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // API 请求不缓存
  if (url.pathname.startsWith("/api/")) return;

  // 页面、脚本、样式：一律网络优先（避免旧 CSS 配新 JS，界面元素错位或按钮常显）
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return r;
        })
        .catch(() =>
          caches.match(e.request).then((hit) => hit || caches.match("/index.html"))
        )
    );
    return;
  }

  // 其它静态资源：缓存优先
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match("/index.html")))
  );
});
