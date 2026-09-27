/**
 * The app's own shell, so it opens without a connection.
 *
 * Deliberately narrow: this caches only the files the app is made of. Audio and
 * manifests are never cached here. They belong to artists, they are fetched
 * from the artists' own nodes, and a copy held by Amply's service worker would
 * be a copy held by Amply.
 */
const CACHE = "amply-app-v1";
const SLOW_MS = 4000;      // no answer by then: open from the cache
const SLOW_SPELL_MS = 15000;   // and for this long after, don't wait again
let slowUntil = 0;
const SHELL = ["/app/", "/app/index.html", "/app/app.js", "/app/app.css", "/style.css"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const ours = url.origin === location.origin
    && (url.pathname.startsWith("/app/") || url.pathname === "/style.css");
  if (e.request.method !== "GET" || !ours) return;   // artists' nodes: never touched
  if (url.pathname === "/app/version.json") return;  // which build is out: never from the cache

  // Fresh when online, the cached shell when not — or when the connection is
  // so slow (a train) that waiting would leave the app blank. Then the fresh
  // copy still arrives in the background, for next time; the app notices a
  // newer version itself (update.js).
  const fresh = fetch(e.request).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
    }
    return res;
  });
  e.waitUntil(fresh.catch(() => {}));
  // Only the page itself falls back to the app's page; a script never gets
  // HTML in its place.
  const cached = () => caches.match(e.request)
    .then((hit) => hit || (e.request.mode === "navigate" ? caches.match("/app/index.html") : undefined));
  const orFresh = (hit) => hit || fresh;

  // Files named by their content never change: the saved one is as good as
  // new. And once one file has had to wait for a slow connection, the rest of
  // this opening doesn't wait again, file after file.
  const hashed = /-[A-Z0-9]{8}\.js$/.test(url.pathname);
  if (hashed || Date.now() < slowUntil) {
    e.respondWith(cached().then(orFresh).catch(() => fresh));
    return;
  }
  let answered = false;
  fresh.then(() => { answered = true; }, () => { answered = true; });
  const slow = new Promise((resolve) => setTimeout(resolve, SLOW_MS))
    .then(() => {
      if (answered) return undefined;            // it came in time: nothing to do
      slowUntil = Date.now() + SLOW_SPELL_MS;
      return cached();
    });
  e.respondWith(
    Promise.race([fresh, slow.then(orFresh)])
      .catch(() => cached().then((hit) => hit || Response.error())),
  );
});
