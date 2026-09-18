// src/access.ts
var CERTS_TTL_MS = 60 * 60 * 1e3;
var cache = null;
function b64urlToBytes(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - s.length % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function loadKeys(team) {
  if (cache && cache.team === team && Date.now() - cache.at < CERTS_TTL_MS) {
    return cache.keys;
  }
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error("could not fetch Access certificates");
  const { keys } = await res.json();
  const map = /* @__PURE__ */ new Map();
  for (const jwk of keys || []) {
    if (jwk.kty !== "RSA") continue;
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    map.set(jwk.kid, key);
  }
  cache = { team, keys: map, at: Date.now() };
  return map;
}
async function verifyAccess(request, config) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion") || (request.headers.get("Cookie") || "").match(/CF_Authorization=([^;]+)/)?.[1];
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header;
  let payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;
  let keys;
  try {
    keys = await loadKeys(config.team);
  } catch {
    return null;
  }
  const key = keys.get(header.kid);
  if (!key) return null;
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!ok) return null;
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(config.aud)) return null;
  if (payload.iss && payload.iss !== `https://${config.team}`) return null;
  if (!payload.exp || payload.exp * 1e3 <= Date.now()) return null;
  return payload.email || "authenticated";
}

// src/page.ts
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function safeUrl(u) {
  try {
    const parsed = new URL(String(u));
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}
var mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
function pageCsp(nonce) {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "img-src https: data:",
    "media-src https:",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'"
  ].join("; ");
}
function renderPage(manifest, origin, nonce) {
  const name = esc(manifest.artist?.name || "Untitled");
  const bio = manifest.artist?.bio ? `<p class="bio">${esc(manifest.artist.bio)}</p>` : "";
  const avatar = safeUrl(manifest.artist?.image);
  const links = (manifest.artist?.links || []).map((l) => {
    const u = safeUrl(l.url);
    return u ? `<a href="${esc(u)}" rel="noopener">${esc(l.label)}</a>` : "";
  }).join("");
  const wallet = (manifest.payment || []).find((p) => p.type === "solana-usdc");
  const support = (manifest.payment || []).filter((p) => p.type === "link").map((p) => {
    const u = safeUrl(p.url);
    return u ? `<a class="btn" href="${esc(u)}" rel="noopener">${esc(p.label)}</a>` : "";
  }).join("");
  const releases = (manifest.releases || []).map((r) => {
    const art = safeUrl(r.art);
    const tracks = (r.tracks || []).map((t) => {
      const u = safeUrl(t.url);
      if (!u) return "";
      return `<li class="t">
        <button class="play" data-src="${esc(u)}" aria-label="Play ${esc(t.title)}">\u25B6</button>
        <span class="tt">${esc(t.title)}${t.explicit ? ' <em class="e">explicit</em>' : ""}</span>
        <span class="d">${mmss(t.duration)}</span>
      </li>`;
    }).join("");
    return `<section class="r">
      ${art ? `<img class="art" src="${esc(art)}" alt="" loading="lazy">` : ""}
      <div class="rb">
        <h2>${esc(r.title)}</h2>
        ${r.date ? `<p class="date">${esc(r.date)}</p>` : ""}
        <ol class="ts">${tracks}</ol>
      </div>
    </section>`;
  }).join("");
  const empty = !(manifest.releases || []).some((r) => (r.tracks || []).length) ? `<p class="muted">No music published yet.</p>` : "";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name}</title>
<meta name="description" content="${esc(manifest.artist?.bio || `Music by ${manifest.artist?.name || ""}`).slice(0, 160)}">
<meta property="og:title" content="${name}">
<meta property="og:type" content="music.musician">
${avatar ? `<meta property="og:image" content="${esc(avatar)}">` : ""}
<style nonce="${nonce}">
:root{--ink:#17161a;--ink2:#55525c;--mut:#8a8792;--bg:#fbfaf8;--sur:#fff;--rule:#e6e3dd;--ac:#b5482a}
@media(prefers-color-scheme:dark){:root{--ink:#f2f0ec;--ink2:#b4b0a8;--mut:#86827c;--bg:#131215;--sur:#1b1a1e;--rule:#2c2a30;--ac:#e0714d}}
*{box-sizing:border-box}
body{margin:0;padding:0 20px 80px;background:var(--bg);color:var(--ink);
 font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.w{max-width:640px;margin:0 auto}
header{padding:56px 0 28px;display:flex;gap:18px;align-items:center;flex-wrap:wrap}
.av{width:76px;height:76px;border-radius:50%;object-fit:cover;flex:none}
h1{font-size:clamp(26px,5.5vw,36px);letter-spacing:-.02em;margin:0;line-height:1.1}
.bio{color:var(--ink2);margin:14px 0 0;max-width:58ch}
.links{display:flex;gap:16px;flex-wrap:wrap;margin:16px 0 0;font-size:14px}
.links a{color:var(--mut)}
a{color:var(--ac);text-underline-offset:2px}
.r{display:flex;gap:18px;padding:26px 0;border-top:1px solid var(--rule);flex-wrap:wrap}
.art{width:104px;height:104px;border-radius:7px;object-fit:cover;flex:none}
.rb{flex:1 1 260px;min-width:0}
h2{font-size:17px;margin:0}
.date{color:var(--mut);font-size:13px;margin:3px 0 12px}
.ts{list-style:none;padding:0;margin:0}
.t{display:flex;align-items:center;gap:12px;padding:7px 0}
.play{flex:none;width:28px;height:28px;border-radius:50%;border:1px solid var(--rule);
 background:var(--sur);color:var(--ink);cursor:pointer;font-size:10px;line-height:1}
.play[aria-pressed=true]{background:var(--ac);border-color:var(--ac);color:#fff}
.tt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.e{font-style:normal;font-size:11px;color:var(--mut);border:1px solid var(--rule);padding:0 5px;border-radius:3px}
.d{color:var(--mut);font-size:13px;font-variant-numeric:tabular-nums}
.pay{margin-top:34px;padding:20px;background:var(--sur);border:1px solid var(--rule);border-radius:9px}
.pay h3{margin:0 0 8px;font-size:15px}
.pay p{margin:0 0 12px;color:var(--ink2);font-size:14.5px}
.btn{display:inline-block;background:var(--ac);color:#fff;text-decoration:none;
 padding:9px 16px;border-radius:7px;font-size:14.5px;font-weight:600;margin-right:8px}
.muted{color:var(--mut)}
footer{margin-top:46px;padding-top:20px;border-top:1px solid var(--rule);color:var(--mut);font-size:13.5px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;overflow-wrap:anywhere}
</style>
</head><body><div class="w">
<header>
  ${avatar ? `<img class="av" src="${esc(avatar)}" alt="">` : ""}
  <div><h1>${name}</h1></div>
</header>
${bio}
${links ? `<div class="links">${links}</div>` : ""}
${releases}
${empty}
<div class="pay">
  <h3>Support ${name}</h3>
  ${wallet?.ratePerMinute ? `<p>Listening in an Amply player pays ${name} <strong>$${esc(wallet.ratePerMinute)}</strong> a
       minute, directly. No platform takes a cut.</p>` : `<p>Payments go straight to the artist. Nothing is taken in between.</p>`}
  ${support}
</div>
<footer>
  <p>Follow in an Amply player by adding this address:<br><code>${esc(origin)}/manifest.json</code></p>
  <p>This page is hosted by the artist, on infrastructure they own.</p>
</footer>
</div>
<script nonce="${nonce}">
// One at a time, so a second play stops the first.
let cur = null, btn = null;
document.addEventListener("click", (e) => {
  const b = e.target.closest(".play");
  if (!b) return;
  if (btn && btn !== b) { btn.setAttribute("aria-pressed", "false"); }
  if (cur && btn === b && !cur.paused) { cur.pause(); b.setAttribute("aria-pressed", "false"); return; }
  if (cur) cur.pause();
  cur = new Audio(b.dataset.src);
  btn = b;
  b.setAttribute("aria-pressed", "true");
  cur.addEventListener("ended", () => b.setAttribute("aria-pressed", "false"));
  cur.play().catch(() => b.setAttribute("aria-pressed", "false"));
});
<\/script>
</body></html>`;
}

// src/index.ts
var VERSION = "2.0.0";
var SPEC_VERSION = 1;
var MANIFEST_KEY = "manifest";
var ACCESS_KEY = "access";
var MANAGE_PREFIX = "manage";
var MAX_OBJECT = 100 * 1024 * 1024;
var MAX_MANIFEST = 2 * 1024 * 1024;
var AUDIO_TYPES = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  wav: "audio/wav",
  wave: "audio/wav",
  aiff: "audio/aiff",
  aif: "audio/aiff"
};
var IMAGE_TYPES = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif"
};
function storedType(prefix, key) {
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  const table = prefix === "art" ? IMAGE_TYPES : AUDIO_TYPES;
  return table[ext] ?? "application/octet-stream";
}
var CACHE_AUDIO = "public, max-age=31536000, immutable";
var CACHE_ART = "public, max-age=86400";
var CACHE_MANIFEST = "public, max-age=300, must-revalidate";
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Range, If-None-Match, If-Range, Content-Type, Cf-Access-Jwt-Assertion",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Content-Type, ETag, Accept-Ranges",
  "Access-Control-Max-Age": "86400"
};
function withCors(h = new Headers()) {
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  return h;
}
function fail(status, message) {
  const h = withCors(new Headers({ "Content-Type": "application/json; charset=utf-8" }));
  return new Response(JSON.stringify({ error: message }), { status, headers: h });
}
function safeKey(prefix, raw) {
  let key;
  try {
    key = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!key || key.length > 512) return null;
  if (key.includes("..") || key.startsWith("/") || key.includes("\\")) return null;
  if (/[\x00-\x1f\x7f]/.test(key)) return null;
  return `${prefix}/${key}`;
}
async function serveObject(env, request, key, cacheControl, fallbackType) {
  const wantsRange = request.headers.has("Range");
  let object;
  try {
    object = await env.MEDIA.get(key, {
      range: request.headers,
      onlyIf: request.headers
    });
  } catch {
    const meta = await env.MEDIA.head(key);
    if (meta === null) return fail(404, "not found");
    const h = withCors(new Headers());
    h.set("Content-Range", `bytes */${meta.size}`);
    h.set("Accept-Ranges", "bytes");
    return new Response(null, { status: 416, headers: h });
  }
  if (object === null) return fail(404, "not found");
  const headers = withCors(new Headers());
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Cache-Control", cacheControl);
  headers.set("Accept-Ranges", "bytes");
  if (!headers.has("Content-Type")) headers.set("Content-Type", fallbackType);
  if (!("body" in object) || object.body === null) {
    return new Response(null, { status: 304, headers });
  }
  let status = 200;
  const range = wantsRange ? object.range : void 0;
  if (range && (range.offset !== void 0 || range.length !== void 0)) {
    const offset = range.offset ?? 0;
    const length = range.length ?? object.size - offset;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("Content-Length", String(length));
    status = 206;
  } else {
    headers.set("Content-Length", String(object.size));
  }
  if (request.method === "HEAD") return new Response(null, { status, headers });
  return new Response(object.body, { status, headers });
}
async function serveManifest(env) {
  const body = await env.MANIFEST.get(MANIFEST_KEY, "text");
  if (body === null) {
    return fail(404, "no manifest published yet");
  }
  const headers = withCors(
    new Headers({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": CACHE_MANIFEST,
      "X-Amply-Spec": String(SPEC_VERSION)
    })
  );
  return new Response(body, { status: 200, headers });
}
async function accessConfig(env) {
  const raw = await env.MANIFEST.get(ACCESS_KEY, "json");
  const c = raw;
  return c && c.team && c.aud ? c : null;
}
function noStore(extra) {
  const h = withCors(new Headers(extra));
  h.set("Cache-Control", "no-store");
  return h;
}
async function handleManage(request, env, path) {
  const config = await accessConfig(env);
  if (!config) {
    return fail(503, "this node has no editor configured");
  }
  const email = await verifyAccess(request, config);
  if (!email) {
    return fail(401, "not signed in");
  }
  if (request.method === "GET" && (path === "" || path === "/")) {
    const obj = await env.MEDIA.get(`${MANAGE_PREFIX}/index.html`);
    if (obj === null) return fail(404, "editor not installed on this node");
    const h = noStore({ "Content-Type": "text/html; charset=utf-8" });
    h.set("Content-Security-Policy", [
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      "img-src 'self' data:",
      "media-src 'self'",
      "connect-src 'self'",
      "form-action 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'"
    ].join("; "));
    return new Response(obj.body, { status: 200, headers: h });
  }
  if (request.method === "GET" && path === "/whoami") {
    return new Response(JSON.stringify({ email, version: VERSION }), {
      status: 200,
      headers: noStore({ "Content-Type": "application/json; charset=utf-8" })
    });
  }
  if (request.method === "PUT" && path === "/manifest") {
    if (Number(request.headers.get("Content-Length") || 0) > MAX_MANIFEST) {
      return fail(413, "manifest too large");
    }
    const text = await request.text();
    if (text.length > MAX_MANIFEST) return fail(413, "manifest too large");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fail(400, "manifest is not valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || parsed.amply !== 1) {
      return fail(400, "not an Amply v1 manifest");
    }
    await env.MANIFEST.put(MANIFEST_KEY, text);
    return new Response(null, { status: 204, headers: noStore() });
  }
  const media = path.match(/^\/(audio|art)\/(.+)$/);
  if (media) {
    const key = safeKey(media[1], media[2]);
    if (key === null) return fail(400, "bad key");
    if (request.method === "PUT") {
      const length = Number(request.headers.get("Content-Length") || 0);
      if (length > MAX_OBJECT) return fail(413, "file too large");
      await env.MEDIA.put(key, request.body, {
        httpMetadata: { contentType: storedType(media[1], key) }
      });
      return new Response(null, { status: 204, headers: noStore() });
    }
    if (request.method === "DELETE") {
      await env.MEDIA.delete(key);
      return new Response(null, { status: 204, headers: noStore() });
    }
  }
  return fail(404, "not found");
}
var index_default = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: withCors() });
    }
    const { pathname } = new URL(request.url);
    if (pathname === "/manage" || pathname.startsWith("/manage/")) {
      return handleManage(request, env, pathname.slice("/manage".length));
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      const h = withCors(new Headers({ Allow: "GET, HEAD, OPTIONS" }));
      return new Response(null, { status: 405, headers: h });
    }
    if (pathname === "/") {
      const body = await env.MANIFEST.get(MANIFEST_KEY, "text");
      if (body === null) return fail(404, "no manifest published yet");
      let manifest;
      try {
        manifest = JSON.parse(body);
      } catch {
        return fail(500, "manifest is not valid JSON");
      }
      const nonce = crypto.randomUUID().replace(/-/g, "");
      const headers = withCors(new Headers({
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": pageCsp(nonce)
      }));
      if (request.method === "HEAD") return new Response(null, { status: 200, headers });
      return new Response(renderPage(manifest, new URL(request.url).origin, nonce), {
        status: 200,
        headers
      });
    }
    if (pathname === "/manifest.json") return serveManifest(env);
    if (pathname === "/version") {
      const headers = withCors(
        new Headers({
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store"
        })
      );
      return new Response(
        JSON.stringify({ version: VERSION, spec: SPEC_VERSION }),
        { status: 200, headers }
      );
    }
    if (pathname.startsWith("/audio/")) {
      const key = safeKey("audio", pathname.slice("/audio/".length));
      if (key === null) return fail(400, "bad key");
      return serveObject(env, request, key, CACHE_AUDIO, "audio/mpeg");
    }
    if (pathname.startsWith("/art/")) {
      const key = safeKey("art", pathname.slice("/art/".length));
      if (key === null) return fail(400, "bad key");
      return serveObject(env, request, key, CACHE_ART, "image/jpeg");
    }
    return fail(404, "not found");
  }
};
export {
  SPEC_VERSION,
  VERSION,
  index_default as default
};
