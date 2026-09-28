// Service worker for the home-screen app.
// - App shell: served from cache, refreshed in the background (not on localhost, so a
//   developer always sees the latest files). /api/* and MQTT never touch it.
// - Web Push: shows the notifications truma-x sends (faults, gas low, panel lost, test).
// The remote key stays in the URL fragment / localStorage; the worker never sees it.
const CACHE = "truma-x-v4";
const DEV = ["localhost", "127.0.0.1"].includes(self.location.hostname);
const SHELL = ["./", "index.html", "truma_remote.js", "truma_mqtt.js", "manifest.webmanifest",
               "icon.svg", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];
self.addEventListener("install", (e) => {
  e.waitUntil((DEV ? Promise.resolve() : caches.open(CACHE).then((c) => c.addAll(SHELL))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (DEV || e.request.method !== "GET" || u.origin !== location.origin || u.pathname.includes("/api/")) return;
  const page = e.request.mode === "navigate" || /\/(index\.html)?$/.test(u.pathname) || u.pathname.endsWith(".js");
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request, { cache: "no-cache" }).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; });
    if (page) {                      // page + scripts: network first (updates show at once), cache when offline
      const slow = new Promise((res) => setTimeout(() => res(null), 3500));
      try { const r = await Promise.race([net, slow]); if (r) return r; } catch (err) {}
      return hit || net;
    }
    return hit || net.catch(() => hit);   // icons etc.: cache first, refreshed in the background
  }));
});
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "truma-x", {
    body: d.body || "", tag: d.tag || "truma-x", renotify: true,
    icon: "icon-192.png", badge: "icon-192.png", data: { kind: d.kind || "" },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    for (const c of cs) if ("focus" in c) return c.focus();
    return self.clients.openWindow("./");
  }));
});
