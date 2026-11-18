var __toBinary = Uint8Array.fromBase64 || /* @__PURE__ */ (() => {
  var table = new Uint8Array(128);
  for (var i = 0; i < 64; i++) table[i < 26 ? i + 65 : i < 52 ? i + 71 : i < 62 ? i - 4 : i * 4 - 205] = i;
  return (base642) => {
    var n = base642.length, bytes = new Uint8Array((n - (base642[n - 1] == "=") - (base642[n - 2] == "=")) * 3 / 4 | 0);
    for (var i2 = 0, j = 0; i2 < n; ) {
      var c0 = table[base642.charCodeAt(i2++)], c1 = table[base642.charCodeAt(i2++)];
      var c2 = table[base642.charCodeAt(i2++)], c3 = table[base642.charCodeAt(i2++)];
      bytes[j++] = c0 << 2 | c1 >> 4;
      bytes[j++] = c1 << 4 | c2 >> 2;
      bytes[j++] = c2 << 6 | c3;
    }
    return bytes;
  };
})();

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
  if (payload.iss !== `https://${config.team}`) return null;
  const now = Date.now();
  if (!payload.exp || payload.exp * 1e3 <= now) return null;
  const SKEW = 6e4;
  if (payload.nbf && payload.nbf * 1e3 > now + SKEW) return null;
  if (payload.iat && payload.iat * 1e3 > now + SKEW) return null;
  return payload.email || "authenticated";
}

// src/preview-key.ts
var PREVIEW_KEY = "preview-key";
var COOKIE = "amply_preview";
var CLAIM = /^https:\/\/dash\.cloudflare\.com\/[^\s"<>]+$/;
function readPreviewKey(raw) {
  if (!raw) return null;
  try {
    const k = JSON.parse(raw);
    if (!k || !/^[0-9a-f]{64}$/.test(k.hash) || !Number.isFinite(k.until)) return null;
    const out = { hash: k.hash, until: k.until };
    if (k.claimed === true) return { ...out, claimed: true };
    if (typeof k.claim === "string" && CLAIM.test(k.claim) && Number.isFinite(k.claimUntil)) {
      out.claim = k.claim;
      out.claimUntil = k.claimUntil;
    }
    if (typeof k.token === "string" && /^[A-Za-z0-9._-]{20,512}$/.test(k.token)) out.token = k.token;
    return out;
  } catch {
    return null;
  }
}
async function claimedYet(k, pause = 1500) {
  if (k.claimed) return true;
  if (!k.token) return null;
  const first = await tokenStanding(k.token);
  if (first === "works") return false;
  if (first !== "gone") return null;
  await new Promise((r) => setTimeout(r, pause));
  return await tokenStanding(k.token) === "gone" ? true : null;
}
var TOKEN_REFUSED = /* @__PURE__ */ new Set([1e3, 9109, 1e4, 10001]);
async function tokenStanding(token) {
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/accounts?per_page=1", {
      headers: { Authorization: `Bearer ${token}` }
    });
    const body = await res.json().catch(() => null);
    if (res.ok) return Array.isArray(body?.result) && body.result.length === 0 ? "gone" : "works";
    if (res.status === 401) return "gone";
    if (res.status === 403 && (body?.errors || []).some((e) => TOKEN_REFUSED.has(Number(e.code)))) return "gone";
    return null;
  } catch {
    return null;
  }
}
var afterClaim = (k) => ({ hash: k.hash, until: k.until, claimed: true });
function previewNotice(k, claimed, now = Date.now()) {
  return {
    until: new Date(k.until).toISOString(),
    claimed: claimed === true,
    claim: claimed !== true && k.claim && k.claimUntil > now ? k.claim : null
  };
}
async function hashKey(key) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
var shaped = (key) => typeof key === "string" && /^[A-Za-z0-9_-]{43}$/.test(key);
async function matches(key, stored, now) {
  if (!stored || now >= stored.until || !shaped(key)) return false;
  return await hashKey(key) === stored.hash;
}
function cookieOf(request) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=");
  }
  return null;
}
function previewSession(request, stored, now = Date.now()) {
  return matches(cookieOf(request), stored, now);
}
var OPEN_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Opening your editor</title><p id="m" style="font:16px system-ui;margin:40px 16px">Opening your editor\u2026</p>
<script>
const key = location.hash.slice(1);
history.replaceState(null, "", location.pathname);
fetch("/manage/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) })
  .then((r) => r.ok ? location.replace("/manage") : r.text().then((t) => { document.getElementById("m").textContent = t; }))
  .catch(() => { document.getElementById("m").textContent = "Couldn't reach your page. Check your connection and try again."; });
<\/script>`;
async function openPreview(request, stored, now = Date.now()) {
  let key = null;
  try {
    key = (await request.json())?.key;
  } catch {
    key = null;
  }
  if (!await matches(key, stored, now)) {
    return new Response(
      "This link no longer opens your editor. If you've claimed your page, finish at amply.stream/start to open it.",
      { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } }
    );
  }
  const seconds = Math.max(0, Math.floor((stored.until - now) / 1e3));
  return new Response(null, {
    status: 204,
    headers: {
      "Set-Cookie": `${COOKIE}=${key}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`,
      "Cache-Control": "no-store"
    }
  });
}
function arriving(request) {
  const site = request.headers.get("Sec-Fetch-Site");
  return request.method === "GET" && (site === "cross-site" || site === "none") && cookieOf(request) !== null;
}
var SECURING_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta http-equiv="refresh" content="5"><title>Turning on your sign-in</title>
<p style="font:16px system-ui;margin:40px 16px;max-width:30em">Turning on your sign-in. This takes a minute,
and the page reloads by itself.</p>`;

// ../spec/pricing.mjs
var FEES_READY_LAMPORTS = 3e6;
var LISTEN_MIN_MICROS = 1e4;
var LISTEN_MAX_MICROS = 2e6;
var isPaused = (p) => p?.paused === true;
function paused(manifest) {
  return (manifest?.payment || []).some((p) => p && p.type === "solana-usdc" && isPaused(p));
}
function perMinute(manifest) {
  return (manifest?.payment || []).some(
    (p) => p && p.type === "solana-usdc" && Number(p.ratePerMinute) > 0 && !isPaused(p)
  );
}
function plans(manifest) {
  const sub = (manifest?.payment || []).find((p) => p && p.type === "stripe-subscription");
  return Array.isArray(sub?.plans) ? sub.plans.filter((p) => p && p.url && p.months && p.price > 0) : [];
}
function charges(manifest) {
  return perMinute(manifest) || plans(manifest).length > 0;
}
function subscriptionOnly(manifest) {
  return plans(manifest).length > 0 && !perMinute(manifest) && !paused(manifest);
}
function needsWallet(manifest, track) {
  if (!track) return false;
  if (track.free === true) return false;
  if (track.needsWallet === true) return true;
  return charges(manifest);
}
var DOWNLOADS_PER_PURCHASE = 5;
function walletOf(manifest) {
  const w = (manifest?.payment || []).find((p) => p && p.type === "solana-usdc");
  if (!w || isPaused(w)) return null;
  const recipients = Array.isArray(w.recipients) && w.recipients.length ? w.recipients.filter((r) => r && r.address) : w.address ? [{ address: w.address, split: 100 }] : [];
  return recipients.length ? { recipients, network: w.network || "solana" } : null;
}
function saleOf(manifest, item) {
  const s = item?.sale;
  if (!s || typeof s.price !== "number" || !(s.price >= 0.5) || s.currency && s.currency !== "usd") return null;
  const card = typeof s.url === "string" && /^https:\/\/([a-z0-9-]+\.)*stripe\.com\//.test(s.url) ? s.url : null;
  const wallet = walletOf(manifest);
  if (!card && !wallet) return null;
  return { price: s.price, card, wallet };
}
function forSale(manifest) {
  const out = [];
  for (const r of manifest?.releases || []) {
    const rs = saleOf(manifest, r);
    if (rs) out.push({ id: r.id, kind: "album", title: r.title, tracks: (r.tracks || []).map((t) => t.id), ...rs });
    for (const t of r.tracks || []) {
      const ts = saleOf(manifest, t);
      if (ts) out.push({ id: t.id, kind: "song", title: t.title, tracks: [t.id], ...ts });
    }
  }
  return out;
}
function includes(manifest, trackId) {
  for (const r of manifest?.releases || []) {
    if ((r.tracks || []).some((t) => t.id === trackId)) return [trackId, r.id];
  }
  return [];
}
function shareOut(micros, recipients) {
  const total = Math.max(0, Math.floor(micros));
  if (!recipients.length || total === 0) return [];
  const exact = recipients.map((r) => total * (Number(r.split) || 0) / 100);
  const parts = exact.map((e) => Math.floor(e));
  let left = total - parts.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => ({ i, frac: e - Math.floor(e) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0; k++, left--) parts[order[k % order.length].i] += 1;
  return recipients.map((r, i) => ({ ...r, micros: parts[i] })).filter((r) => r.micros > 0);
}

// ../spec/site.mjs
var SITE_VERSION = 1;
var SECTION_TYPES = {
  music: { label: "Music", hint: "Your releases, with play buttons." },
  about: { label: "About", hint: "A picture and a few paragraphs about you." },
  news: { label: "News", hint: "Short posts: a new song, a tour, a thank-you." },
  shows: { label: "Shows", hint: "Dates, places and ticket links." },
  merch: { label: "Merch", hint: "Things you sell elsewhere, with a link to buy." },
  links: { label: "Links", hint: "Your other places: Instagram, Bandcamp, a newsletter." }
};
var THEMES = {
  light: { label: "Light", bg: "#ffffff", bg2: "#f7f4f1", ink: "#131110", ink2: "#4a4644", mut: "#66615d", line: "#e3ddd8" },
  dark: { label: "Dark", bg: "#121110", bg2: "#1d1b19", ink: "#f7f3ef", ink2: "#d4ccc4", mut: "#a39a92", line: "#34302c" },
  paper: { label: "Paper", bg: "#f4eee3", bg2: "#ebe3d4", ink: "#231d16", ink2: "#4b4134", mut: "#76695a", line: "#d8ccb8" }
};
var FONTS = {
  sans: { label: "Clean", css: '"Archivo",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Helvetica,sans-serif' },
  serif: { label: "Classic", css: 'ui-serif,Georgia,"Times New Roman",serif' },
  mono: { label: "Typewriter", css: "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" }
};
var MAX = { short: 120, text: 4e3, url: 500, sections: 16, items: 40, label: 60, price: 20 };
var str = (v, n) => typeof v === "string" ? v.replace(/\r\n?/g, "\n").slice(0, n) : "";
var line = (v, n) => str(v, n).replace(/\s+/g, " ").trim();
function httpsUrl(v) {
  try {
    const u = new URL(String(v || "").trim());
    return u.protocol === "https:" && u.href.length <= MAX.url ? u.href : "";
  } catch {
    return "";
  }
}
var date = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "";
var colour = (v, d) => /^#[0-9a-f]{6}$/i.test(String(v || "")) ? String(v).toLowerCase() : d;
var idOf = (v, i) => /^[a-z0-9-]{1,40}$/.test(String(v || "")) ? String(v) : `s${i}`;
function cleanSite(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const look = r.look || {};
  const hero = r.hero || {};
  const seen2 = /* @__PURE__ */ new Set();
  const sections = (Array.isArray(r.sections) ? r.sections : []).slice(0, MAX.sections).map((s, i) => {
    if (!s || !SECTION_TYPES[s.type]) return null;
    let id = idOf(s.id, i);
    while (seen2.has(id)) id = `${id}-${i}`;
    seen2.add(id);
    const out = { id, type: s.type, title: line(s.title, MAX.short) || SECTION_TYPES[s.type].label };
    if (s.hidden === true) out.hidden = true;
    const items = (Array.isArray(s.items) ? s.items : []).slice(0, MAX.items);
    if (s.type === "about") {
      out.text = str(s.text, MAX.text);
      out.image = httpsUrl(s.image);
    }
    if (s.type === "news") {
      out.items = items.map((p, k) => ({
        id: idOf(p?.id, k),
        title: line(p?.title, MAX.short),
        date: date(p?.date),
        text: str(p?.text, MAX.text),
        image: httpsUrl(p?.image)
      }));
    }
    if (s.type === "shows") {
      out.items = items.map((p, k) => ({
        id: idOf(p?.id, k),
        date: date(p?.date),
        city: line(p?.city, MAX.short),
        venue: line(p?.venue, MAX.short),
        url: httpsUrl(p?.url)
      }));
    }
    if (s.type === "merch") {
      out.items = items.map((p, k) => ({
        id: idOf(p?.id, k),
        name: line(p?.name, MAX.short),
        price: line(p?.price, MAX.price),
        image: httpsUrl(p?.image),
        url: httpsUrl(p?.url)
      }));
    }
    if (s.type === "links") {
      out.items = items.map((p, k) => ({ id: idOf(p?.id, k), label: line(p?.label, MAX.label), url: httpsUrl(p?.url) }));
    }
    return out;
  }).filter(Boolean);
  return {
    v: SITE_VERSION,
    // Off: visitors get the plain music page; the site is kept, ready to turn
    // back on. Absent means on, as every site made before this was.
    on: r.on !== false,
    look: {
      theme: THEMES[look.theme] ? look.theme : "light",
      font: FONTS[look.font] ? look.font : "sans",
      accent: colour(look.accent, "#f6711e")
    },
    hero: { title: line(hero.title, MAX.short), tagline: str(hero.tagline, 300), image: httpsUrl(hero.image) },
    sections
  };
}
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
var paras = (t) => esc(t).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
var niceDate = (d) => {
  if (!d) return "";
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};
function renderSite(input, manifest, { edit = false, slots = {}, listenUrl = "" } = {}) {
  const site = cleanSite(input);
  const t = THEMES[site.look.theme];
  const font = FONTS[site.look.font].css;
  const e = (path, kind) => edit ? ` data-edit="${esc(path)}" data-kind="${kind}"` : "";
  const ph = (value, placeholder) => value ? esc(value) : edit ? `<span class="ph">${esc(placeholder)}</span>` : "";
  const img = (src, path, cls, placeholder) => src ? `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy"${e(path, "image")}>` : edit ? `<div class="${cls} ph-img"${e(path, "image")}>${esc(placeholder)}</div>` : "";
  const name = site.hero.title || manifest?.artist?.name || "";
  const shown = site.sections.filter((s) => edit || !s.hidden);
  const nav = shown.filter((s) => !s.hidden).map((s) => `<a href="#${esc(s.id)}">${esc(s.title)}</a>`).join("");
  const heroImg = site.hero.image;
  const hero = `<header class="s-hero${heroImg ? " has-img" : ""}" data-section="hero">
  ${heroImg ? `<img class="s-hero-img" src="${esc(heroImg)}" alt=""${e("hero.image", "image")}>` : edit ? `<div class="s-hero-img ph-img"${e("hero.image", "image")}>Click to add a banner picture</div>` : ""}
  <div class="s-hero-in">
    <h1${e("hero.title", "text")}>${ph(name, "Your name")}</h1>
    ${site.hero.tagline || edit ? `<p class="s-tag"${e("hero.tagline", "long")}>${ph(site.hero.tagline, "Click to add a line about you")}</p>` : ""}
    ${listenUrl ? `<a class="s-btn" href="${esc(listenUrl)}">Listen to my music</a>` : edit ? `<span class="s-btn">Listen to my music</span>` : ""}
  </div>
</header>`;
  const sections = shown.map((s, i) => {
    const p = `sections.${i}`;
    const head = `<h2${e(`${p}.title`, "text")}>${esc(s.title)}</h2>`;
    let inner = "";
    if (s.type === "music") {
      const rel = (manifest?.releases || []).filter((r) => (r.tracks || []).length);
      inner = slots.music || (rel.length ? `<div class="s-rel">${rel.map((r) => `<div class="s-rel-one">
        ${httpsUrl(r.art) ? `<img src="${esc(httpsUrl(r.art))}" alt="">` : `<div class="s-rel-art"></div>`}
        <div><b>${esc(r.title)}</b><p class="muted">${(r.tracks || []).map((t2) => esc(t2.title)).join(" \xB7 ")}</p></div>
      </div>`).join("")}</div>` : `<p class="muted">Your releases appear here once you add music.</p>`);
    } else if (s.type === "about") {
      inner = `<div class="s-about">${img(s.image, `${p}.image`, "s-about-img", "Click to add a picture")}
        <div class="s-text"${e(`${p}.text`, "long")}>${s.text ? paras(s.text) : edit ? `<p class="ph">Click to write a few lines about you</p>` : ""}</div></div>`;
    } else if (s.type === "news") {
      inner = `<div class="s-news">${(s.items || []).map((n, k) => `<article class="s-post" data-item="${p}.items.${k}">
        ${img(n.image, `${p}.items.${k}.image`, "s-post-img", "Click to add a picture")}
        <p class="s-date"${e(`${p}.items.${k}.date`, "date")}>${ph(niceDate(n.date), "Date")}</p>
        <h3${e(`${p}.items.${k}.title`, "text")}>${ph(n.title, "Title")}</h3>
        <div class="s-text"${e(`${p}.items.${k}.text`, "long")}>${n.text ? paras(n.text) : edit ? `<p class="ph">Click to write the post</p>` : ""}</div>
      </article>`).join("") || (edit ? `<p class="ph">No posts yet</p>` : "")}</div>`;
    } else if (s.type === "shows") {
      const rows = (s.items || []).filter((x) => edit || x.city || x.venue);
      inner = rows.length ? `<ul class="s-shows">${rows.map((x, k) => `<li data-item="${p}.items.${k}">
        <span class="s-date"${e(`${p}.items.${k}.date`, "date")}>${ph(niceDate(x.date), "Date")}</span>
        <span class="s-where"><b${e(`${p}.items.${k}.city`, "text")}>${ph(x.city, "City")}</b> <span${e(`${p}.items.${k}.venue`, "text")}>${ph(x.venue, "Venue")}</span></span>
        ${x.url ? `<a class="s-btn sm" href="${esc(x.url)}" rel="noopener"${e(`${p}.items.${k}.url`, "url")}>Tickets</a>` : edit ? `<span class="s-btn sm ghost"${e(`${p}.items.${k}.url`, "url")}>Add ticket link</span>` : ""}
      </li>`).join("")}</ul>` : `<p class="muted">No shows announced right now.</p>`;
    } else if (s.type === "merch") {
      inner = `<div class="s-merch">${(s.items || []).map((x, k) => `<div class="s-card" data-item="${p}.items.${k}">
        ${img(x.image, `${p}.items.${k}.image`, "s-card-img", "Click to add a picture")}
        <b${e(`${p}.items.${k}.name`, "text")}>${ph(x.name, "Name")}</b>
        <span class="muted"${e(`${p}.items.${k}.price`, "text")}>${ph(x.price, "Price")}</span>
        ${x.url ? `<a class="s-btn sm" href="${esc(x.url)}" rel="noopener"${e(`${p}.items.${k}.url`, "url")}>Buy</a>` : edit ? `<span class="s-btn sm ghost"${e(`${p}.items.${k}.url`, "url")}>Add shop link</span>` : ""}
      </div>`).join("")}</div>`;
    } else if (s.type === "links") {
      const items = (s.items || []).filter((x) => edit || x.url);
      inner = `<div class="s-links">${items.map((x, k) => edit ? `<span class="s-link" data-item="${p}.items.${k}"><span${e(`${p}.items.${k}.label`, "text")}>${ph(x.label, "Label")}</span> <span class="s-url"${e(`${p}.items.${k}.url`, "url")}>${x.url ? "\u2197" : "add link"}</span></span>` : `<a class="s-link" href="${esc(x.url)}" rel="noopener">${esc(x.label || x.url)} \u2197</a>`).join("")}</div>`;
    }
    return `<section class="s-sec s-sec-${s.type}${s.hidden ? " is-hidden" : ""}" id="${esc(s.id)}" data-section="${i}">${head}${inner}</section>`;
  }).join("\n");
  const dark = site.look.theme === "dark";
  const css = `
.s-site{--bg:${t.bg};--bg2:${t.bg2};--ink:${t.ink};--ink2:${t.ink2};--mut:${t.mut};--line:${t.line};--ac:${site.look.accent};
 background:var(--bg);color:var(--ink);font:17px/1.6 ${font};-webkit-font-smoothing:antialiased;min-height:100%}
.s-site *{box-sizing:border-box}
.s-site a{color:var(--ac);text-underline-offset:2px}
.s-site .muted{color:var(--mut)}
.s-nav{position:sticky;top:0;z-index:2;display:flex;gap:22px;justify-content:center;flex-wrap:wrap;padding:14px 20px;
 background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);font-size:15px;font-weight:600}
.s-nav a{color:var(--ink);text-decoration:none}
.s-hero{position:relative;min-height:clamp(320px,52vh,560px);display:flex;align-items:flex-end;overflow:hidden;background:var(--bg2)}
.s-hero-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.s-hero.has-img::after{content:"";position:absolute;inset:0;background:linear-gradient(transparent 30%,rgba(0,0,0,.6))}
/* The banner is 8:3 here as in the editor and the app. Wide enough, the name sits on it; on a
   narrower screen it would not fit on a picture that short, so the name goes under it instead. */
.s-hero.has-img{min-height:auto;aspect-ratio:8/3}
@media(max-width:799px){
 .s-hero.has-img{display:block;aspect-ratio:auto;padding:0}
 .s-hero.has-img .s-hero-img{position:relative;display:block;height:auto;aspect-ratio:8/3}
 .s-hero.has-img::after{content:none}
}
.s-hero-in{position:relative;z-index:1;width:100%;max-width:960px;margin:0 auto;padding:clamp(28px,5vw,56px) clamp(20px,4vw,48px)}
@media(min-width:800px){.s-hero.has-img .s-hero-in{color:#fff}}
.s-hero h1{font-size:clamp(44px,9vw,104px);line-height:.92;letter-spacing:-.045em;margin:0;font-weight:800}
.s-tag{font-size:clamp(17px,2vw,21px);margin:16px 0 0;max-width:34em;opacity:.9}
.s-btn{display:inline-block;margin-top:24px;background:var(--ac);color:#131110 !important;text-decoration:none;font-weight:700;
 padding:13px 24px;border-radius:999px;font-size:16px}
.s-btn.sm{margin:0;padding:8px 16px;font-size:14px}
.s-btn.ghost{background:transparent;border:1.5px dashed var(--line);color:var(--mut) !important}
/* Lit buttons: a light top edge, a darker bottom edge, a tight drop shadow, and a soft
   glow in the button's own colour (--glow: the accent). Links and the dashed placeholder
   get the quiet version. Pressed: smaller glow, no bottom edge. */
.s-site{--lit-hi:rgba(255,255,255,.35);--lit-lo:rgba(0,0,0,.2);--lit-drop:rgba(0,0,0,.4);
 --lit-sheen:linear-gradient(180deg,rgba(255,255,255,.16),rgba(255,255,255,0) 70%);
 --lit-quiet:${dark ? "inset 0 1px 0 rgba(255,255,255,.08),inset 0 -2px 0 rgba(0,0,0,.3),0 1px 2px rgba(0,0,0,.5)" : "inset 0 1px 0 rgba(255,255,255,.9),inset 0 -2px 0 rgba(19,17,16,.07),0 1px 2px rgba(19,17,16,.14)"};
 --lit-quiet-down:${dark ? "inset 0 1px 0 rgba(255,255,255,.06),0 1px 1px rgba(0,0,0,.5)" : "inset 0 1px 0 rgba(255,255,255,.9),0 1px 1px rgba(19,17,16,.12)"}}
.s-btn{--glow:var(--ac);--glow-a:60%;background-image:var(--lit-sheen);
 box-shadow:inset 0 1px 0 var(--lit-hi),inset 0 -2px 0 var(--lit-lo),0 1px 2px var(--lit-drop),0 8px 24px -6px color-mix(in srgb,var(--glow) var(--glow-a),transparent);
 transition:box-shadow .15s ease}
.s-btn.sm{box-shadow:inset 0 1px 0 var(--lit-hi),inset 0 -2px 0 var(--lit-lo),0 1px 2px var(--lit-drop),0 5px 14px -4px color-mix(in srgb,var(--glow) var(--glow-a),transparent)}
.s-btn:hover{--glow-a:80%}
.s-btn:active{box-shadow:inset 0 1px 0 var(--lit-hi),0 1px 2px var(--lit-drop),0 3px 10px -5px color-mix(in srgb,var(--glow) var(--glow-a),transparent)}
.s-btn.ghost,.s-btn.ghost:active{background-image:none;box-shadow:none}
.s-link{box-shadow:var(--lit-quiet);transition:box-shadow .15s ease}
.s-link:active{box-shadow:var(--lit-quiet-down)}
@media (prefers-reduced-motion:reduce){.s-btn,.s-link{transition:none}}
.s-sec{max-width:960px;margin:0 auto;padding:clamp(40px,6vw,72px) clamp(20px,4vw,48px);border-top:1px solid var(--line)}
.s-sec h2{font-size:clamp(28px,4vw,40px);letter-spacing:-.03em;margin:0 0 24px;font-weight:800}
.s-text p{margin:0 0 14px;color:var(--ink2);max-width:38em}
.s-about{display:grid;gap:28px;align-items:start}
@media(min-width:720px){.s-about{grid-template-columns:minmax(0,1fr) minmax(0,1.4fr)}}
.s-about-img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:18px}
.s-news{display:grid;gap:34px}
.s-post{display:grid;gap:6px;max-width:44em}
.s-post h3{margin:0;font-size:24px;letter-spacing:-.02em}
.s-post-img{width:100%;max-height:420px;object-fit:cover;border-radius:16px;margin-bottom:10px}
.s-date{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13.5px;color:var(--mut);margin:0}
.s-shows{list-style:none;margin:0;padding:0}
.s-shows li{display:grid;grid-template-columns:130px 1fr auto;gap:16px;align-items:center;padding:16px 0;border-bottom:1px solid var(--line)}
@media(max-width:560px){.s-shows li{grid-template-columns:1fr auto}.s-shows .s-date{grid-column:1/-1}}
.s-where span{color:var(--mut)}
.s-merch{display:grid;gap:20px;grid-template-columns:repeat(auto-fill,minmax(200px,1fr))}
.s-card{display:grid;gap:6px;align-content:start}
.s-card-img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:14px;background:var(--bg2)}
.s-card .s-btn{justify-self:start;margin-top:6px}
.s-links{display:flex;flex-wrap:wrap;gap:12px}
.s-rel{display:grid;gap:22px}
.s-rel-one{display:flex;gap:20px;align-items:center}
.s-rel-one img,.s-rel-art{width:96px;height:96px;border-radius:12px;object-fit:cover;background:var(--bg2);flex:none}
.s-rel-one p{margin:4px 0 0;font-size:15px}
.s-link{display:inline-flex;gap:6px;padding:12px 20px;border:1.5px solid var(--line);border-radius:999px;color:var(--ink) !important;text-decoration:none;font-weight:600}
.s-foot{max-width:960px;margin:0 auto;padding:40px clamp(20px,4vw,48px) 80px;border-top:1px solid var(--line);color:var(--mut);font-size:14.5px}
.s-site .ph{color:var(--mut);opacity:.7;font-style:italic}
.s-site .ph-img{display:grid;place-items:center;background:var(--bg2);color:var(--mut);border:1.5px dashed var(--line);min-height:160px;font-size:14px}
.s-site .s-hero-img.ph-img{min-height:0}
.s-sec.is-hidden{opacity:.45}
`;
  const body = `<div class="s-site">
${nav ? `<nav class="s-nav">${nav}</nav>` : ""}
${hero}
${sections}
${slots.footer ? `<footer class="s-foot">${slots.footer}</footer>` : ""}
</div>`;
  return { css, body, site };
}

// src/page.ts
function esc2(s) {
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
    `style-src 'nonce-${nonce}' https://fonts.googleapis.com`,
    "font-src https://fonts.gstatic.com",
    "img-src https: data:",
    "manifest-src 'self'",
    "media-src https:",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'"
  ].join("; ");
}
function appLink(origin, focus) {
  const m = encodeURIComponent(`${origin}/manifest.json`);
  return focus ? `https://amply.stream/app/?${focus.kind}=${m}&id=${encodeURIComponent(focus.id)}` : `https://amply.stream/app/?add=${m}`;
}
function renderPage(manifest, origin, nonce, focus = null, site = null) {
  const name = esc2(manifest.artist?.name || "Untitled");
  const bio = manifest.artist?.bio ? `<p class="bio">${esc2(manifest.artist.bio)}</p>` : "";
  const avatar = safeUrl(manifest.artist?.image);
  const newest = (manifest.releases || []).filter((r) => safeUrl(r.art)).sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))[0];
  const preview = safeUrl(manifest.artist?.banner) || safeUrl(newest?.art) || avatar;
  const wide = !!safeUrl(manifest.artist?.banner);
  const about = (manifest.artist?.bio || `Listen to ${manifest.artist?.name || "this artist"}'s music`).slice(0, 200);
  let focused = null;
  if (focus) {
    for (const r of manifest.releases || []) {
      if (focus.kind === "album" && r.id === focus.id) focused = { title: r.title, art: safeUrl(r.art), kind: "album", id: r.id, release: r.id };
      const t = focus.kind === "song" ? (r.tracks || []).find((x) => x.id === focus.id) : null;
      if (t) focused = { title: t.title, art: safeUrl(r.art), kind: "song", id: t.id, release: r.id };
    }
  }
  const artistName = manifest.artist?.name || "this artist";
  const cardTitle = focused ? esc2(`${focused.title} \u2014 ${artistName}`) : name;
  const cardAbout = focused ? `${focused.kind === "song" ? "A song" : "An album"} by ${artistName}. Listen in the Amply app.` : about;
  const cardImage = focused ? focused.art || preview : preview;
  const cardUrl = focused ? `${origin}/?${focused.kind}=${encodeURIComponent(focused.id)}` : `${origin}/`;
  const cardType = focused ? focused.kind === "song" ? "music.song" : "music.album" : "music.musician";
  const cardWide = focused ? !!cardImage : wide;
  const links = (manifest.artist?.links || []).map((l) => {
    const u = safeUrl(l.url);
    return u ? `<a href="${esc2(u)}" rel="noopener">${esc2(l.label)}</a>` : "";
  }).join("");
  const wallet = (manifest.payment || []).find((p) => p.type === "solana-usdc");
  const paid = charges(manifest);
  const inApp = appLink(origin, focused ? { kind: focused.kind, id: focused.id } : null);
  const support = (manifest.payment || []).filter((p) => p.type === "link").map((p) => {
    const u = safeUrl(p.url);
    return u ? `<a class="btn" href="${esc2(u)}" rel="noopener">${esc2(p.label)}</a>` : "";
  }).join("");
  const lic = manifest.licence;
  const licUrl = lic?.type === "amply-personal-1" ? "https://amply.stream/licence/personal-1" : safeUrl(lic?.url);
  const licence = lic?.type ? `<p class="lic">${lic.notice ? esc2(lic.notice) + " " : ""}${paid ? "" : "Listen freely. "}${licUrl ? `<a href="${esc2(licUrl)}" rel="noopener">These recordings may not be redistributed</a>` : "These recordings may not be redistributed"} or included in another service without ${name}'s permission.</p>` : "";
  const releases = (manifest.releases || []).map((r) => {
    const art = safeUrl(r.art);
    const tracks = (r.tracks || []).map((t) => {
      const u = safeUrl(t.url);
      if (!u) return "";
      const title = `${esc2(t.title)}${t.explicit ? ' <em class="e">explicit</em>' : ""}`;
      if (needsWallet(manifest, t)) {
        return `<li class="t${focused?.id === t.id ? " focus" : ""}" id="song-${esc2(t.id)}">
        <a class="play paid" href="${esc2(appLink(origin, { kind: "song", id: t.id }))}" aria-label="Listen to ${esc2(t.title)} in the Amply app">\u25B6</a>
        <span class="tt">${title}</span>
        <span class="d">${mmss(t.duration)}</span>
      </li>`;
      }
      return `<li class="t${focused?.id === t.id ? " focus" : ""}" id="song-${esc2(t.id)}">
        <button class="play" data-src="${esc2(u)}" aria-label="Play ${esc2(t.title)}">\u25B6</button>
        <span class="tt">${title}${paid ? ' <em class="free">free</em>' : ""}</span>
        <span class="d">${mmss(t.duration)}</span>
      </li>`;
    }).join("");
    return `<section class="r${focused?.release === r.id ? " focus" : ""}" id="album-${esc2(r.id)}">
      ${art ? `<img class="art" src="${esc2(art)}" alt="" loading="lazy">` : ""}
      <div class="rb">
        <h2>${esc2(r.title)}</h2>
        ${r.date ? `<p class="date">${esc2(r.date)}</p>` : ""}
        <ol class="ts">${tracks}</ol>
      </div>
    </section>`;
  }).join("");
  const empty = !(manifest.releases || []).some((r) => (r.tracks || []).length) ? `<p class="muted">No music published yet.</p>` : "";
  const linkedHtml = `${focused ? `<div class="linked">
  ${focused.art ? `<img src="${esc2(focused.art)}" alt="">` : ""}
  <div><h2>${esc2(focused.title)}</h2><p>${focused.kind === "song" ? "A song" : "An album"} by ${name}</p>
  <a class="btn" href="${esc2(inApp)}">Open in the Amply app</a></div>
</div>` : ""}`;
  const musicHtml = `${paid ? `<div class="listen">
  <p>${name}'s music is paid for as you listen \u2014 <strong>$${esc2(wallet?.ratePerMinute)}</strong> a
  minute, straight to them, with nothing taken in between. Listen in the Amply app.</p>
  <a class="btn" href="${esc2(inApp)}">Open in the Amply app</a>
</div>` : ""}
${releases}
${empty}
<div class="pay">
  <h3>Support ${name}</h3>
  ${wallet?.ratePerMinute ? `<p>Listening in an Amply player pays ${name} <strong>$${esc2(wallet.ratePerMinute)}</strong> a
       minute, directly. Nobody in between takes a cut.</p>` : `<p>Payments go straight to the artist. Nothing is taken in between.</p>`}
  ${support}
</div>`;
  const footerHtml = `<p>Follow in an Amply player by adding this address:<br><code>${esc2(origin)}/manifest.json</code></p>
  <p>This page is hosted by the artist, on infrastructure they own. <a href="/privacy">Privacy</a></p>
  ${licence}`;
  const built = site && typeof site === "object" && Array.isArray(site.sections) && site.sections.length ? renderSite(site, manifest, { slots: { music: linkedHtml + musicHtml, footer: footerHtml }, listenUrl: inApp }) : null;
  const siteMode = !!built;
  const siteBody = built ? built.body : "";
  const siteCss = built ? built.css + "body{padding:0}" : "";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${cardTitle}</title>
<meta name="description" content="${esc2(cardAbout.slice(0, 160))}">
<meta property="og:title" content="${cardTitle}">
<meta property="og:description" content="${esc2(cardAbout)}">
<meta property="og:type" content="${cardType}">
<meta property="og:url" content="${esc2(cardUrl)}">
<meta name="twitter:card" content="${cardWide ? "summary_large_image" : "summary"}">
<meta name="twitter:title" content="${cardTitle}">
<meta name="twitter:description" content="${esc2(cardAbout)}">
<link rel="manifest" href="/page.webmanifest">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta name="theme-color" content="#ffffff">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${name}">
<link rel="apple-touch-icon" href="${esc2(avatar || "/studio/icon-180.png")}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;700;800&display=swap">
${cardImage ? `<meta property="og:image" content="${esc2(cardImage)}">
<meta property="og:image:alt" content="${cardTitle}">
<meta name="twitter:image" content="${esc2(cardImage)}">` : ""}
<style nonce="${nonce}">
:root{color-scheme:light only;--ink:#131110;--ink2:#4a4644;--mut:#66615d;--bg:#ffffff;--bg2:#f7f4f1;--line:#e3ddd8;--ac:#f6711e;--on-ac:#131110}
*{box-sizing:border-box}
body{margin:0;padding:0 clamp(20px,4vw,48px) 100px;background:var(--bg);color:var(--ink);
 font:17px/1.55 "Archivo",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Helvetica,sans-serif;-webkit-font-smoothing:antialiased}
.w{max-width:860px;margin:0 auto}
header{padding:clamp(56px,9vw,104px) 0 34px;display:flex;gap:26px;align-items:center;flex-wrap:wrap}
.av{width:96px;height:96px;border-radius:50%;object-fit:cover;flex:none}
h1{font-size:clamp(40px,8vw,88px);font-weight:800;letter-spacing:-.042em;margin:0;line-height:.94}
.bio{color:var(--ink2);margin:20px 0 0;max-width:34em;font-size:18px}
.links{display:flex;gap:22px;flex-wrap:wrap;margin:20px 0 0;font-size:15px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.links a{color:var(--mut)}
a{color:var(--ac);text-underline-offset:2px}
.r{display:flex;gap:26px;padding:34px 0;border-top:1px solid var(--line);flex-wrap:wrap}
.art{width:124px;height:124px;border-radius:14px;object-fit:cover;flex:none}
.rb{flex:1 1 280px;min-width:0}
h2{font-size:22px;font-weight:700;letter-spacing:-.025em;margin:0}
.date{color:var(--mut);font-size:14px;margin:5px 0 18px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.ts{list-style:none;padding:0;margin:0}
.t{display:flex;align-items:center;gap:16px;padding:11px 0}
.play{flex:none;width:40px;height:40px;border-radius:50%;border:1.5px solid var(--line);
 background:var(--bg2);color:var(--ink);cursor:pointer;font-size:12px;line-height:1}
a.play{display:inline-flex;align-items:center;justify-content:center;text-decoration:none}
.free{font-style:normal;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
 color:var(--mut);border:1px solid var(--line);border-radius:999px;padding:1px 8px;margin-left:6px}
.listen{display:flex;gap:18px;align-items:center;flex-wrap:wrap;background:var(--bg2);
 border-radius:14px;padding:18px 22px;margin:28px 0 8px}
.listen p{margin:0;flex:1 1 260px;color:var(--ink2);font-size:16px}
.play[aria-pressed=true]{background:var(--ac);border-color:var(--ac);color:var(--on-ac)}
.tt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:18px}
.e{font-style:normal;font-size:11px;color:var(--mut);border:1px solid var(--line);padding:2px 9px;border-radius:999px}
.d{color:var(--mut);font-size:14px;font-variant-numeric:tabular-nums;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.pay{margin-top:48px;padding:32px;background:var(--ac);border-radius:18px;color:var(--on-ac)}
.pay h3{margin:0 0 12px;font-size:24px;font-weight:800;letter-spacing:-.03em}
.pay p{margin:0 0 20px;color:rgba(19,17,16,.78);font-size:17px}
.btn{display:inline-block;background:var(--on-ac);color:var(--ac);text-decoration:none;
 padding:14px 26px;border-radius:999px;font-size:16px;font-weight:700;margin-right:10px}
.muted{color:var(--mut)}
footer{margin-top:60px;padding-top:28px;border-top:1px solid var(--line);color:var(--mut);font-size:15px;
 font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13.5px;overflow-wrap:anywhere}
.lic{margin-top:16px}
.linked{display:flex;gap:18px;align-items:center;margin:26px 0 8px;padding:16px;border-radius:18px;background:var(--bg2)}
.linked img{width:84px;height:84px;border-radius:12px;object-fit:cover;flex:none}
.linked p{margin:0 0 10px;color:var(--mut);font-size:14px}
.linked h2{margin:0 0 4px;font-size:21px}
.t.focus .tt{color:var(--ac);font-weight:700}
/* Lit buttons: a light top edge, a darker bottom edge, a tight drop shadow and a
   soft glow in the button's own colour (--glow). Pressed: smaller glow, no bottom
   edge. Disabled: flat. */
:root{--lit-hi:rgba(255,255,255,.35);--lit-lo:rgba(0,0,0,.2);--lit-drop:rgba(0,0,0,.4);
 --lit-sheen:linear-gradient(180deg,rgba(255,255,255,.16),rgba(255,255,255,0) 70%);
 --lit-quiet:inset 0 1px 0 rgba(255,255,255,.9),inset 0 -2px 0 rgba(19,17,16,.07),0 1px 2px rgba(19,17,16,.14);
 --lit-quiet-down:inset 0 1px 0 rgba(255,255,255,.9),0 1px 1px rgba(19,17,16,.12)}
.btn,.play[aria-pressed=true]{--glow:var(--ac);--glow-a:60%;background-image:var(--lit-sheen);
 box-shadow:inset 0 1px 0 var(--lit-hi),inset 0 -2px 0 var(--lit-lo),0 1px 2px var(--lit-drop),0 8px 24px -6px color-mix(in srgb,var(--glow) var(--glow-a),transparent);
 transition:box-shadow .15s ease}
.btn{--glow:var(--on-ac);--glow-a:45%}
.play[aria-pressed=true]{box-shadow:inset 0 1px 0 var(--lit-hi),inset 0 -2px 0 var(--lit-lo),0 1px 2px var(--lit-drop),0 5px 14px -4px color-mix(in srgb,var(--glow) var(--glow-a),transparent)}
.btn:hover,.play[aria-pressed=true]:hover{--glow-a:80%}
.btn:active,.play[aria-pressed=true]:active{box-shadow:inset 0 1px 0 var(--lit-hi),0 1px 2px var(--lit-drop),0 3px 10px -5px color-mix(in srgb,var(--glow) var(--glow-a),transparent)}
.play:not([aria-pressed=true]){box-shadow:var(--lit-quiet);transition:box-shadow .15s ease}
.play:not([aria-pressed=true]):active{box-shadow:var(--lit-quiet-down)}
.play:disabled{box-shadow:none}
@media (prefers-reduced-motion:reduce){.btn,.play{transition:none}}
${siteCss}
</style>
</head><body>${siteMode ? siteBody : `<div class="w">
<header>
  ${avatar ? `<img class="av" src="${esc2(avatar)}" alt="">` : ""}
  <div><h1>${name}</h1></div>
</header>
${linkedHtml}
${bio}
${links ? `<div class="links">${links}</div>` : ""}
${musicHtml}
<footer>${footerHtml}</footer>
</div>`}
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
function renderPrivacy(manifest, origin, nonce) {
  const name = esc2(manifest.artist?.name || "This artist");
  const paid = charges(manifest);
  const subs = plans(manifest).length > 0;
  const selling = forSale(manifest).length > 0;
  const card = forSale(manifest).some((s) => s.card);
  const bought = selling ? `<p><strong>If you buy</strong> a song or an album, this server keeps a record of the
purchase: your wallet address, what you bought, the payment's reference (a Stripe checkout or a
Solana transaction), when, and how many times you have downloaded each song (up to
${DOWNLOADS_PER_PURCHASE}). A gift is recorded against the wallet that claims it. This is kept for as
long as you own what you bought, because it is what lets you download it again; asking to be
forgotten doesn't remove it, and ${name} may also need it for their accounts.${card ? ` Paying by card, Stripe
holds your name, email and card in ${name}'s own Stripe account, under Stripe's privacy policy.` : ""}</p>` : "";
  const contact = manifest.artist?.contact || "";
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(contact);
  const contactLine = !contact ? `<p class="warn">${name} has not added a contact address yet. Until they do, you can
       still see and erase your record yourself, from the Amply app, as described below.</p>` : isEmail ? `<p>Contact them about your data at <a href="mailto:${esc2(contact)}">${esc2(contact)}</a>.</p>` : `<p>Contact them about your data here: <a href="${esc2(safeUrl(contact) || "")}" rel="noopener">${esc2(contact)}</a>.</p>`;
  const body = paid ? `
<h2>What is kept about you, and why</h2>
<p>${name} charges for their music, and pays for it to be served. To be paid, and to be able
to stop serving someone who listens without paying, their server keeps one record per
wallet that plays their paid tracks:</p>
<ul>
  <li>your wallet address;</li>
  <li>how many tracks you have played, and for how many minutes in total;</li>
  <li>what that listening cost, at the price when you heard it;</li>
  <li>when you first and last listened;</li>
  <li>whether ${name} has stopped serving that wallet.</li>
</ul>
<p><strong>What is not kept:</strong> which tracks you played, or when you played any one of
them. This server does not record that at all. Nothing is kept for tracks ${name} has made
free, which anyone can play without a wallet.</p>
<p>Separately, each song keeps a count of how often it has been played by everyone together, so
${name} can see what's popular. It holds no wallet and nothing about who played it.</p>
<p>No account, email address or name is asked for. A wallet address does not say who you are
by itself, but it can sometimes be linked to a person, so it is treated as personal data.</p>

<h2>On what basis</h2>
<p>To provide the music you are paying for, and to be paid for it (a contract: GDPR Article
6(1)(b)). Stopping service to a wallet that listens without paying is ${name}'s legitimate
interest in being paid for their work (Article 6(1)(f)). Nobody is refused automatically:
stopping service is a decision ${name} makes by hand.</p>

<h2>How long</h2>
<p>A year after you last listened, after which the record is deleted automatically. If
${name} has stopped serving your wallet, the wallet address and that decision are kept for as
long as it stands \u2014 with every other figure removed.</p>

<h2>Who else is involved</h2>
<p><strong>Cloudflare</strong> runs the server on ${name}'s behalf, in ${name}'s own account,
under Cloudflare's data processing terms. It may process data outside the EU under the
safeguards those terms describe.</p>
<p><strong>Payments</strong> are transfers on the Solana network, which is public: anyone can
see that a wallet paid another. That is a property of the network, not something ${name} or
their server records.</p>
${subs ? `<p><strong>Stripe</strong> handles subscriptions, in ${name}'s own Stripe account. If you
subscribe, Stripe holds your name, email and card, under its own privacy policy, and ${name} can
see them there as the seller. This server keeps only your wallet address, Stripe's ids for your
subscription and for you as a customer, and the date it runs to \u2014 enough to serve what you paid
for, and to let you cancel on Stripe's page. That record is kept for as long as the subscription
runs, and deleted a year after it ends. Asking to be forgotten doesn't remove it while you're
subscribed, because it is what you bought.</p>` : ""}
${bought}
<p><strong>Amply</strong>, which made the software, receives nothing. It has no copy of this
record and no access to this server.</p>

<h2>Your rights, and how to use them</h2>
<p>You can see everything held about your wallet, have it erased, object to it being kept,
and take it with you. The quickest way needs nobody's permission: in the Amply app, open
${name} and, under <em>What they keep</em>, choose <em>See it</em> or <em>Erase</em>. Your app proves the
record is yours by signing for it with your wallet, and the answer comes straight back.</p>
<p>If ${name} has stopped serving your wallet, erasing removes everything but the address
and that decision, which ${name} keeps so that it stands. You can object to that by
contacting them.</p>
${contactLine}
<p>You can also complain to the data protection authority where you live.</p>
` : `
<h2>${selling ? "Listening leaves no record" : "Nothing is kept about you"}</h2>
<p>${name} gives their music away. Nothing is asked of you to play it, and this server keeps
no record of who listens.</p>
${bought}
${selling ? `<p><strong>Amply</strong>, which made the software, receives nothing. You can see what is held about
your purchases from the Amply app: open ${name} and, under <em>What they keep</em>, choose <em>See it</em>.</p>
${contactLine}
<p>You can also complain to the data protection authority where you live.</p>` : contact ? contactLine : ""}
`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacy \u2014 ${name}</title>
<style nonce="${nonce}">
:root{color-scheme:light only;--ink:#131110;--ink2:#4a4644;--mut:#66615d;--bg:#fff;--bg2:#f7f4f1;--line:#e3ddd8;--ac:#f6711e}
body{margin:0;padding:0 20px 80px;background:var(--bg);color:var(--ink);
 font:17px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Helvetica,sans-serif}
.w{max-width:680px;margin:0 auto}
h1{font-size:34px;letter-spacing:-.03em;margin:56px 0 6px;line-height:1.1}
h2{font-size:19px;margin:34px 0 8px}
p,li{color:var(--ink2)} ul{padding-left:20px}
a{color:var(--ac)}
.lead{color:var(--mut);margin:0 0 20px}
.warn{background:var(--bg2);border-radius:12px;padding:14px 16px}
footer{margin-top:44px;padding-top:18px;border-top:1px solid var(--line);font-size:14px;color:var(--mut)}
</style>
</head><body><div class="w">
<h1>Privacy</h1>
<p class="lead">${name}'s streaming service, at ${esc2(new URL(origin).host)}. ${name} is responsible
for what it keeps.</p>
${body}
<footer><a href="/">Back to ${name}</a></footer>
</div></body></html>`;
}
function pageWebManifest(manifest) {
  const name = String(manifest.artist?.name || "Music").slice(0, 60);
  return JSON.stringify({
    name,
    short_name: name.slice(0, 20),
    description: `Listen to ${name}.`,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      { src: "/studio/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/studio/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/studio/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
    ]
  });
}

// src/store.ts
async function setting(db, key) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
  return row?.value ?? null;
}
async function putSetting(db, key, value) {
  await db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(key, value).run();
}
var cachedSecret = null;
async function signingKey(db) {
  if (cachedSecret) return cachedSecret;
  const kept = await setting(db, "token-secret");
  if (kept) {
    cachedSecret = kept;
    return kept;
  }
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const made = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING").bind("token-secret", made).run();
  cachedSecret = await setting(db, "token-secret") ?? made;
  return cachedSecret;
}
async function listener(db, pubkey) {
  return db.prepare("SELECT * FROM listeners WHERE pubkey = ?").bind(pubkey).first();
}
async function seen(db, pubkey, now = Date.now()) {
  await db.prepare("UPDATE listeners SET last_seen = ? WHERE pubkey = ?").bind(now, pubkey).run();
}
async function counted(db, pubkey, seconds, now = Date.now(), perMinute2 = 0) {
  const clean = Math.max(0, Math.min(Math.round(seconds), MAX_REPORT_S));
  await db.prepare(
    `INSERT INTO listeners (pubkey, plays, seconds, first_seen, last_seen) VALUES (?, 1, ?, ?, ?)
     ON CONFLICT(pubkey) DO UPDATE SET
       plays = plays + 1,
       seconds = seconds + excluded.seconds,
       last_seen = excluded.last_seen`
  ).bind(pubkey, clean, now, now).run();
  const micros = perMinute2 > 0 ? Math.round(clean / 60 * perMinute2 * 1e6) : 0;
  await db.prepare(
    `INSERT INTO owed (pubkey, micros, seconds) VALUES (?, ?, ?)
     ON CONFLICT(pubkey) DO UPDATE SET micros = micros + excluded.micros, seconds = seconds + excluded.seconds`
  ).bind(pubkey, micros, clean).run().catch(() => {
  });
}
var MAX_REPORT_S = 3 * 3600;
async function listeners(db, limit = 500) {
  const n = Math.min(limit, 1e3);
  try {
    const { results } = await db.prepare(
      `SELECT l.*, s.until AS subscribed_until, o.micros AS owed_micros, o.seconds AS owed_seconds
         FROM listeners l LEFT JOIN subscriptions s ON s.wallet = l.pubkey
         LEFT JOIN owed o ON o.pubkey = l.pubkey
        ORDER BY l.seconds DESC LIMIT ?`
    ).bind(n).all();
    return results ?? [];
  } catch {
    const { results } = await db.prepare(
      `SELECT l.*, s.until AS subscribed_until
         FROM listeners l LEFT JOIN subscriptions s ON s.wallet = l.pubkey
        ORDER BY l.seconds DESC LIMIT ?`
    ).bind(n).all();
    return results ?? [];
  }
}
async function setBlocked(db, pubkey, blocked, now = Date.now()) {
  await db.prepare(
    `INSERT INTO listeners (pubkey, first_seen, last_seen, blocked) VALUES (?, ?, ?, ?)
     ON CONFLICT(pubkey) DO UPDATE SET blocked = excluded.blocked`
  ).bind(pubkey, now, now, blocked ? 1 : 0).run();
}
async function forget(db, pubkey) {
  await db.prepare(
    `UPDATE listeners SET plays = 0, seconds = 0, first_seen = 0, last_seen = 0
     WHERE pubkey = ? AND blocked = 1`
  ).bind(pubkey).run();
  await db.prepare("DELETE FROM listeners WHERE pubkey = ? AND blocked = 0").bind(pubkey).run();
  await forgetOwed(db, pubkey);
}
async function forgetOwed(db, pubkey) {
  await (pubkey ? db.prepare("DELETE FROM owed WHERE pubkey = ?").bind(pubkey) : db.prepare("DELETE FROM owed WHERE pubkey NOT IN (SELECT pubkey FROM listeners)")).run().catch(() => {
  });
}
var KEEP_FOR = 365 * 864e5;
async function pruneStale(db, now = Date.now()) {
  await db.prepare("DELETE FROM listeners WHERE blocked = 0 AND last_seen < ?").bind(now - KEEP_FOR).run();
  await forgetOwed(db);
}
async function remove(db, pubkey) {
  await db.prepare("DELETE FROM listeners WHERE pubkey = ?").bind(pubkey).run();
  await db.prepare("DELETE FROM subscriptions WHERE wallet = ?").bind(pubkey).run();
  await forgetOwed(db, pubkey);
}
async function subscribedUntil(db, wallet) {
  const row = await db.prepare("SELECT until FROM subscriptions WHERE wallet = ?").bind(wallet).first();
  return row?.until ?? null;
}
async function subscriptionOf(db, wallet) {
  return db.prepare("SELECT * FROM subscriptions WHERE wallet = ?").bind(wallet).first();
}
async function recordSubscription(db, s, now = Date.now()) {
  await db.prepare(
    `INSERT INTO subscriptions (wallet, subscription, customer, until, updated) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(wallet) DO UPDATE SET
       subscription = excluded.subscription, customer = excluded.customer,
       until = excluded.until, updated = excluded.updated`
  ).bind(s.wallet, s.subscription, s.customer, s.until, now).run();
}
async function updateSubscription(db, subscription, until, now = Date.now()) {
  await db.prepare("UPDATE subscriptions SET until = ?, updated = ? WHERE subscription = ?").bind(until, now, subscription).run();
}
async function pruneSubscriptions(db, now = Date.now()) {
  await db.prepare("DELETE FROM subscriptions WHERE until < ?").bind(now - KEEP_FOR).run();
}
var dayOf = (now) => new Date(now).toISOString().slice(0, 10);
async function heard(db, track, seconds, now = Date.now()) {
  const clean = Math.max(0, Math.min(Math.round(seconds), 3600));
  await db.prepare(
    `INSERT INTO track_plays (track, plays, seconds) VALUES (?, 1, ?)
     ON CONFLICT(track) DO UPDATE SET plays = plays + 1, seconds = seconds + excluded.seconds`
  ).bind(track, clean).run();
  try {
    await db.prepare(
      `INSERT INTO play_days (day, plays) VALUES (?, 1)
       ON CONFLICT(day) DO UPDATE SET plays = plays + 1`
    ).bind(dayOf(now)).run();
    if (Math.random() < 0.01) {
      await db.prepare("DELETE FROM play_days WHERE day < ?").bind(dayOf(now - 30 * 864e5)).run();
    }
  } catch {
  }
}
async function playsToday(db, now = Date.now()) {
  try {
    const row = await db.prepare("SELECT plays FROM play_days WHERE day = ?").bind(dayOf(now)).first();
    return row?.plays ?? 0;
  } catch {
    return 0;
  }
}
async function songTotals(db) {
  try {
    const r = await db.prepare("SELECT track, plays, seconds FROM track_plays ORDER BY plays DESC LIMIT 500").all();
    return r.results || [];
  } catch {
    return [];
  }
}

// src/identity.ts
var B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function fromBase58(text) {
  if (typeof text !== "string" || text.length > 128) return null;
  let n = 0n;
  for (const ch of text) {
    const i = B58.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const ch of text) {
    if (ch === B58[0]) bytes.unshift(0);
    else break;
  }
  return Uint8Array.from(bytes);
}
async function verifySignature(address, message, signature) {
  const key = fromBase58(address);
  const sig = fromBase58(signature);
  if (!key || key.length !== 32 || !sig || sig.length !== 64) return false;
  try {
    const publicKey = await crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      sig,
      new TextEncoder().encode(message)
    );
  } catch {
    return false;
  }
}
function challenge(host, now = Date.now()) {
  return `amply:${host}:${now}:${crypto.randomUUID()}`;
}
function challengeIsFresh(text, host, now = Date.now()) {
  const [tag, who, at] = text.split(":");
  if (tag !== "amply" || who !== host) return false;
  const when = Number(at);
  return Number.isFinite(when) && Math.abs(now - when) < 5 * 6e4;
}

// src/listen.ts
var TOKEN_LIFE = 30 * 6e4;
var enc = new TextEncoder();
var b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message))));
}
async function issueToken(db, pubkey, now = Date.now()) {
  const body = `${pubkey}.${now + TOKEN_LIFE}`;
  return `${body}.${await hmac(await signingKey(db), body)}`;
}
async function readToken(db, token, now = Date.now()) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [pubkey, until, mac] = parts;
  const expected = await hmac(await signingKey(db), `${pubkey}.${until}`);
  if (mac.length !== expected.length) return null;
  let same = 0;
  for (let i = 0; i < mac.length; i++) same |= mac.charCodeAt(i) ^ expected.charCodeAt(i);
  if (same !== 0) return null;
  if (!Number.isFinite(Number(until)) || Number(until) < now) return null;
  return pubkey;
}
async function proveOwnership(host, body, now = Date.now()) {
  const address = String(body?.address || "");
  const message = String(body?.message || "");
  const signature = String(body?.signature || "");
  const key = fromBase58(address);
  if (!key || key.length !== 32) return { ok: false, why: "that is not a wallet address" };
  if (!challengeIsFresh(message, host, now)) return { ok: false, why: "that challenge is not one of ours, or it has expired" };
  if (!await verifySignature(address, message, signature)) return { ok: false, why: "that signature does not match that wallet" };
  return { ok: true, address };
}
async function introduce(db, host, body, now = Date.now()) {
  const proof = await proveOwnership(host, body, now);
  if (!proof.ok) return { ok: false, why: proof.why };
  const address = proof.address;
  const known = await listener(db, address);
  if (known?.blocked) return { ok: false, why: "this artist has stopped serving this wallet" };
  await seen(db, address, now);
  return { ok: true, token: await issueToken(db, address, now) };
}
function masterKeys(manifest) {
  const masters = /* @__PURE__ */ new Set(), streamed = /* @__PURE__ */ new Set();
  const keyOf2 = (u) => {
    try {
      const p = new URL(String(u)).pathname;
      return p.startsWith("/audio/") ? decodeURIComponent(p.slice("/audio/".length)) : null;
    } catch {
      return null;
    }
  };
  for (const release of manifest?.releases ?? []) {
    for (const track of release.tracks ?? []) {
      const m = keyOf2(track?.master), u = keyOf2(track?.url);
      if (m) masters.add(m);
      if (u) streamed.add(u);
    }
  }
  for (const k of streamed) masters.delete(k);
  return masters;
}
function guardedKeys(manifest) {
  const keys = /* @__PURE__ */ new Set();
  const releases = manifest?.releases ?? [];
  for (const release of releases) {
    for (const track of release.tracks ?? []) {
      if (!track?.url || !needsWallet(manifest, track)) continue;
      try {
        const path = new URL(track.url).pathname;
        if (path.startsWith("/audio/")) keys.add(decodeURIComponent(path.slice("/audio/".length)));
      } catch {
      }
    }
  }
  return keys;
}

// src/stripe.ts
var API = "https://api.stripe.com/v1";
var STRIPE_KEY = "stripe";
var TOLERANCE = 5 * 60;
var MAX_EVENT = 256 * 1024;
function formEncode(params, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === void 0 || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === "object") out.push(formEncode(item, `${key}[${i}]`));
        else out.push(`${encodeURIComponent(`${key}[]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof v === "object") {
      out.push(formEncode(v, key));
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return out.filter(Boolean).join("&");
}
var StripeError = class extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
  status;
};
var PERMISSIONS = {
  product_write: "Products \u2014 Write (under Core)",
  product_read: "Products \u2014 Write (under Core)",
  plan_write: "Prices \u2014 Write (under Billing)",
  plan_read: "Prices \u2014 Write (under Billing)",
  payment_links_write: "Payment Links \u2014 Write (under Core)",
  payment_links_read: "Payment Links \u2014 Write (under Core)",
  webhook_write: "Webhook Endpoints \u2014 Write",
  webhook_read: "Webhook Endpoints \u2014 Write",
  customer_portal_write: "Customer portal \u2014 Write (under Billing)",
  customer_portal_read: "Customer portal \u2014 Write (under Billing)",
  subscription_read: "Subscriptions \u2014 Read (under Billing)",
  subscription_write: "Subscriptions \u2014 Read (under Billing)",
  checkout_session_read: "Checkout Sessions \u2014 Read (under Checkout)",
  checkout_session_write: "Checkout Sessions \u2014 Read (under Checkout)"
};
function explain(message, status = 0) {
  const wanted = /rak_([a-z_]+?)_(read|write)\b/.exec(message);
  if (wanted) {
    const row = PERMISSIONS[`${wanted[1]}_${wanted[2]}`];
    return row ? `Your key is missing a permission. In Stripe, edit the key and set ${row}, then try again.` : `Your key is missing a permission Stripe calls "${wanted[1]} ${wanted[2]}". Edit the key in Stripe to add it, then try again.`;
  }
  if (status === 401 || /invalid api key/i.test(message)) {
    return "Stripe doesn't recognise that key. Copy it again \u2014 the whole thing, starting rk_ \u2014 and check it hasn't been deleted.";
  }
  if (/activate|activation|not.*enabled.*live|account.*cannot.*live/i.test(message)) {
    return "Your Stripe account isn't activated for real payments yet. Finish Stripe's setup (Activate payments, in your Stripe dashboard), or use a test-mode key for now.";
  }
  return `Stripe said: ${message}`;
}
async function call(key, method, path, params) {
  const init = { method, headers: { Authorization: `Bearer ${key}` } };
  let url = `${API}${path}`;
  if (params && method === "GET") url += `?${formEncode(params)}`;
  else if (params) {
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = formEncode(params);
  }
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new StripeError(explain(body?.error?.message || `Stripe answered ${res.status}`, res.status), res.status);
  return body;
}
var hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function verifySignature2(raw, header, secret, now = Math.floor(Date.now() / 1e3)) {
  if (!header || !secret) return false;
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!Number.isFinite(t) || !signatures.length) return false;
  if (Math.abs(now - t) > TOLERANCE) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expected = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${raw}`)));
  return signatures.some((sig) => {
    if (sig.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  });
}
function periodEnd(sub) {
  const s = sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end;
  return Number.isFinite(Number(s)) && Number(s) > 0 ? Number(s) * 1e3 : null;
}
var STANDING = /* @__PURE__ */ new Set(["active", "trialing", "past_due"]);
var ours = (sub) => Array.isArray(sub?.items?.data) && sub.items.data.some((i) => i?.price?.metadata?.amply === "1");
async function handleEvent(db, raw, signature, { fetchSubscription, now = Date.now() } = {}) {
  const connection = await connectionOf(db);
  if (!connection?.webhookSecret) return "refused";
  if (raw.length > MAX_EVENT) return "refused";
  if (!await verifySignature2(raw, signature, connection.webhookSecret, Math.floor(now / 1e3))) return "refused";
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return "refused";
  }
  const obj = event.data?.object ?? {};
  const load2 = fetchSubscription ?? ((id) => call(connection.key, "GET", `/subscriptions/${id}`));
  if (event.type === "checkout.session.completed") {
    if (obj.mode !== "subscription" || !obj.subscription) return "ignored";
    const wallet = String(obj.client_reference_id || "");
    const key = fromBase58(wallet);
    if (!key || key.length !== 32) return "ignored";
    const sub = await load2(String(obj.subscription));
    if (!ours(sub)) return "ignored";
    if (!STANDING.has(String(sub.status))) return "ignored";
    const until = periodEnd(sub);
    if (!until) return "ignored";
    await recordSubscription(db, {
      wallet,
      subscription: String(obj.subscription),
      customer: obj.customer ? String(obj.customer) : null,
      until
    }, now);
    return "recorded";
  }
  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    if (!obj.id) return "ignored";
    let until;
    if (event.type === "customer.subscription.deleted" || !STANDING.has(String(obj.status))) {
      until = obj.ended_at ? Number(obj.ended_at) * 1e3 : now;
    } else {
      until = periodEnd(obj) ?? now;
    }
    await updateSubscription(db, String(obj.id), until, now);
    await tidy(db, now);
    return "updated";
  }
  return "ignored";
}
var REFRESH_EVERY = 24 * 36e5;
var SESSION = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
async function findSession(c, wallet) {
  for (const p of c.plans) {
    const page = await call(c.key, "GET", "/checkout/sessions", {
      payment_link: p.linkId,
      status: "complete",
      limit: 100
    });
    const mine = (page.data || []).find((s) => s.client_reference_id === wallet);
    if (mine) return mine;
  }
  return null;
}
async function claim(db, wallet, sessionId, { loadSession, loadSubscription, now = Date.now() } = {}) {
  const c = await connectionOf(db);
  if (!c) return "refused";
  let session;
  if (sessionId === "") {
    session = await findSession(c, wallet);
    if (!session) return "refused";
  } else {
    if (!SESSION.test(sessionId)) return "refused";
    session = await (loadSession ?? ((id2) => call(c.key, "GET", `/checkout/sessions/${id2}`)))(sessionId);
  }
  if (session.mode !== "subscription" || !session.subscription) return "refused";
  if (session.client_reference_id !== wallet) return "refused";
  if (session.status !== "complete") return "pending";
  const id = typeof session.subscription === "string" ? session.subscription : String(session.subscription.id);
  const sub = await (loadSubscription ?? ((i) => call(c.key, "GET", `/subscriptions/${i}`)))(id);
  if (!ours(sub)) return "refused";
  if (!STANDING.has(String(sub.status))) return "pending";
  const until = periodEnd(sub);
  if (!until) return "pending";
  await recordSubscription(db, {
    wallet,
    subscription: id,
    customer: session.customer ? String(session.customer) : sub.customer ? String(sub.customer) : null,
    until
  }, now);
  return "recorded";
}
async function refresh(db, wallet, { loadSubscription, now = Date.now() } = {}) {
  const s = await subscriptionOf(db, wallet);
  if (!s) return null;
  const due = s.until > now ? now - s.updated >= REFRESH_EVERY : s.updated < s.until;
  if (!due) return s.until;
  const c = await connectionOf(db);
  if (!c) return s.until;
  try {
    const sub = await (loadSubscription ?? ((i) => call(c.key, "GET", `/subscriptions/${i}`)))(s.subscription);
    const until = STANDING.has(String(sub.status)) ? periodEnd(sub) ?? now : sub.ended_at ? Number(sub.ended_at) * 1e3 : now;
    await updateSubscription(db, s.subscription, until, now);
    await tidy(db, now);
    return until;
  } catch {
    return s.until;
  }
}
async function connectionOf(db) {
  const raw = await setting(db, STRIPE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
async function publicView(db) {
  const c = await connectionOf(db);
  if (!c) return { connected: false };
  const sales = (c.sales || []).map(({ item, price, url }) => ({ item, price, url }));
  if (!c.plans.length && !c.sales) return { connected: false, winding: true, live: c.live };
  return {
    connected: true,
    live: c.live,
    cancellable: !!c.portal,
    plans: c.plans.map(({ months, price, currency, url }) => ({ months, price, currency, url })),
    sales
  };
}
function newKeyProblem(key) {
  if (/^pk_/.test(key)) return "That's Stripe's publishable key. Amply needs a restricted key, which starts rk_.";
  if (/^sk_/.test(key)) return "That's Stripe's full secret key, which can move money. Make a restricted key instead (it starts rk_), with only the permissions in the guide.";
  if (!/^rk_(live|test)_[A-Za-z0-9]+$/.test(key)) return "That doesn't look like a Stripe restricted key. Copy the one that starts rk_.";
  return null;
}
async function connect(db, { key, plans: plans2, artist, returnTo }) {
  const problem = newKeyProblem(key);
  if (problem) throw new StripeError(problem);
  const live = key.includes("_live_");
  await call(key, "GET", "/products", { limit: 1 });
  const previous = await connectionOf(db);
  const made = [];
  let product = null;
  try {
    product = await call(key, "POST", "/products", {
      name: `${artist} \u2014 subscription`,
      metadata: { amply: "1" }
    });
    for (const plan of plans2) {
      const currency = (plan.currency || "usd").toLowerCase();
      const price = await call(key, "POST", "/prices", {
        product: product.id,
        currency,
        unit_amount: Math.round(plan.price * 100),
        recurring: { interval: "month", interval_count: plan.months },
        metadata: { amply: "1", months: String(plan.months) }
      });
      const link = await call(key, "POST", "/payment_links", {
        line_items: [{ price: price.id, quantity: 1 }],
        after_completion: { type: "redirect", redirect: { url: returnTo } },
        metadata: { amply: "1", months: String(plan.months) }
      });
      made.push({ months: plan.months, price: plan.price, currency, priceId: price.id, linkId: link.id, url: link.url });
    }
    await call(key, "GET", "/checkout/sessions", { limit: 1 });
    await call(key, "GET", "/subscriptions", { limit: 1 });
  } catch (e) {
    for (const p of made) await call(key, "POST", `/payment_links/${p.linkId}`, { active: false }).catch(() => {
    });
    if (product?.id) await call(key, "POST", `/products/${product.id}`, { active: false }).catch(() => {
    });
    throw e;
  }
  let portal = null;
  try {
    const config = await call(key, "POST", "/billing_portal/configurations", {
      business_profile: { headline: `Manage your subscription to ${artist}` },
      features: {
        subscription_cancel: { enabled: true, mode: "at_period_end" },
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true }
      }
    });
    portal = config.id;
  } catch {
  }
  const connection = { key, live, product: product.id, portal, plans: made, sales: previous?.sales };
  await putSetting(db, STRIPE_KEY, JSON.stringify(connection));
  if (previous) await retire(previous).catch(() => {
  });
  return connection;
}
async function retire(c) {
  for (const p of c.plans) await call(c.key, "POST", `/payment_links/${p.linkId}`, { active: false }).catch(() => {
  });
  if (c.webhook) await call(c.key, "DELETE", `/webhook_endpoints/${c.webhook}`).catch(() => {
  });
}
async function disconnect(db, now = Date.now()) {
  const c = await connectionOf(db);
  if (!c) return;
  for (const p of c.plans) await call(c.key, "POST", `/payment_links/${p.linkId}`, { active: false }).catch(() => {
  });
  await putSetting(db, STRIPE_KEY, JSON.stringify({ ...c, plans: [] }));
  await tidy(db, now);
}
async function tidy(db, now) {
  const c = await connectionOf(db);
  if (!c || c.plans.length || c.sales) return;
  const still = await db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE until > ?").bind(now).first();
  if (Number(still?.n) > 0) return;
  await retire(c).catch(() => {
  });
  await db.prepare("DELETE FROM settings WHERE key = ?").bind(STRIPE_KEY).run();
}
async function portalFor(db, wallet, returnTo) {
  const c = await connectionOf(db);
  const s = await subscriptionOf(db, wallet);
  if (!c?.portal || !s?.customer) return null;
  const session = await call(c.key, "POST", "/billing_portal/sessions", {
    customer: s.customer,
    configuration: c.portal,
    return_url: returnTo
  });
  return session.url ?? null;
}
async function setSales(db, { key, items, artist, returnTo }) {
  let c = await connectionOf(db);
  const useKey = (key || "").trim() || c?.key || "";
  if (!useKey) throw new StripeError("Connect Stripe first: paste your key, or install Amply for Artists.");
  const pasted = (key || "").trim();
  if (pasted && pasted !== c?.key) {
    const problem = newKeyProblem(pasted);
    if (problem) throw new StripeError(problem);
  } else if (!/^(sk|rk)_(live|test)_[A-Za-z0-9]+$/.test(useKey)) {
    throw new StripeError("That doesn't look like a Stripe secret key. Copy the one that starts rk_.");
  }
  if (!c || c.key !== useKey) {
    await call(useKey, "GET", "/products", { limit: 1 });
    c = { key: useKey, live: useKey.includes("_live_"), product: c?.product || "", portal: c?.portal ?? null, plans: c?.key === useKey ? c.plans : [], sales: c?.sales };
  }
  const had = c.sales || [];
  const next = [];
  const made = [];
  try {
    for (const it of items) {
      const same = had.find((h) => h.item === it.item && h.price === it.price);
      if (same) {
        next.push({ ...same, title: it.title });
        continue;
      }
      const product = await call(useKey, "POST", "/products", {
        name: `${it.title} \u2014 ${artist}`.slice(0, 250),
        metadata: { amply: "1", sale: it.item }
      });
      const price = await call(useKey, "POST", "/prices", {
        product: product.id,
        currency: "usd",
        unit_amount: Math.round(it.price * 100),
        metadata: { amply: "1", sale: it.item }
      });
      const link = await call(useKey, "POST", "/payment_links", {
        line_items: [{ price: price.id, quantity: 1 }],
        after_completion: { type: "redirect", redirect: { url: returnTo } },
        // Said where the buyer pays, as well as in the app before they get
        // here: a download that starts at once can't be sent back.
        custom_text: { submit: { message: "The download starts as soon as you've paid, so it can't be returned once it has." } },
        metadata: { amply: "1", sale: it.item }
      });
      const entry = { item: it.item, title: it.title, price: it.price, productId: product.id, priceId: price.id, linkId: link.id, url: link.url };
      made.push(entry);
      next.push(entry);
    }
    if (items.length) await call(useKey, "GET", "/checkout/sessions", { limit: 1 });
  } catch (e) {
    for (const m of made) await call(useKey, "POST", `/payment_links/${m.linkId}`, { active: false }).catch(() => {
    });
    throw e;
  }
  const retired = [...c.retired || []];
  for (const h of had) {
    if (!next.some((n) => n.linkId === h.linkId)) {
      await call(useKey, "POST", `/payment_links/${h.linkId}`, { active: false }).catch(() => {
      });
      retired.push({ item: h.item, linkId: h.linkId });
    }
  }
  await putSetting(db, STRIPE_KEY, JSON.stringify({ ...c, sales: next, retired: retired.slice(-500) }));
  return next;
}
async function refundedSale(db, sessionId, { load: load2 } = {}) {
  if (!SESSION.test(sessionId)) return null;
  const c = await connectionOf(db);
  if (!c) return null;
  try {
    const s = await (load2 ?? ((id) => call(c.key, "GET", `/checkout/sessions/${id}`, { expand: ["payment_intent.latest_charge"] })))(sessionId);
    const charge = s?.payment_intent?.latest_charge;
    if (!charge || typeof charge !== "object") return null;
    return !!(charge.refunded || charge.amount_refunded > 0 || charge.disputed);
  } catch {
    return null;
  }
}
async function claimSale(db, wallet, sessionId, { loadSession } = {}) {
  const c = await connectionOf(db);
  const links = [...c?.sales || [], ...c?.retired || []];
  if (!c || !links.length) return { outcome: "refused" };
  if (!SESSION.test(sessionId)) return { outcome: "refused" };
  const session = await (loadSession ?? ((id) => call(c.key, "GET", `/checkout/sessions/${id}`)))(sessionId);
  if (session.mode !== "payment") return { outcome: "refused" };
  if (session.client_reference_id !== wallet) return { outcome: "refused" };
  const linkId = typeof session.payment_link === "string" ? session.payment_link : session.payment_link?.id;
  const link = links.find((l) => l.linkId === linkId);
  if (!link) return { outcome: "refused" };
  if (session.status !== "complete" || session.payment_status !== "paid") return { outcome: "pending" };
  return { outcome: "recorded", ref: String(session.id), item: link.item };
}

// src/payment-check.ts
var SIG = /^[1-9A-HJ-NP-Za-km-z]{64,120}$/;
var MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
var purchaseMemo = (host, item) => `amply:buy:${host}:${item}`;
var tipMemo = (host) => `amply:tip:${host}`;
var TIP_MIN_MICROS = 1e5;
var TIP_MAX_MICROS = 5e7;
async function verifyPayment(claim2, terms) {
  if (!SIG.test(claim2.signature || "")) return { ok: false, why: "that is not a transaction signature" };
  let body;
  try {
    const res = await fetch(terms.rpc, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Solana's public endpoint answers curl and refuses a Worker with a
        // 403 unless one of these is set.
        "User-Agent": "amply-node/1.0"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        // Confirmed, not finalized: a supermajority has voted for it, which is
        // plenty for a song, and it's there seconds after sending rather than
        // most of a minute.
        params: [claim2.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]
      })
    });
    if (!res.ok) {
      return {
        ok: false,
        why: res.status === 429 ? "the network is busy" : "the network refused the question",
        status: res.status,
        detail: (await res.text().catch(() => "")).slice(0, 300)
      };
    }
    body = await res.json();
  } catch (e) {
    return { ok: false, why: "could not reach the network", detail: String(e?.message || e) };
  }
  const tx = body?.result;
  if (!tx) return { ok: false, why: "no such transaction" };
  if (tx.meta?.err) return { ok: false, why: "that transaction failed" };
  const wanted = new Set(terms.recipients);
  let micros = 0;
  let sawPayer = false;
  const all = [
    ...tx.transaction?.message?.instructions ?? [],
    ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions ?? [])
  ];
  for (const ix of all) {
    const p = ix?.parsed;
    if (!p || p.type !== "transferChecked" && p.type !== "transfer") continue;
    const info = p.info ?? {};
    if (info.mint && info.mint !== terms.mint) continue;
    if (!info.authority || info.authority !== claim2.payer) continue;
    sawPayer = true;
    const amount = Number(info.tokenAmount?.amount ?? info.amount ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const to = destinationOf(tx, info.destination);
    if (to && to.mint === terms.mint && wanted.has(to.owner)) micros += amount;
  }
  if (terms.memo !== void 0) {
    const noted = all.some((ix) => (ix?.program === "spl-memo" || ix?.programId === MEMO_PROGRAM) && ix?.parsed === terms.memo);
    if (!noted) return { ok: false, why: "that payment wasn't for this" };
  }
  if (!sawPayer) return { ok: false, why: "that payment was not sent by this wallet" };
  if (micros <= 0) return { ok: false, why: "that payment did not go to this artist" };
  if (micros < terms.minMicros) return { ok: false, why: "that payment was too small", micros };
  return { ok: true, micros, when: tx.blockTime ?? void 0 };
}
function destinationOf(tx, tokenAccount) {
  const keys = (tx.transaction?.message?.accountKeys ?? []).map((k) => typeof k === "string" ? k : k.pubkey);
  const index = keys.indexOf(tokenAccount);
  if (index < 0) return null;
  for (const b of tx.meta?.postTokenBalances ?? []) {
    if (b.accountIndex === index) return b.owner && b.mint ? { owner: b.owner, mint: b.mint } : null;
  }
  return null;
}

// src/sales.ts
var CHAINS = {
  solana: { rpc: "https://solana-rpc.publicnode.com", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  devnet: { rpc: "https://api.devnet.solana.com", mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" }
};
var B582 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function giftCode() {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => B582[b % 58]).join("");
}
var GIFT_RE = /^[1-9A-HJ-NP-Za-km-z]{20}$/;
async function recordSale(db, s, now = Date.now()) {
  const made = await db.prepare(
    `INSERT INTO sales (ref, item, buyer, owner, gift, via, created) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ref) DO NOTHING RETURNING *`
  ).bind(s.ref, s.item, s.buyer, s.gift ? null : s.buyer, s.gift ? giftCode() : null, s.via, now).first();
  if (made) return made;
  return await db.prepare("SELECT * FROM sales WHERE ref = ?").bind(s.ref).first();
}
async function purchasesOf(db, wallet) {
  const owned = await db.prepare("SELECT * FROM sales WHERE owner = ? ORDER BY created").bind(wallet).all();
  const gifts = await db.prepare("SELECT * FROM sales WHERE buyer = ? AND owner IS NULL ORDER BY created").bind(wallet).all();
  return { owned: owned.results ?? [], gifts: gifts.results ?? [] };
}
async function downloadsOf(db, refs) {
  const out = {};
  for (const ref of refs) {
    const rows = await db.prepare("SELECT track, count FROM downloads WHERE ref = ?").bind(ref).all();
    out[ref] = Object.fromEntries((rows.results ?? []).map((r) => [r.track, r.count]));
  }
  return out;
}
async function redeem(db, wallet, code) {
  if (!GIFT_RE.test(code)) return null;
  const row = await db.prepare("UPDATE sales SET owner = ? WHERE gift = ? AND owner IS NULL RETURNING item").bind(wallet, code).first();
  return row?.item ?? null;
}
async function takeDownload(db, manifest, wallet, track) {
  const items = includes(manifest, track);
  if (!items.length) return null;
  const marks = items.map(() => "?").join(",");
  const rows = await db.prepare(`SELECT ref FROM sales WHERE owner = ? AND item IN (${marks}) ORDER BY created`).bind(wallet, ...items).all();
  for (const { ref } of rows.results ?? []) {
    const used = await db.prepare(
      `INSERT INTO downloads (ref, track, count) VALUES (?, ?, 1)
       ON CONFLICT(ref, track) DO UPDATE SET count = count + 1 WHERE count < ?
       RETURNING count`
    ).bind(ref, track, DOWNLOADS_PER_PURCHASE).first();
    if (used) return { ref, left: DOWNLOADS_PER_PURCHASE - used.count };
  }
  return null;
}
function itemFor(manifest, id) {
  return forSale(manifest).find((x) => x.id === id) ?? null;
}
async function claimWalletSale(db, manifest, { wallet, signature, item, gift, host }, { verify = verifyPayment, now = Date.now() } = {}) {
  const sale = itemFor(manifest, item);
  if (!sale || !sale.wallet) return { ok: false, why: "that isn't for sale for USDC here" };
  const pay = walletOf(manifest);
  const chain = pay && CHAINS[pay.network];
  if (!pay || !chain) return { ok: false, why: "this artist isn't taking USDC" };
  const known = await db.prepare("SELECT * FROM sales WHERE ref = ?").bind(signature).first();
  if (known) return known.buyer === wallet && known.item === item ? { ok: true, sale: known } : { ok: false, why: "that payment has already been used" };
  const result = await verify(
    { signature, payer: wallet },
    { rpc: chain.rpc, mint: chain.mint, recipients: pay.recipients.map((r) => r.address), minMicros: Math.round(sale.price * 1e6), memo: purchaseMemo(host, item) }
  );
  if (!result.ok) {
    const retry = /busy|could not reach|refused the question|no such transaction/.test(result.why || "");
    return { ok: false, why: result.why || "that payment couldn't be confirmed", retry };
  }
  return { ok: true, sale: await recordSale(db, { ref: signature, item, buyer: wallet, gift, via: "usdc" }, now) };
}

// src/solana-tx.ts
var B583 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [];
  for (let k = zeros; k < bytes.length; k++) {
    let carry = bytes[k];
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] * 256;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  return "1".repeat(zeros) + digits.reverse().map((d) => B583[d]).join("");
}
function unbase58(s) {
  if (typeof s !== "string" || !s || s.length > 128) return null;
  const bytes = [];
  for (const ch of s) {
    let carry = B583.indexOf(ch);
    if (carry < 0) return null;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 255;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 255);
      carry >>= 8;
    }
  }
  for (const ch of s) {
    if (ch === "1") bytes.push(0);
    else break;
  }
  return new Uint8Array(bytes.reverse());
}
function keyOf(s) {
  const k = unbase58(s);
  return k && k.length === 32 ? k : null;
}
var TxError = class extends Error {
};
var MAX_TX_BYTES = 1232;
var MAX_SIGNATURES = 4;
var Reader = class {
  at = 0;
  bytes;
  constructor(bytes) {
    this.bytes = bytes;
  }
  byte() {
    if (this.at >= this.bytes.length) throw new TxError("the transaction ends early");
    return this.bytes[this.at++];
  }
  take(n) {
    if (n < 0 || this.at + n > this.bytes.length) throw new TxError("the transaction ends early");
    const out = this.bytes.slice(this.at, this.at + n);
    this.at += n;
    return out;
  }
  /** Solana's "compact-u16": up to three bytes, seven bits each. */
  short() {
    let value = 0;
    for (let i = 0; i < 3; i++) {
      const b = this.byte();
      value |= (b & 127) << 7 * i;
      if ((b & 128) === 0) {
        if (i > 0 && b === 0) throw new TxError("a length is written in a non-standard way");
        return value;
      }
    }
    throw new TxError("a length is too long");
  }
};
function shortBytes(n) {
  const out = [];
  let v = n;
  for (; ; ) {
    const b = v & 127;
    v >>= 7;
    if (v === 0) {
      out.push(b);
      return out;
    }
    out.push(b | 128);
  }
}
function readTransaction(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new TxError("there is no transaction");
  if (bytes.length > MAX_TX_BYTES) throw new TxError("the transaction is too large");
  const r = new Reader(bytes);
  const sigCount = r.short();
  if (sigCount === 0 || sigCount > MAX_SIGNATURES) throw new TxError("the transaction has an unexpected number of signatures");
  const signatures = [];
  for (let i = 0; i < sigCount; i++) signatures.push(r.take(64));
  const messageStart = r.at;
  const required = r.byte();
  if (required & 128) throw new TxError("only legacy transactions are accepted");
  const readonlySigned = r.byte();
  const readonlyUnsigned = r.byte();
  const accountCount = r.short();
  if (accountCount === 0 || accountCount > 64) throw new TxError("the transaction has an unexpected number of accounts");
  const accounts = [];
  for (let i = 0; i < accountCount; i++) accounts.push(base58(r.take(32)));
  if (new Set(accounts).size !== accounts.length) throw new TxError("an account is listed twice");
  if (required !== sigCount) throw new TxError("the signatures don't match the signers");
  if (required > accountCount || readonlySigned >= required || readonlyUnsigned > accountCount - required) {
    throw new TxError("the transaction's header doesn't fit its accounts");
  }
  const blockhash = base58(r.take(32));
  const ixCount = r.short();
  if (ixCount === 0 || ixCount > 16) throw new TxError("the transaction has an unexpected number of instructions");
  const instructions = [];
  for (let i = 0; i < ixCount; i++) {
    const program = r.byte();
    if (program >= accountCount) throw new TxError("an instruction names an account that isn't there");
    const n = r.short();
    const idx = [];
    for (let j = 0; j < n; j++) {
      const a = r.byte();
      if (a >= accountCount) throw new TxError("an instruction names an account that isn't there");
      idx.push(a);
    }
    const len = r.short();
    instructions.push({ program, accounts: idx, data: r.take(len) });
  }
  if (r.at !== bytes.length) throw new TxError("there are extra bytes after the transaction");
  return {
    signatures,
    header: { required, readonlySigned, readonlyUnsigned },
    accounts,
    blockhash,
    instructions,
    message: bytes.slice(messageStart)
  };
}
function isSigner(tx, i) {
  return i < tx.header.required;
}
function isWritable(tx, i) {
  const { required, readonlySigned, readonlyUnsigned } = tx.header;
  if (i < required) return i < required - readonlySigned;
  return i < tx.accounts.length - readonlyUnsigned;
}
function writeTransaction(tx) {
  const head = shortBytes(tx.signatures.length);
  const out = new Uint8Array(head.length + tx.signatures.length * 64 + tx.message.length);
  out.set(head, 0);
  tx.signatures.forEach((s, i) => out.set(s, head.length + i * 64));
  out.set(tx.message, head.length + tx.signatures.length * 64);
  return out;
}
async function verifySignature3(key, sig, message) {
  const raw = keyOf(key);
  if (!raw || sig.length !== 64) return false;
  try {
    const pub = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, pub, sig, message);
  } catch {
    return false;
  }
}
function u64(data, at) {
  if (at + 8 > data.length) throw new TxError("an amount is cut short");
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = v << 8n | BigInt(data[at + i]);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new TxError("an amount is impossibly large");
  return Number(v);
}
var base64 = {
  encode: (b) => btoa(String.fromCharCode(...b)),
  decode: (s) => {
    if (typeof s !== "string" || s.length > 2e3 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
    try {
      return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    } catch {
      return null;
    }
  }
};
var P = (1n << 255n) - 19n;
var D = (-121665n * inverse(121666n) % P + P) % P;
var SQRT_M1 = pow(2n, (P - 1n) / 4n);
function pow(b, e) {
  let r = 1n;
  b %= P;
  while (e > 0n) {
    if (e & 1n) r = r * b % P;
    b = b * b % P;
    e >>= 1n;
  }
  return r;
}
function inverse(a) {
  return pow((a % P + P) % P, P - 2n);
}
function onCurve(bytes) {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = y << 8n | BigInt(i === 31 ? bytes[i] & 127 : bytes[i]);
  const sign = bytes[31] >> 7;
  if (y >= P) return false;
  const yy = y * y % P;
  const u = (yy - 1n + P) % P;
  const v = (D * yy + 1n) % P;
  const v3 = v * v % P * v % P;
  const v7 = v3 * v3 % P * v % P;
  let x = u * v3 % P * pow(u * v7 % P, (P - 5n) / 8n) % P;
  const vxx = v * (x * x % P) % P;
  if (vxx !== u) {
    if (vxx === (P - u) % P) x = x * SQRT_M1 % P;
    else return false;
  }
  if (x === 0n && sign === 1) return false;
  return true;
}
var PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");
async function programAddress(seeds, program) {
  const programKey = keyOf(program);
  if (!programKey) throw new TxError("not a program address");
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, Uint8Array.of(bump), programKey, PDA_MARKER];
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      all.set(p, at);
      at += p.length;
    }
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", all));
    if (!onCurve(hash)) return base58(hash);
  }
  throw new TxError("no program address");
}
async function tokenAccountOf(owner, mint, tokenProgram, ataProgram) {
  const o = keyOf(owner), m = keyOf(mint), t = keyOf(tokenProgram);
  if (!o || !m || !t) throw new TxError("not an address");
  return programAddress([o, t, m], ataProgram);
}
function compileTransaction(feePayer, blockhash, plan) {
  const metas = /* @__PURE__ */ new Map();
  const add = (m) => {
    const had = metas.get(m.key);
    metas.set(m.key, had ? { key: m.key, signer: had.signer || m.signer, writable: had.writable || m.writable } : { ...m });
  };
  add({ key: feePayer, signer: true, writable: true });
  for (const ix of plan) {
    for (const a of ix.accounts) add(a);
    add({ key: ix.program, signer: false, writable: false });
  }
  const all = [...metas.values()];
  const rank = (m) => m.key === feePayer ? -1 : m.signer ? m.writable ? 0 : 1 : m.writable ? 2 : 3;
  const ordered = all.map((m, i) => ({ m, i })).sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i).map((x) => x.m);
  const index = new Map(ordered.map((m, i) => [m.key, i]));
  const required = ordered.filter((m) => m.signer).length;
  const readonlySigned = ordered.filter((m) => m.signer && !m.writable).length;
  const readonlyUnsigned = ordered.filter((m) => !m.signer && !m.writable).length;
  const bytes = [];
  const push = (b) => {
    for (let i = 0; i < b.length; i++) bytes.push(b[i]);
  };
  const key = (k) => {
    const raw = keyOf(k);
    if (!raw) throw new TxError(`not an address: ${k}`);
    return raw;
  };
  push([required, readonlySigned, readonlyUnsigned]);
  push(shortBytes(ordered.length));
  for (const m of ordered) push(key(m.key));
  push(key(blockhash));
  push(shortBytes(plan.length));
  for (const ix of plan) {
    bytes.push(index.get(ix.program));
    push(shortBytes(ix.accounts.length));
    for (const a of ix.accounts) bytes.push(index.get(a.key));
    push(shortBytes(ix.data.length));
    push(ix.data);
  }
  const message = Uint8Array.from(bytes);
  const head = shortBytes(required);
  const out = new Uint8Array(head.length + required * 64 + message.length);
  out.set(head, 0);
  out.set(message, head.length + required * 64);
  return out;
}
function u64Bytes(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new TxError("not an amount");
  const out = new Uint8Array(8);
  let v = BigInt(n);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

// src/feepay.ts
var TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
var ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
var SYSTEM_PROGRAM = "11111111111111111111111111111111";
var MEMO_PROGRAM2 = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
var TRANSFER_CHECKED = 12;
var CREATE_IDEMPOTENT = 1;
var USDC_DECIMALS = 6;
var no = (problem) => ({ ok: false, problem });
async function checkFeePayment(tx, expect) {
  const { feePayer, mint } = expect;
  const payees = expect.payees.filter((p) => typeof p?.address === "string");
  if (!payees.length) return no("this artist has no wallet to pay");
  const payeeSet = new Set(payees.map((p) => p.address));
  if (payeeSet.size !== payees.length) return no("the artist's wallet list names someone twice");
  if (payeeSet.has(feePayer)) return no("the fee wallet can't also be paid");
  if (tx.header.required !== 2 || tx.signatures.length !== 2) return no("a payment has exactly two signers");
  if (tx.accounts[0] !== feePayer) return no("the fee wallet isn't the fee payer");
  if (!isWritable(tx, 0)) return no("the fee wallet must pay the fee");
  const listener2 = tx.accounts[1];
  if (payeeSet.has(listener2)) return no("the artist can't pay themselves through their own node");
  if (!tx.signatures[0].every((b) => b === 0)) return no("the fee wallet's signature is already there");
  const at = (i) => tx.accounts[i];
  const created = /* @__PURE__ */ new Map();
  const paid = /* @__PURE__ */ new Map();
  const uses = /* @__PURE__ */ new Map();
  let memos = 0;
  for (const ix of tx.instructions) {
    const program = at(ix.program);
    if (isSigner(tx, ix.program)) return no("a signer is used as a program");
    if (program === ATA_PROGRAM) {
      if (ix.data.length !== 1 || ix.data[0] !== CREATE_IDEMPOTENT) return no("only creating a payee's USDC account is allowed");
      if (ix.accounts.length !== 6) return no("creating a USDC account takes six accounts");
      const [payer, account, owner, mintAt, system, token] = ix.accounts;
      if (payer !== 0) return no("the fee wallet pays for a payee's USDC account, nobody else");
      if (!payeeSet.has(at(owner))) return no("a USDC account is being created for someone who isn't paid");
      if (at(mintAt) !== mint) return no("that isn't USDC");
      if (at(system) !== SYSTEM_PROGRAM || at(token) !== TOKEN_PROGRAM) return no("creating a USDC account names the wrong programs");
      if (account < 2 || owner < 2) return no("a signer can't be a payee's account");
      if (created.has(at(account)) || [...created.values()].includes(at(owner))) return no("a payee's USDC account is created twice");
      created.set(at(account), at(owner));
      uses.set(0, (uses.get(0) ?? 0) + 1);
      continue;
    }
    if (program === TOKEN_PROGRAM) {
      if (ix.data.length !== 10 || ix.data[0] !== TRANSFER_CHECKED) return no("only checked USDC transfers are allowed");
      if (ix.data[9] !== USDC_DECIMALS) return no("that isn't USDC");
      if (ix.accounts.length !== 4) return no("a transfer takes four accounts");
      const [source, mintAt, dest, authority] = ix.accounts;
      if (authority !== 1) return no("the listener must sign their own payment");
      if (at(mintAt) !== mint) return no("that isn't USDC");
      if (source < 2) return no("a signer can't be a token account");
      const payee = created.get(at(dest));
      if (!payee) return no("a transfer goes somewhere that isn't a payee's USDC account");
      if (created.has(at(source))) return no("a transfer can't come from a payee's account");
      if (paid.has(payee)) return no("a payee is paid twice");
      const micros2 = u64(ix.data, 1);
      if (micros2 <= 0) return no("a transfer of nothing");
      paid.set(payee, micros2);
      uses.set(1, (uses.get(1) ?? 0) + 1);
      continue;
    }
    if (program === MEMO_PROGRAM2 && expect.memo !== void 0) {
      if (++memos > 1) return no("a payment carries one note");
      if (ix.accounts.length !== 1 || ix.accounts[0] !== 1) return no("only the listener signs a payment's note");
      if (new TextDecoder().decode(ix.data) !== expect.memo || ix.data.length > 200) return no("the note doesn't say what was bought");
      uses.set(1, (uses.get(1) ?? 0) + 1);
      continue;
    }
    return no("the payment uses a program it doesn't need");
  }
  for (const ix of tx.instructions) {
    if (ix.program === 0 || ix.program === 1) return no("a signer is used as a program");
  }
  const mentions = (i) => tx.instructions.reduce((n, ix) => n + ix.accounts.filter((a) => a === i).length, 0);
  if (mentions(0) !== (uses.get(0) ?? 0)) return no("the fee wallet is used for something other than fees");
  if (mentions(1) !== (uses.get(1) ?? 0)) return no("the listener's key is used for something other than paying");
  if (expect.memo !== void 0 && memos !== 1) return no("a purchase must say what it bought");
  if (paid.size !== created.size) return no("a USDC account is created without being paid");
  const micros = [...paid.values()].reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(micros)) return no("the amount is impossibly large");
  let shares;
  if (expect.withdrawal) {
    const [dest, artist] = payees.map((p) => p.address);
    if (payees.length !== 2 || paid.size !== 2) return no("a withdrawal pays the destination and the fee, nothing else");
    const out = paid.get(dest) ?? 0, fee = paid.get(artist) ?? 0;
    if (fee < expect.withdrawal.fee) return no("the fee for sending isn't included");
    if (out < expect.minMicros) return no("too small to send");
    if (out > expect.maxMicros) return no("more than one transfer can be");
    shares = [{ address: dest, micros: out }, { address: artist, micros: fee }];
  } else {
    if (micros < expect.minMicros) return no("too small to pay the network fee for");
    if (micros > expect.maxMicros) return no("more than one payment can be");
    shares = shareOut(micros, payees).map((s) => ({ address: s.address, micros: s.micros }));
    if (shares.length !== paid.size || !shares.every((s) => paid.get(s.address) === s.micros)) {
      return no("the payment isn't split the way the artist set it");
    }
  }
  if (!await verifySignature3(listener2, tx.signatures[1], tx.message)) return no("the listener's signature doesn't check out");
  return { ok: true, listener: listener2, micros, shares };
}

// src/settle.ts
var LISTEN_MIN_MICROS2 = LISTEN_MIN_MICROS;
var LISTEN_MAX_MICROS2 = LISTEN_MAX_MICROS;
var DAILY_PAYMENTS = 1e3;
var DAILY_SENDS = 50;
var dayKey = (kind, now) => {
  const day = new Date(now).toISOString().slice(0, 10);
  return kind === "send" ? `send:${day}` : day;
};
var capOf = (kind) => kind === "send" ? DAILY_SENDS : DAILY_PAYMENTS;
var OFFER_ABOVE_LAMPORTS = FEES_READY_LAMPORTS;
var WITHDRAW_FEE_MICROS = 5e4;
var NEW_ACCOUNT_FEE_MICROS = 5e5;
var FEE_KEY = "fee-wallet";
var RPC_TIMEOUT_MS = 1e4;
var CONFIRM_WITHIN_MS = 25e3;
var cached = null;
async function load(stored) {
  const { pkcs8, address } = JSON.parse(stored);
  const raw = base64.decode(pkcs8);
  if (!raw || typeof address !== "string") throw new Error("the fee wallet's key is damaged");
  const key = await crypto.subtle.importKey("pkcs8", raw, { name: "Ed25519" }, false, ["sign"]);
  return {
    address,
    sign: async (message) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, message))
  };
}
async function feeKey(db) {
  if (cached) return cached;
  let stored = await setting(db, FEE_KEY);
  if (!stored) {
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const made = JSON.stringify({ pkcs8: base64.encode(pkcs8), address: base58(pub) });
    await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING").bind(FEE_KEY, made).run();
    stored = await setting(db, FEE_KEY) ?? made;
  }
  cached = await load(stored);
  return cached;
}
async function feeAddress(db) {
  return (await feeKey(db)).address;
}
var onrampMessage = (address, signedAt) => `Amply: add money to ${address} through Coinbase (${signedAt})`;
async function feeOnrampSignature(db, signedAt, now = Date.now()) {
  if (!Number.isSafeInteger(signedAt) || Math.abs(now - signedAt) > 3e4) return null;
  const key = await feeKey(db);
  const sig = await key.sign(new TextEncoder().encode(onrampMessage(key.address, signedAt)));
  return { address: key.address, signature: base58(sig) };
}
var RpcError = class extends Error {
};
function rpcAt(url) {
  return async (method, params) => {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        // Solana's public endpoint refuses a Worker without a User-Agent.
        headers: { "Content-Type": "application/json", "User-Agent": "amply-node/1.0" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS)
      });
    } catch {
      throw new RpcError("couldn't reach the network");
    }
    if (!res.ok) throw new RpcError(res.status === 429 ? "the network is busy" : "the network refused the request");
    const body = await res.json().catch(() => null);
    if (!body || body.error) throw new RpcError(`the network said: ${String(body?.error?.message || "nothing useful").slice(0, 200)}`);
    return body.result;
  };
}
var balances = /* @__PURE__ */ new Map();
var BALANCE_FRESH_MS = 5 * 6e4;
async function feeBalance(rpc, address, { fresh = false, now = Date.now() } = {}) {
  const known = balances.get(address);
  if (known && !fresh && now - known.at < BALANCE_FRESH_MS) return known.lamports;
  let r;
  try {
    r = await rpc("getBalance", [address, { commitment: "confirmed" }]);
  } catch (e) {
    if (!fresh && known && now - known.at < 36e5) return known.lamports;
    throw e;
  }
  const lamports = Number(r?.value ?? 0);
  balances.set(address, { lamports, at: now });
  return lamports;
}
async function feeRoom(db, kind = "pay", now = Date.now()) {
  try {
    const row = await db.prepare("SELECT count FROM fee_days WHERE day = ?").bind(dayKey(kind, now)).first();
    return (row?.count ?? 0) < capOf(kind);
  } catch {
    return false;
  }
}
async function countFee(db, now = Date.now(), kind = "pay") {
  try {
    const row = await db.prepare(
      `INSERT INTO fee_days (day, count) VALUES (?, 1)
       ON CONFLICT(day) DO UPDATE SET count = count + 1
       RETURNING count`
    ).bind(dayKey(kind, now)).first();
    if (row && row.count === 1) {
      const cutoff = new Date(now - 31 * 864e5).toISOString().slice(0, 10);
      await db.prepare("DELETE FROM fee_days WHERE (day NOT LIKE 'send:%' AND day < ?) OR (day LIKE 'send:%' AND substr(day, 6) < ?)").bind(cutoff, cutoff).run();
    }
    return !!row && row.count <= capOf(kind);
  } catch {
    return false;
  }
}
async function openedBefore(db, owner) {
  const row = await db.prepare("SELECT count FROM fee_days WHERE day = ?").bind(`opened:${owner}`).first();
  return !!row;
}
async function noteOpened(db, owner) {
  await db.prepare("INSERT INTO fee_days (day, count) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET count = count + 1").bind(`opened:${owner}`).run();
}
var refuse = (status, why) => ({ ok: false, status, why });
async function settle(db, rpc, txBase64, expect, { allowed = async (_listener) => true, now = Date.now(), wait = (ms) => new Promise((r) => setTimeout(r, ms)), confirmWithinMs = CONFIRM_WITHIN_MS, from, kind = "pay", openOnce } = {}) {
  const bytes = base64.decode(String(txBase64 ?? ""));
  if (!bytes) return refuse(400, "that isn't a transaction");
  let tx;
  try {
    tx = readTransaction(bytes);
  } catch (e) {
    return refuse(400, e instanceof TxError ? e.message : "that isn't a transaction");
  }
  const key = await feeKey(db);
  const verdict = await checkFeePayment(tx, { ...expect, feePayer: key.address });
  if (!verdict.ok) return refuse(403, verdict.problem);
  if (from && !from.includes(verdict.listener)) return refuse(403, "that isn't one of your payout wallets");
  if (!await allowed(verdict.listener)) return refuse(429, "too many payments from this wallet; try again in a minute");
  const full = refuse(503, kind === "send" ? "that's the most sends to the bank in one day; try again tomorrow" : "this artist's node has paid all the fees it will today; try again tomorrow");
  if (!await feeRoom(db, kind, now)) return full;
  const once = openOnce ?? verdict.shares.map((s) => s.address);
  const opening = [];
  if (once.length) {
    try {
      const accounts = await Promise.all(once.map((o) => tokenAccountOf(o, expect.mint, TOKEN_PROGRAM, ATA_PROGRAM)));
      const found = await rpc("getMultipleAccounts", [accounts, { encoding: "base64", commitment: "confirmed" }]);
      once.forEach((o, i) => {
        if (!found?.value?.[i]) opening.push(o);
      });
    } catch (e) {
      return refuse(502, e instanceof RpcError ? e.message : "couldn't reach the network");
    }
    for (const o of opening) {
      if (await openedBefore(db, o).catch(() => true)) {
        return refuse(403, "a payee closed their USDC account after this server opened it; they need to open it again themselves");
      }
    }
  }
  tx.signatures[0] = await key.sign(tx.message);
  const signed = base64.encode(writeTransaction(tx));
  const signature = base58(tx.signatures[0]);
  try {
    const sim = await rpc("simulateTransaction", [signed, { encoding: "base64", sigVerify: true, commitment: "confirmed" }]);
    if (sim?.value?.err) {
      const why = failureOf(sim.value);
      if (why === CANT_PAY_FEE) {
        balances.delete(key.address);
        return refuse(409, why);
      }
      return refuse(422, why);
    }
  } catch (e) {
    return refuse(502, e instanceof RpcError ? e.message : "couldn't reach the network");
  }
  if (!await countFee(db, now, kind)) return full;
  for (const o of opening) await noteOpened(db, o).catch(() => {
  });
  try {
    await rpc("sendTransaction", [signed, { encoding: "base64", skipPreflight: true, maxRetries: 5 }]);
  } catch {
    return { ok: true, signature, micros: verdict.micros, confirmed: false };
  }
  const until = Date.now() + confirmWithinMs;
  while (Date.now() < until) {
    await wait(1500);
    try {
      const st = (await rpc("getSignatureStatuses", [[signature]]))?.value?.[0];
      if (st?.err) return refuse(422, "the payment failed on the network; nothing was taken");
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
        return { ok: true, signature, micros: verdict.micros, confirmed: true };
      }
    } catch {
    }
  }
  return { ok: true, signature, micros: verdict.micros, confirmed: false };
}
var CANT_PAY_FEE = "this artist's node can't pay the network fee right now; nothing was sent";
function failureOf(value) {
  const logs = (value.logs || []).join("\n");
  if (/insufficient funds/i.test(logs) && /Transfer/i.test(logs)) return "there isn't enough in your wallet to pay this; nothing was sent";
  if (/Blockhash not found|BlockhashNotFound/i.test(JSON.stringify(value.err))) return "that payment is out of date; try again";
  if (/insufficient lamports|InsufficientFundsForFee|InsufficientFundsForRent/i.test(logs + JSON.stringify(value.err))) {
    return CANT_PAY_FEE;
  }
  return "the network wouldn't accept that payment; nothing was sent";
}

// src/cashout.ts
var CASHOUT_MIN_MICROS = 1e4;
var CASHOUT_MAX_MICROS = 1e10;
function cashOutProblem(from, to, micros, { payees, feePayer }) {
  if (!payees.includes(from)) return "that isn't one of your payout wallets";
  if (!keyOf(to)) return "that isn't a Solana address. Copy it again from Cash App or Coinbase";
  if (to === from) return "that's your payout wallet's own address";
  if (to === feePayer) return "that's your fees account. Paste the deposit address from Cash App or Coinbase";
  if (!Number.isSafeInteger(micros) || micros < CASHOUT_MIN_MICROS) return "send at least a cent";
  if (micros > CASHOUT_MAX_MICROS) return "that's more than one transfer can be";
  return null;
}
async function draftCashOut({ feePayer, from, to, micros, mint, blockhash }) {
  const source = await tokenAccountOf(from, mint, TOKEN_PROGRAM, ATA_PROGRAM);
  const dest = await tokenAccountOf(to, mint, TOKEN_PROGRAM, ATA_PROGRAM);
  const data = new Uint8Array(10);
  data[0] = 12;
  data.set(u64Bytes(micros), 1);
  data[9] = 6;
  return compileTransaction(feePayer, blockhash, [
    {
      program: ATA_PROGRAM,
      data: Uint8Array.of(1),
      accounts: [
        { key: feePayer, signer: true, writable: true },
        { key: dest, signer: false, writable: true },
        { key: to, signer: false, writable: false },
        { key: mint, signer: false, writable: false },
        { key: SYSTEM_PROGRAM, signer: false, writable: false },
        { key: TOKEN_PROGRAM, signer: false, writable: false }
      ]
    },
    {
      program: TOKEN_PROGRAM,
      data,
      accounts: [
        { key: source, signer: false, writable: true },
        { key: mint, signer: false, writable: false },
        { key: dest, signer: false, writable: true },
        { key: from, signer: true, writable: false }
      ]
    }
  ]);
}

// src/limits.ts
var RULES = {
  /** Listener requests that cost: a pass, a play, a purchase, a download. */
  listen: { binding: "LIMIT_LISTEN", limit: 40, period: 60 },
  /** Audio, pictures and pages: many small requests while a song plays. */
  media: { binding: "LIMIT_MEDIA", limit: 600, period: 60 },
  /** Play reports from any one wallet: a song can't finish every ten seconds. */
  wallet: { binding: "LIMIT_WALLET", limit: 6, period: 60 },
  /** Brand-new listeners, across the whole service. */
  newListener: { binding: "LIMIT_NEW", limit: 20, period: 60 }
};
var counts = /* @__PURE__ */ new Map();
var MAX_KEYS = 1e4;
function counted2(key, rule, now) {
  const k = `${rule.binding}|${key}`;
  let c = counts.get(k);
  if (!c || c.until <= now) {
    if (counts.size >= MAX_KEYS) {
      for (const [old, v] of counts) if (v.until <= now) counts.delete(old);
      if (counts.size >= MAX_KEYS) counts.clear();
    }
    c = { n: 0, until: now + rule.period * 1e3 };
    counts.set(k, c);
  }
  c.n++;
  return c.n <= rule.limit;
}
async function allow(env, rule, key, now = Date.now()) {
  const binding = env[rule.binding];
  if (binding && typeof binding.limit === "function") {
    try {
      return (await binding.limit({ key })).success;
    } catch {
    }
  }
  return counted2(key, rule, now);
}
function ruleFor(method, pathname) {
  if (pathname === "/manage" || pathname.startsWith("/manage/")) return null;
  if (pathname === "/stripe/webhook") return RULES.listen;
  if (method === "OPTIONS") return null;
  if (pathname === "/listen/challenge") return RULES.media;
  if (pathname.startsWith("/listen/")) return RULES.listen;
  return RULES.media;
}
function tooMany(headers) {
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Retry-After", "60");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify({ error: "Too many requests. Try again in a minute." }), { status: 429, headers });
}

// studio/icon-180.png
var icon_180_default = __toBinary("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");

// studio/icon-192.png
var icon_192_default = __toBinary("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");

// studio/icon-512.png
var icon_512_default = __toBinary("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");

// src/studio.ts
var ICONS = {
  "/studio/icon-180.png": icon_180_default,
  "/studio/icon-192.png": icon_192_default,
  "/studio/icon-512.png": icon_512_default
};
var FAVICON_PATH = "/favicon.svg";
var FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="#f6711e"><title>Amply</title><circle cx="8.2" cy="24.6" r="6.2"/><circle cx="23.4" cy="23.6" r="6.2"/><rect x="11.8" y="3.2" width="2.6" height="21.6" rx="1.3"/><rect x="27" y="6.4" width="2.6" height="17.4" rx="1.3"/><rect x="15.825" y="6" width="2.3" height="8.5" rx="1.15"/><rect x="19.55" y="3.8" width="2.3" height="12.6" rx="1.15"/><rect x="23.275" y="7" width="2.3" height="8" rx="1.15"/></svg>`;
var MANIFEST_PATH = "/studio.webmanifest";
var studioManifest = () => JSON.stringify({
  name: "Amply \u2014 your music",
  short_name: "Your music",
  description: "Publish your music, set your prices, see who listens.",
  start_url: "/manage",
  scope: "/manage",
  display: "standalone",
  background_color: "#000000",
  // the launch screen, around the black icon
  theme_color: "#ffffff",
  icons: [
    { src: "/studio/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/studio/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/studio/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
  ]
});

// src/constants.ts
var VERSION = "3.24.5";
var SPEC_VERSION = 1;
var RELAY_ORIGIN = "https://amply-relay.sdarmistead.workers.dev";
var MANAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  // blob: is load-bearing, not slack. Before an upload starts, the editor reads
  // a track's length by pointing an <audio> element at a Blob of the chosen
  // file: the manifest requires a duration, and a player must never download
  // audio just to learn one. A blob: URL can only refer to data this page
  // already holds, so it reaches nothing 'self' does not.
  "media-src 'self' blob:",
  // The editor PUTs the manifest and every file back to this same node, and
  // asks Solana who has paid. That second one cannot happen on the node: the
  // public RPC refuses a Cloudflare Worker outright. For real money it refuses
  // browsers too, so mainnet is PublicNode, which accepts them; devnet is
  // Solana's own. Two exact hosts, read-only questions, no key involved —
  // narrow enough that the "cannot exfiltrate" property above still holds.
  //
  // amply.stream is for one GET of one public file: the version of the latest
  // software, so this editor can tell the artist theirs is old. Nobody can
  // update an artist's node but the artist, which makes noticing the only
  // mechanism there is — and no artist should have to find out that a security
  // fix exists by reading a changelog. It adds no trust: this editor was
  // downloaded from that address in the first place.
  //
  // The two DNS-over-HTTPS resolvers answer "has my domain been linked yet?"
  // — a public DNS question about a public record, asked of the same two
  // resolvers the listening app uses.
  "connect-src 'self' https://solana-rpc.publicnode.com https://api.devnet.solana.com https://amply.stream https://1.1.1.1 https://cloudflare-dns.com https://dns.google",
  // The manifest that makes the editor installable (studio.ts), from here.
  "manifest-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'"
].join("; ");

// src/media.ts
var KV_MAX = 25 * 1024 * 1024;
var R2_MAX = 100 * 1024 * 1024;
var MediaTooLarge = class extends Error {
  limit;
  constructor(limit) {
    super(`files here can be at most ${Math.floor(limit / 1024 / 1024)} MB`);
    this.limit = limit;
  }
};
function media(env) {
  if (env.MEDIA) return r2Media(env.MEDIA);
  if (env.MEDIA_KV) return kvMedia(env.MEDIA_KV);
  throw new Error("this node has no storage bound (MEDIA or MEDIA_KV)");
}
function r2Media(bucket) {
  return {
    get: (key, options) => bucket.get(key, options ?? {}),
    head: (key) => bucket.head(key),
    put: (key, body, options) => bucket.put(key, body, options),
    delete: (key) => bucket.delete(key),
    async used() {
      let bytes = 0;
      let cursor;
      do {
        const page = await bucket.list({ cursor, limit: 1e3 });
        for (const o of page.objects) bytes += o.size;
        cursor = page.truncated ? page.cursor : void 0;
      } while (cursor);
      return bytes;
    }
  };
}
function maxObject(env) {
  return env.MEDIA ? R2_MAX : KV_MAX;
}
async function etagOf(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}
function parseRange(header, size) {
  if (!header) return void 0;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || m[1] === "" && m[2] === "") return void 0;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0) throw new RangeError("unsatisfiable range");
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const offset = Number(m[1]);
  if (offset >= size) throw new RangeError("unsatisfiable range");
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (end < offset) return void 0;
  return { offset, length: end - offset + 1 };
}
var tags = (header) => header.split(",").map((t) => t.trim().replace(/^W\//, "").replace(/^"|"$/g, ""));
function conditionsHold(headers, meta) {
  if (!headers) return true;
  const ifMatch = headers.get("If-Match");
  if (ifMatch && !tags(ifMatch).some((t) => t === "*" || t === meta.etag)) return false;
  const ifNoneMatch = headers.get("If-None-Match");
  if (ifNoneMatch) return !tags(ifNoneMatch).some((t) => t === "*" || t === meta.etag);
  const since = Date.parse(headers.get("If-Modified-Since") ?? "");
  if (!Number.isNaN(since) && Math.floor(meta.uploaded / 1e3) <= Math.floor(since / 1e3)) return false;
  const unmodified = Date.parse(headers.get("If-Unmodified-Since") ?? "");
  if (!Number.isNaN(unmodified) && Math.floor(meta.uploaded / 1e3) > Math.floor(unmodified / 1e3)) return false;
  return true;
}
function described(meta, range) {
  return {
    size: meta.size,
    httpEtag: `"${meta.etag}"`,
    range,
    writeHttpMetadata(headers) {
      if (meta.type) headers.set("Content-Type", meta.type);
    }
  };
}
async function metaFor(bytes, meta) {
  return meta ?? { size: bytes.byteLength, etag: await etagOf(bytes), uploaded: 0 };
}
function kvMedia(kv) {
  const store = kv;
  return {
    async get(key, options = {}) {
      const { value, metadata } = await store.getWithMetadata(key, { type: "arrayBuffer" });
      if (value === null) return null;
      const meta = await metaFor(value, metadata);
      if (!conditionsHold(options.onlyIf, meta)) return described(meta);
      const range = parseRange(options.range?.get("Range") ?? null, meta.size);
      const bytes = range ? value.slice(range.offset, range.offset + range.length) : value;
      return { ...described(meta, range), body: new Blob([bytes]).stream() };
    },
    async head(key) {
      const { value, metadata } = await store.getWithMetadata(key, { type: "stream" });
      if (value === null) return null;
      if (metadata) {
        await value.cancel();
        return described(metadata);
      }
      return described(await metaFor(await new Response(value).arrayBuffer(), null));
    },
    async put(key, body, options = {}) {
      const bytes = await new Response(body).arrayBuffer();
      if (bytes.byteLength > KV_MAX) throw new MediaTooLarge(KV_MAX);
      const meta = {
        type: options.httpMetadata?.contentType,
        size: bytes.byteLength,
        etag: await etagOf(bytes),
        uploaded: Date.now()
      };
      await store.put(key, bytes, { metadata: meta });
    },
    async delete(key) {
      await store.delete(key);
    },
    async used() {
      let bytes = 0;
      let cursor;
      do {
        const page = await store.list({ cursor, limit: 1e3 });
        for (const k of page.keys) bytes += k.metadata?.size ?? 0;
        cursor = page.list_complete ? void 0 : page.cursor;
      } while (cursor);
      return bytes;
    }
  };
}

// src/quota.ts
var FREE_REQUESTS_A_DAY = 1e5;
var REQUESTS_PER_PLAY = 6;
var FREE_STREAMS_A_DAY = Math.floor(FREE_REQUESTS_A_DAY / REQUESTS_PER_PLAY);
var FREE_STORAGE = { kv: 1e9, r2: 1e10 };
function hoursToReset(now = Date.now()) {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - now) / 36e5));
}
function quotaFailure(e, now = Date.now()) {
  const text = String(e?.message ?? e);
  const back = `It resets at midnight UTC, in about ${hoursToReset(now)} hour${hoursToReset(now) === 1 ? "" : "s"}.`;
  if (/storage limit|maximum (db|database) size|database (or disk )?is full|SQLITE_FULL|namespace.*(full|storage)/i.test(text)) {
    return {
      status: 507,
      message: "Your storage is full: that's as much as Cloudflare's free plan holds. Delete some songs, or switch on R2 storage in Cloudflare, which holds more (free, but Cloudflare asks for a card)."
    };
  }
  if (/limit exceeded for the day|daily (row )?(read|write)s? limit|exceeded .*daily|daily .*exceeded/i.test(text)) {
    return /put\(\)|delete\(\)|list\(\)|writ/i.test(text) ? { status: 429, message: `You've used Cloudflare's free limit for changes today. ${back}` } : { status: 503, message: `This page has reached Cloudflare's free daily limit. ${back}` };
  }
  return null;
}

// src/index.ts
var MANIFEST_KEY = "manifest";
var ACCESS_KEY = "access";
var MANAGE_PREFIX = "manage";
function bundledEditor() {
  const html = globalThis.__amplyEditor;
  return typeof html === "string" && html.length > 0 ? html : null;
}
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
var MANIFEST_CACHE = 5e3;
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Range, If-None-Match, If-Range, Content-Type, Cf-Access-Jwt-Assertion",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Content-Type, ETag, Accept-Ranges, Content-Disposition, X-Downloads-Left",
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
    object = await media(env).get(key, {
      range: request.headers,
      onlyIf: request.headers
    });
  } catch {
    const meta = await media(env).head(key);
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
var cachedManifest = null;
var cachedSite = null;
async function siteText(env) {
  const now = Date.now();
  if (cachedSite && now - cachedSite.at < MANIFEST_CACHE) return cachedSite.body;
  const body = await setting(env.DB, "site").catch(() => null);
  cachedSite = { at: now, body };
  return body;
}
async function manifestText(env) {
  const now = Date.now();
  if (cachedManifest && now - cachedManifest.at < MANIFEST_CACHE) return cachedManifest.body;
  const body = await setting(env.DB, MANIFEST_KEY);
  cachedManifest = { at: now, body };
  return body;
}
async function listenerText(env) {
  const text = await manifestText(env);
  if (text === null) return null;
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    return text;
  }
  const at = (manifest?.payment || []).findIndex((p) => p?.type === "solana-usdc");
  if (at < 0) return text;
  if (await feeOffer(env).catch(() => null)) return text;
  manifest.payment[at] = { ...manifest.payment[at], paused: true };
  return JSON.stringify(manifest);
}
async function takingPayments(env) {
  const text = await listenerText(env);
  try {
    return !paused(text ? JSON.parse(text) : null);
  } catch {
    return false;
  }
}
async function serveManifest(env) {
  const body = await listenerText(env);
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
var STORAGE_KEY = "storage-used";
async function storageUsed(env, now = Date.now()) {
  try {
    const kept = JSON.parse(await setting(env.DB, STORAGE_KEY) || "null");
    if (kept && now - kept.at < 36e5) return kept.bytes;
    const bytes = await media(env).used();
    await putSetting(env.DB, STORAGE_KEY, JSON.stringify({ bytes, at: now }));
    return bytes;
  } catch {
    return 0;
  }
}
async function accessConfig(env) {
  const raw = await setting(env.DB, ACCESS_KEY);
  if (raw === null) return { set: false, config: null };
  try {
    const c = JSON.parse(raw);
    return { set: true, config: c && typeof c.team === "string" && c.team && typeof c.aud === "string" && c.aud ? c : null };
  } catch {
    return { set: true, config: null };
  }
}
function noStore(extra) {
  const h = withCors(new Headers(extra));
  h.set("Cache-Control", "no-store");
  return h;
}
async function handleManage(request, env, path) {
  const { set: locked, config } = await accessConfig(env);
  const preview = locked ? null : readPreviewKey(await setting(env.DB, PREVIEW_KEY));
  if (path === "/open" && request.method === "GET") {
    const h = noStore({ "Content-Type": "text/html; charset=utf-8", "Referrer-Policy": "no-referrer" });
    h.set("Content-Security-Policy", MANAGE_CSP);
    return new Response(OPEN_PAGE, { status: 200, headers: h });
  }
  if (path === "/open" && request.method === "POST") {
    if (request.headers.get("Origin") !== new URL(request.url).origin) return fail(403, "that request did not come from your page");
    return openPreview(request, preview);
  }
  if (locked && !config) {
    return fail(
      503,
      "This streaming service's sign-in setting is damaged, so the editor stays closed. Go to https://amply.stream/repair and rebuild it \u2014 your music and settings are untouched."
    );
  }
  if (!config && !preview) {
    return fail(
      503,
      "This streaming service has no sign-in set up, so the editor cannot be opened. Go to https://amply.stream/repair and rebuild it with your email address \u2014 your music and settings are untouched."
    );
  }
  let email = "";
  if (config) {
    email = await verifyAccess(request, config);
    if (!email) {
      if (!new URL(request.url).host.endsWith(".workers.dev")) {
        return fail(401, "Your editor isn't on this address. Open it at your .workers.dev address, the one from setup.");
      }
      if (request.method === "GET" && (path === "" || path === "/")) {
        return new Response(SECURING_PAGE, { status: 503, headers: noStore({ "Content-Type": "text/html; charset=utf-8", "Retry-After": "5" }) });
      }
      return fail(401, "not signed in");
    }
  } else if (!await previewSession(request, preview)) {
    return fail(401, "Your editor opens from the setup page until your page is yours. Claim it, then finish at https://amply.stream/start.");
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    const origin = request.headers.get("Origin");
    const site = request.headers.get("Sec-Fetch-Site");
    const here = new URL(request.url).origin;
    const sameOrigin = origin ? origin === here : site === "same-origin";
    if (!sameOrigin) return fail(403, "that request did not come from your editor");
  }
  if (request.method === "GET" && (path === "" || path === "/")) {
    const h = noStore({ "Content-Type": "text/html; charset=utf-8" });
    h.set("Content-Security-Policy", MANAGE_CSP);
    const bundled = bundledEditor();
    if (bundled) return new Response(bundled, { status: 200, headers: h });
    const obj = await media(env).get(`${MANAGE_PREFIX}/index.html`);
    if (obj === null || !("body" in obj)) return fail(404, "editor not installed on this node");
    return new Response(obj.body, { status: 200, headers: h });
  }
  if (request.method === "GET" && path === "/whoami") {
    const home = await setting(env.DB, "home");
    let temporary = null;
    if (!config) {
      const claimed = await claimedYet(preview);
      if (claimed && !preview.claimed) await putSetting(env.DB, PREVIEW_KEY, JSON.stringify(afterClaim(preview)));
      temporary = previewNotice(preview, claimed);
    }
    return new Response(JSON.stringify({ email, version: VERSION, home, temporary, maxFile: maxObject(env) }), {
      status: 200,
      headers: noStore({ "Content-Type": "application/json; charset=utf-8" })
    });
  }
  if (path === "/payout" && request.method === "GET") {
    const t = await setting(env.DB, "payout");
    return new Response(t || "null", { status: 200, headers: noStore({ "Content-Type": "application/json; charset=utf-8" }) });
  }
  if (path === "/payout" && request.method === "POST") {
    const body = await jsonBody(request, 1e3);
    const address = typeof body?.address === "string" ? body.address : "";
    if (!keyOf(address)) return fail(400, "not a payout address");
    await putSetting(env.DB, "payout", JSON.stringify({ address }));
    return new Response(JSON.stringify({ address }), { status: 200, headers: noStore({ "Content-Type": "application/json; charset=utf-8" }) });
  }
  if (path === "/cashout/coinbase" && request.method === "GET") {
    const q = new URL(request.url).searchParams;
    const pay = walletOf(await manifestNowOf(env));
    if (!pay?.recipients.some((r) => r.address === q.get("address"))) return fail(400, "that isn't one of your payout wallets");
    const ask = new URLSearchParams({ address: q.get("address") || "", signedAt: q.get("signedAt") || "", signature: q.get("signature") || "" });
    const res = await fetch(`${RELAY_ORIGIN}/coinbase/sell/status?${ask}`).catch(() => null);
    const body = res ? await res.text() : JSON.stringify({ error: "Coinbase couldn't be reached" });
    return new Response(body, { status: res?.status ?? 502, headers: noStore({ "Content-Type": "application/json; charset=utf-8" }) });
  }
  if (path === "/site" && request.method === "GET") {
    const t = await setting(env.DB, "site");
    return new Response(t || "null", { status: 200, headers: noStore({ "Content-Type": "application/json; charset=utf-8" }) });
  }
  if (path === "/site" && request.method === "POST") {
    if (Number(request.headers.get("Content-Length") || 0) > 3e5) return fail(413, "that website is too large");
    const body = await jsonBody(request, 3e5);
    if (!body) return fail(400, "bad request");
    const clean = body.site === null ? null : cleanSite(body.site);
    if (clean === null) await env.DB.prepare("DELETE FROM settings WHERE key = 'site'").run();
    else await putSetting(env.DB, "site", JSON.stringify(clean));
    cachedSite = null;
    return new Response(JSON.stringify({ site: clean }), { status: 200, headers: noStore({ "Content-Type": "application/json; charset=utf-8" }) });
  }
  if (request.method === "GET" && path === "/stats") {
    const usage = {
      streams: { used: await playsToday(env.DB), of: FREE_STREAMS_A_DAY },
      storage: { used: await storageUsed(env), of: env.MEDIA ? FREE_STORAGE.r2 : FREE_STORAGE.kv }
    };
    return new Response(JSON.stringify({ songs: await songTotals(env.DB), usage }), {
      status: 200,
      headers: noStore({ "Content-Type": "application/json; charset=utf-8" })
    });
  }
  if (request.method === "GET" && path === "/fees") {
    const address = await feeAddress(env.DB);
    const text = await manifestText(env);
    let network = "solana";
    try {
      network = walletOf(text ? JSON.parse(text) : null)?.network || network;
    } catch {
    }
    const chain = CHAINS[network] || CHAINS.solana;
    const lamports = await feeBalance(rpcAt(chain.rpc), address, { fresh: true }).catch(() => null);
    const today = await env.DB.prepare("SELECT count FROM fee_days WHERE day = ?").bind((/* @__PURE__ */ new Date()).toISOString().slice(0, 10)).first().catch(() => null);
    return new Response(JSON.stringify({
      address,
      network,
      lamports,
      offering: lamports !== null && lamports >= OFFER_ABOVE_LAMPORTS,
      offerAbove: OFFER_ABOVE_LAMPORTS,
      paidToday: today?.count ?? 0,
      dailyCap: DAILY_PAYMENTS
    }), { status: 200, headers: noStore({ "Content-Type": "application/json; charset=utf-8" }) });
  }
  if (request.method === "POST" && path === "/fees/onramp") {
    const body = await jsonBody(request, 1e3);
    const signed = body ? await feeOnrampSignature(env.DB, Number(body.signedAt)) : null;
    if (!signed) return fail(400, "check this device's clock and try again");
    return new Response(JSON.stringify(signed), { status: 200, headers: noStore({ "Content-Type": "application/json; charset=utf-8" }) });
  }
  if (request.method === "POST" && (path === "/send/prepare" || path === "/send")) {
    const body = await jsonBody(request);
    if (!body) return fail(400, "bad request");
    const pay = walletOf(await manifestNowOf(env));
    const chain = pay && CHAINS[pay.network];
    if (!pay || !chain) return fail(409, "publish a payout wallet first");
    const payees = pay.recipients.map((r) => r.address);
    const from = String(body.from || ""), to = String(body.to || "").trim(), micros = Number(body.micros);
    const feePayer = await feeAddress(env.DB);
    const problem = cashOutProblem(from, to, micros, { payees, feePayer });
    if (problem) return fail(400, problem);
    const rpc = rpcAt(chain.rpc);
    const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: noStore({ "Content-Type": "application/json; charset=utf-8" }) });
    if (path === "/send/prepare") {
      if (await feeBalance(rpc, feePayer, { fresh: true }).catch(() => 0) < OFFER_ABOVE_LAMPORTS) {
        return fail(409, "your fees account needs about $5 of SOL first (see Your fees account, under Earnings)");
      }
      try {
        const info = await rpc("getAccountInfo", [to, { encoding: "base64", commitment: "confirmed" }]);
        const owner = info?.value?.owner;
        if (owner === TOKEN_PROGRAM) return fail(400, "that's the address of a token account, not a wallet. Copy the deposit address again from Cash App or Coinbase");
        if (owner && owner !== SYSTEM_PROGRAM) return fail(400, "that address isn't a wallet. Copy the deposit address again from Cash App or Coinbase");
        const { value } = await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
        const tx = await draftCashOut({ feePayer, from, to, micros, mint: chain.mint, blockhash: value.blockhash });
        return json({ tx: base64.encode(tx), feePayer, mint: chain.mint });
      } catch (e) {
        return fail(502, "couldn't reach the network; try again in a moment");
      }
    }
    const result = await settle(env.DB, rpc, body.tx, {
      mint: chain.mint,
      payees: [{ address: to, split: 100 }],
      minMicros: micros,
      maxMicros: micros
    }, { from: payees, kind: "send", openOnce: [] });
    if (!result.ok) return fail(result.status, result.why);
    return json({ signature: result.signature, confirmed: result.confirmed });
  }
  if (request.method === "GET" && path === "/stripe") {
    return new Response(JSON.stringify(await publicView(env.DB)), {
      status: 200,
      headers: noStore({ "Content-Type": "application/json; charset=utf-8" })
    });
  }
  if (request.method === "POST" && path === "/stripe/connect") {
    const body = await jsonBody(request);
    const key = String(body?.key || "").trim() || (await connectionOf(env.DB))?.key || "";
    const plans2 = Array.isArray(body?.plans) ? body.plans : [];
    const valid = plans2.filter((p) => [3, 6, 12].includes(Number(p?.months)) && Number(p?.price) >= 2 && Number(p?.price) <= 1e3);
    if (!key || !valid.length || valid.length !== plans2.length) return fail(400, "a key and at least one valid plan, please");
    const origin = new URL(request.url).origin;
    const text = await manifestText(env);
    let artist = "Your music";
    try {
      artist = text && JSON.parse(text)?.artist?.name || artist;
    } catch {
    }
    try {
      await connect(env.DB, {
        key,
        plans: valid.map((p) => ({ months: Number(p.months), price: Number(p.price) })),
        artist,
        // Stripe fills in {CHECKOUT_SESSION_ID}; the listener's app hands it
        // back here to claim the subscription.
        returnTo: `https://amply.stream/app/?subscribed=${encodeURIComponent(`${origin}/manifest.json`)}&session={CHECKOUT_SESSION_ID}`
      });
      return new Response(JSON.stringify(await publicView(env.DB)), {
        status: 200,
        headers: noStore({ "Content-Type": "application/json; charset=utf-8" })
      });
    } catch (e) {
      return fail(400, e instanceof StripeError ? e.message : "Couldn't reach Stripe.");
    }
  }
  if (request.method === "POST" && path === "/stripe/sales") {
    const body = await jsonBody(request, 64 * 1024);
    const items = Array.isArray(body?.items) ? body.items : null;
    if (!items || items.length > 500) return fail(400, "which songs and albums, at what prices?");
    const clean = items.map((i) => ({ item: String(i?.item || ""), title: String(i?.title || "").slice(0, 200), price: Number(i?.price) }));
    if (clean.some((i) => !/^[a-z0-9-]{1,64}$/.test(i.item) || !i.title || !(i.price >= 0.5 && i.price <= 1e3))) {
      return fail(400, "each needs an id, a title, and a price from $0.50 to $1000");
    }
    const origin = new URL(request.url).origin;
    const text = await manifestText(env);
    let artist = "Your music";
    try {
      artist = text && JSON.parse(text)?.artist?.name || artist;
    } catch {
    }
    try {
      const sales = await setSales(env.DB, {
        key: String(body?.key || ""),
        items: clean,
        artist,
        returnTo: `https://amply.stream/app/?bought=${encodeURIComponent(`${origin}/manifest.json`)}&session={CHECKOUT_SESSION_ID}`
      });
      return new Response(JSON.stringify({ sales: sales.map(({ item, price, url }) => ({ item, price, url })) }), {
        status: 200,
        headers: noStore({ "Content-Type": "application/json; charset=utf-8" })
      });
    } catch (e) {
      return fail(400, e instanceof StripeError ? e.message : "Couldn't reach Stripe.");
    }
  }
  if (request.method === "POST" && path === "/stripe/disconnect") {
    await disconnect(env.DB).catch(() => {
    });
    return new Response(null, { status: 204, headers: noStore() });
  }
  if (request.method === "POST" && path === "/remove") {
    const body = await jsonBody(request);
    const pubkey = String(body?.pubkey || "");
    if (!pubkey) return fail(400, "which wallet?");
    await remove(env.DB, pubkey);
    return new Response(null, { status: 204, headers: noStore() });
  }
  if (request.method === "GET" && path === "/listeners") {
    await pruneStale(env.DB);
    await pruneSubscriptions(env.DB);
    const rows = await listeners(env.DB);
    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: noStore({ "Content-Type": "application/json; charset=utf-8" })
    });
  }
  if (request.method === "POST" && path === "/block") {
    const body = await jsonBody(request);
    const pubkey = String(body?.pubkey || "");
    if (!pubkey) return fail(400, "which wallet?");
    await setBlocked(env.DB, pubkey, Boolean(body?.blocked));
    return new Response(null, { status: 204, headers: noStore() });
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
    const payment = parsed.payment;
    let stored = text;
    if (Array.isArray(payment) && payment.some((p) => p && typeof p === "object" && "paused" in p)) {
      parsed.payment = payment.map((p) => {
        if (!p || typeof p !== "object") return p;
        const { paused: _dropped, ...rest } = p;
        return rest;
      });
      stored = JSON.stringify(parsed, null, 2);
    }
    await putSetting(env.DB, MANIFEST_KEY, stored);
    cachedManifest = null;
    return new Response(null, { status: 204, headers: noStore() });
  }
  const kind = path.match(/^\/(audio|art)\/(.+)$/);
  if (kind) {
    const key = safeKey(kind[1], kind[2]);
    if (key === null) return fail(400, "bad key");
    if (request.method === "PUT") {
      const length = Number(request.headers.get("Content-Length") || 0);
      const limit = maxObject(env);
      if (length > limit) return fail(413, new MediaTooLarge(limit).message);
      try {
        await media(env).put(key, request.body, {
          httpMetadata: { contentType: storedType(kind[1], key) }
        });
      } catch (e) {
        if (e instanceof MediaTooLarge) return fail(413, e.message);
        throw e;
      }
      return new Response(null, { status: 204, headers: noStore() });
    }
    if (request.method === "DELETE") {
      await media(env).delete(key);
      return new Response(null, { status: 204, headers: noStore() });
    }
    if (request.method === "GET" && kind[1] === "audio") {
      const object = await media(env).get(key);
      if (!object || !("body" in object)) return fail(404, "that file is missing");
      return new Response(object.body, { status: 200, headers: noStore({ "Content-Type": storedType("audio", key) }) });
    }
  }
  return fail(404, "not found");
}
var MAX_BODY = 4096;
async function jsonBody(request, max = MAX_BODY) {
  if (Number(request.headers.get("Content-Length") || 0) > max) return null;
  let text;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (text.length > max) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
async function whoIsAsking(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : new URL(request.url).searchParams.get("t");
  if (!token) return null;
  return readToken(env.DB, token);
}
async function manifestNowOf(env) {
  const text = await manifestText(env);
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}
async function feeOffer(env) {
  const pay = walletOf(await manifestNowOf(env));
  const chain = pay && CHAINS[pay.network];
  if (!pay || !chain) return null;
  const feePayer = await feeAddress(env.DB);
  if (pay.recipients.some((r) => r.address === feePayer)) return null;
  if (await feeBalance(rpcAt(chain.rpc), feePayer) < OFFER_ABOVE_LAMPORTS) return null;
  return {
    feePayer,
    network: pay.network,
    minMicros: LISTEN_MIN_MICROS2,
    maxMicros: LISTEN_MAX_MICROS2,
    withdraw: { to: pay.recipients[0].address, fee: WITHDRAW_FEE_MICROS, newAccountFee: NEW_ACCOUNT_FEE_MICROS }
  };
}
async function handleListen(request, env, path) {
  const host = new URL(request.url).host;
  if (path === "/challenge" && request.method === "POST") {
    return new Response(JSON.stringify({ challenge: challenge(host) }), {
      status: 200,
      headers: noStore({ "Content-Type": "application/json; charset=utf-8" })
    });
  }
  if (path === "/token" && request.method === "POST") {
    const body = await jsonBody(request);
    if (!body) return fail(400, "bad request");
    const result = await introduce(env.DB, host, body);
    if (!result.ok) return fail(403, result.why || "refused");
    const address = String(body.address);
    const until = await refresh(env.DB, address).catch(() => subscribedUntil(env.DB, address));
    const subscribed = until !== null && until > Date.now();
    const text = await listenerText(env);
    let manifest = null;
    try {
      manifest = text ? JSON.parse(text) : null;
    } catch {
    }
    if (!subscribed && subscriptionOnly(manifest)) {
      return fail(402, "subscribe to hear this artist's paid tracks");
    }
    return new Response(JSON.stringify({ token: result.token, subscribedUntil: subscribed ? until : null }), {
      status: 200,
      headers: noStore({ "Content-Type": "application/json; charset=utf-8" })
    });
  }
  if (path === "/fees" && request.method === "GET") {
    const offer = await feeOffer(env).catch(() => null);
    return new Response(JSON.stringify(offer ?? { feePayer: null }), {
      status: 200,
      headers: noStore({ "Content-Type": "application/json; charset=utf-8" })
    });
  }
  if (path === "/settle" && request.method === "POST") {
    if (Number(request.headers.get("Content-Length") || 0) > 4096) return fail(413, "too large");
    const body = await jsonBody(request);
    if (!body) return fail(400, "bad request");
    const offer = await feeOffer(env).catch(() => null);
    if (!offer) return fail(409, "this artist's node isn't paying network fees right now");
    const manifest = await manifestNowOf(env);
    const pay = walletOf(manifest);
    let limits = { minMicros: LISTEN_MIN_MICROS2, maxMicros: LISTEN_MAX_MICROS2 };
    if (body.tip === true) {
      limits = { minMicros: TIP_MIN_MICROS, maxMicros: TIP_MAX_MICROS, memo: tipMemo(host) };
    } else if (body.item !== void 0) {
      const item = String(body.item);
      const sale = itemFor(manifest, item);
      if (!sale || !sale.wallet) return fail(404, "that isn't for sale for USDC here");
      const price = Math.round(sale.price * 1e6);
      limits = { minMicros: price, maxMicros: price, memo: purchaseMemo(host, item) };
    }
    const result = await settle(env.DB, rpcAt(CHAINS[pay.network].rpc), body.tx, {
      mint: CHAINS[pay.network].mint,
      payees: pay.recipients,
      ...limits
    }, {
      // Per paying wallet, on top of the per-address count every listener
      // request already has.
      allowed: (who) => allow(env, RULES.wallet, `${host}|settle|${who}`)
    });
    if (!result.ok) return fail(result.status, result.why);
    return new Response(JSON.stringify({ signature: result.signature, confirmed: result.confirmed }), {
      status: 200,
      headers: noStore({ "Content-Type": "application/json; charset=utf-8" })
    });
  }
  if (path === "/withdraw" && request.method === "POST") {
    if (Number(request.headers.get("Content-Length") || 0) > 4096) return fail(413, "too large");
    const body = await jsonBody(request);
    if (!body) return fail(400, "bad request");
    const offer = await feeOffer(env).catch(() => null);
    if (!offer) return fail(409, "this artist's node isn't paying network fees right now");
    const pay = walletOf(await manifestNowOf(env));
    const chain = CHAINS[pay.network];
    const to = String(body.to || "").trim();
    if (!keyOf(to)) return fail(400, "that isn't a Solana address");
    if (to === offer.feePayer || pay.recipients.some((r) => r.address === to)) return fail(400, "that address can't be sent to this way");
    const rpc = rpcAt(chain.rpc);
    let fee = WITHDRAW_FEE_MICROS;
    try {
      const ata = await tokenAccountOf(to, chain.mint, TOKEN_PROGRAM, ATA_PROGRAM);
      const info = await rpc("getAccountInfo", [ata, { encoding: "base64", commitment: "confirmed" }]);
      if (!info?.value) fee += NEW_ACCOUNT_FEE_MICROS;
    } catch {
      return fail(502, "couldn't reach the network; nothing was sent");
    }
    const result = await settle(env.DB, rpc, body.tx, {
      mint: chain.mint,
      payees: [{ address: to }, { address: offer.withdraw.to }],
      minMicros: 1e4,
      maxMicros: 1e10,
      withdrawal: { fee }
    }, {
      allowed: async (who) => !!await listener(env.DB, who) && allow(env, RULES.wallet, `${host}|withdraw|${who}`),
      // The destination's account is paid for by the listener's fee; only the
      // artist's own is opened once at most.
      openOnce: [offer.withdraw.to]
    });
    if (!result.ok) return fail(result.status, result.why);
    return new Response(JSON.stringify({ signature: result.signature, confirmed: result.confirmed }), {
      status: 200,
      headers: noStore({ "Content-Type": "application/json; charset=utf-8" })
    });
  }
  if (path === "/claim" && request.method === "POST") {
    const body = await jsonBody(request);
    if (!body) return fail(400, "bad request");
    const proof = await proveOwnership(host, body);
    if (!proof.ok) return fail(403, proof.why);
    try {
      const outcome = await claim(env.DB, proof.address, String(body.session || ""));
      if (outcome === "refused") return fail(403, "that checkout isn't a subscription for this wallet");
      const until = await subscribedUntil(env.DB, proof.address);
      return new Response(JSON.stringify({ outcome, subscribedUntil: until }), {
        status: 200,
        headers: noStore({ "Content-Type": "application/json; charset=utf-8" })
      });
    } catch (e) {
      return fail(502, e instanceof StripeError ? e.message : "Stripe didn't answer");
    }
  }
  const saleView = (s, wallet) => ({
    ref: s.ref,
    item: s.item,
    via: s.via,
    created: s.created,
    owned: s.owner === wallet,
    // The code only to the one who bought the gift, and only until it's claimed.
    gift: s.buyer === wallet && !s.owner ? s.gift : null
  });
  const json = (value, status = 200) => new Response(JSON.stringify(value), {
    status,
    headers: noStore({ "Content-Type": "application/json; charset=utf-8" })
  });
  const manifestNow = async () => {
    const text = await manifestText(env);
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  };
  if (path === "/buy/claim" && request.method === "POST") {
    const body = await jsonBody(request);
    if (!body) return fail(400, "bad request");
    const proof = await proveOwnership(host, body);
    if (!proof.ok) return fail(403, proof.why);
    try {
      const c = await claimSale(env.DB, proof.address, String(body.session || ""));
      if (c.outcome === "refused") return fail(403, "that checkout isn't a purchase for this wallet");
      if (c.outcome === "pending") return json({ outcome: "pending" });
      const sale = await recordSale(env.DB, { ref: c.ref, item: c.item, buyer: proof.address, gift: body.gift === true, via: "card" });
      return json({ outcome: "recorded", ...saleView(sale, proof.address) });
    } catch (e) {
      return fail(502, e instanceof StripeError ? e.message : "Stripe didn't answer");
    }
  }
  if (path === "/buy/wallet" && request.method === "POST") {
    const body = await jsonBody(request);
    if (!body) return fail(400, "bad request");
    const proof = await proveOwnership(host, body);
    if (!proof.ok) return fail(403, proof.why);
    const r = await claimWalletSale(env.DB, await manifestNow(), {
      wallet: proof.address,
      signature: String(body.tx || ""),
      item: String(body.item || ""),
      gift: body.gift === true,
      host
    });
    if (!r.ok) return json({ outcome: r.retry ? "pending" : "refused", error: r.why }, r.retry ? 200 : 403);
    return json({ outcome: "recorded", ...saleView(r.sale, proof.address) });
  }
  if (path === "/purchases" && request.method === "POST") {
    const body = await jsonBody(request);
    if (!body) return fail(400, "bad request");
    const proof = await proveOwnership(host, body);
    if (!proof.ok) return fail(403, proof.why);
    const { owned, gifts } = await purchasesOf(env.DB, proof.address);
    const used = await downloadsOf(env.DB, owned.map((s) => s.ref));
    return json({
      limit: DOWNLOADS_PER_PURCHASE,
      owned: owned.map((s) => ({ ...saleView(s, proof.address), downloads: used[s.ref] || {} })),
      gifts: gifts.map((s) => saleView(s, proof.address))
    });
  }
  if (path === "/gift" && request.method === "POST") {
    const body = await jsonBody(request);
    if (!body) return fail(400, "bad request");
    const proof = await proveOwnership(host, body);
    if (!proof.ok) return fail(403, proof.why);
    const item = await redeem(env.DB, proof.address, String(body.code || ""));
    if (!item) return fail(404, "that gift has already been claimed, or the link is wrong");
    return json({ item });
  }
  if (path === "/download" && request.method === "POST") {
    const body = await jsonBody(request);
    if (!body) return fail(400, "bad request");
    const proof = await proveOwnership(host, body);
    if (!proof.ok) return fail(403, proof.why);
    const manifest = await manifestNow();
    const trackId = String(body.track || "");
    const track = (manifest?.releases || []).flatMap((r) => r.tracks || []).find((t) => t.id === trackId);
    if (!track) return fail(404, "no such song");
    let key = null;
    try {
      const u = new URL(track.master || track.url);
      if (u.origin === new URL(request.url).origin && u.pathname.startsWith("/audio/")) key = safeKey("audio", u.pathname.slice("/audio/".length));
    } catch {
    }
    if (!key) return fail(409, "this song's file isn't kept on this server");
    const head = await media(env).head(key);
    if (!head) return fail(404, "that file is missing");
    const taken = await takeDownload(env.DB, manifest, proof.address, trackId);
    if (!taken) return fail(403, "you don't own this song here, or its downloads are used up");
    if (/^cs_/.test(taken.ref) && await refundedSale(env.DB, taken.ref) === true) {
      return fail(403, "this purchase was refunded, so it can't be downloaded");
    }
    const object = await media(env).get(key);
    if (!object || !("body" in object)) return fail(404, "that file is missing");
    const ext = key.split(".").pop() || "mp3";
    const name = `${track.title}.${ext}`;
    const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    const h = noStore({
      "Content-Type": storedType("audio", key),
      "Content-Length": String(object.size),
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "X-Downloads-Left": String(taken.left)
    });
    return new Response(object.body, { status: 200, headers: h });
  }
  if (path === "/subscription" && request.method === "POST") {
    const body = await jsonBody(request);
    if (!body) return fail(400, "bad request");
    const proof = await proveOwnership(host, body);
    if (!proof.ok) return fail(403, proof.why);
    const returnTo = String(body.returnTo || "https://amply.stream/app/");
    if (!/^https:\/\/amply\.stream\//.test(returnTo)) return fail(400, "bad return address");
    try {
      const url = await portalFor(env.DB, proof.address, returnTo);
      if (!url) return fail(404, "no subscription to manage here");
      return new Response(JSON.stringify({ url }), {
        status: 200,
        headers: noStore({ "Content-Type": "application/json; charset=utf-8" })
      });
    } catch (e) {
      return fail(502, e instanceof StripeError ? e.message : "Stripe didn't answer");
    }
  }
  if (path === "/played" && request.method === "POST") {
    const who = await whoIsAsking(request, env);
    if (!who) return fail(401, "not introduced");
    if (!await allow(env, RULES.wallet, `${host}|${who}`)) return new Response(null, { status: 204, headers: noStore() });
    if (!await listener(env.DB, who) && !await allow(env, RULES.newListener, host)) {
      return new Response(null, { status: 204, headers: noStore() });
    }
    if (!await takingPayments(env)) return new Response(null, { status: 204, headers: noStore() });
    const body = await jsonBody(request);
    const until = await subscribedUntil(env.DB, who).catch(() => null);
    const subscribed = until !== null && until > Date.now();
    let perMinute2 = 0;
    try {
      const wallet = (JSON.parse(await manifestText(env) || "{}")?.payment || []).find((p) => p?.type === "solana-usdc");
      perMinute2 = subscribed ? 0 : Math.max(0, Number(wallet?.ratePerMinute) || 0);
    } catch {
    }
    await counted(env.DB, who, Number(body?.seconds) || 0, Date.now(), perMinute2);
    if (Math.random() < 0.02) await pruneStale(env.DB);
    return new Response(null, { status: 204, headers: noStore() });
  }
  if (path === "/heard" && request.method === "POST") {
    const body = await jsonBody(request);
    const track = String(body?.track || "");
    const seconds = Number(body?.seconds) || 0;
    const manifest = await manifestNowOf(env);
    const known = (manifest?.releases || []).some((r) => (r.tracks || []).some((t) => t.id === track));
    if (known && seconds >= 30) await heard(env.DB, track, seconds).catch(() => {
    });
    return new Response(null, { status: 204, headers: noStore() });
  }
  if (path === "/forget" && request.method === "POST") {
    const body = await jsonBody(request);
    if (!body) return fail(400, "bad request");
    const proof = await proveOwnership(host, body);
    if (!proof.ok) return fail(403, proof.why);
    await forget(env.DB, proof.address);
    return new Response(null, { status: 204, headers: noStore() });
  }
  if (path === "/mine" && request.method === "POST") {
    const body = await jsonBody(request);
    if (!body) return fail(400, "bad request");
    const proof = await proveOwnership(host, body);
    if (!proof.ok) return fail(403, proof.why);
    const row = await listener(env.DB, proof.address);
    return new Response(JSON.stringify({
      controller: host,
      wallet: proof.address,
      held: row ? {
        plays: row.plays,
        seconds: row.seconds,
        costMicros: await env.DB.prepare("SELECT micros FROM owed WHERE pubkey = ?").bind(proof.address).first().then((o) => o?.micros ?? null).catch(() => null),
        firstSeen: row.first_seen ? new Date(row.first_seen).toISOString() : null,
        lastSeen: row.last_seen ? new Date(row.last_seen).toISOString() : null,
        servingStopped: !!row.blocked
      } : null,
      subscribedUntil: await subscribedUntil(env.DB, proof.address).then((u) => u ? new Date(u).toISOString() : null),
      purchases: await purchasesOf(env.DB, proof.address).then(({ owned, gifts }) => [...owned, ...gifts].map((s) => ({ item: s.item, paidWith: s.via, when: new Date(s.created).toISOString(), gift: !s.owner }))).catch(() => []),
      notHeld: "Which tracks you played, and when. This server never records that.",
      keptFor: "A year after you were last here, then deleted automatically.",
      exported: (/* @__PURE__ */ new Date()).toISOString()
    }, null, 2), {
      status: 200,
      headers: noStore({ "Content-Type": "application/json; charset=utf-8" })
    });
  }
  return null;
}
var index_default = {
  async fetch(request, env) {
    try {
      return await serve(request, env);
    } catch (e) {
      const said = quotaFailure(e);
      if (said) return fail(said.status, said.message);
      throw e;
    }
  }
};
async function serve(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: withCors() });
  }
  const { pathname, host } = new URL(request.url);
  const rule = ruleFor(request.method, pathname);
  if (rule) {
    const from = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!await allow(env, rule, `${host}|${from}`)) return tooMany(withCors(new Headers()));
  }
  if (pathname === "/manage" || pathname.startsWith("/manage/")) {
    return handleManage(request, env, pathname.slice("/manage".length));
  }
  if (pathname === "/stripe/webhook" && request.method === "POST") {
    if (Number(request.headers.get("Content-Length") || 0) > 256 * 1024) return fail(413, "too large");
    const raw = await request.text();
    const outcome = await handleEvent(env.DB, raw, request.headers.get("Stripe-Signature"));
    if (outcome === "refused") return fail(400, "not a valid notice from Stripe");
    return new Response(JSON.stringify({ received: true, outcome }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
  if (pathname === "/listen" || pathname.startsWith("/listen/")) {
    const answered = await handleListen(request, env, pathname.slice("/listen".length));
    if (answered) return answered;
    return fail(404, "not found");
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    const h = withCors(new Headers({ Allow: "GET, HEAD, OPTIONS" }));
    return new Response(null, { status: 405, headers: h });
  }
  if (pathname === "/") {
    if (arriving(request) && !(await accessConfig(env)).set && await previewSession(request, readPreviewKey(await setting(env.DB, PREVIEW_KEY)))) {
      return new Response(null, { status: 302, headers: noStore({ Location: "/manage" }) });
    }
    const body = await listenerText(env);
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
    const q = new URL(request.url).searchParams;
    const kind = q.has("song") ? "song" : q.has("album") ? "album" : null;
    const id = kind ? String(q.get(kind) || "") : "";
    const focus = kind && /^[a-z0-9-]{1,64}$/.test(id) ? { kind, id } : null;
    let site = null;
    try {
      const t = await siteText(env);
      site = t ? JSON.parse(t) : null;
    } catch {
    }
    if (site?.on === false) site = null;
    return new Response(renderPage(manifest, new URL(request.url).origin, nonce, focus, site), {
      status: 200,
      headers
    });
  }
  if (pathname === "/manifest.json") return serveManifest(env);
  if (pathname === "/privacy") {
    const body = await manifestText(env);
    let manifest = {};
    try {
      if (body) manifest = JSON.parse(body);
    } catch {
    }
    const nonce = crypto.randomUUID().replace(/-/g, "");
    const headers = withCors(new Headers({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": pageCsp(nonce)
    }));
    if (request.method === "HEAD") return new Response(null, { status: 200, headers });
    return new Response(renderPrivacy(manifest, new URL(request.url).origin, nonce), {
      status: 200,
      headers
    });
  }
  if (pathname === "/page.webmanifest") {
    let manifest = null;
    try {
      const t = await manifestText(env);
      manifest = t ? JSON.parse(t) : null;
    } catch {
    }
    return new Response(pageWebManifest(manifest || {}), {
      status: 200,
      headers: withCors(new Headers({ "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=3600" }))
    });
  }
  if (pathname === MANIFEST_PATH) {
    return new Response(studioManifest(), {
      status: 200,
      headers: withCors(new Headers({ "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=86400" }))
    });
  }
  if (pathname === FAVICON_PATH) {
    return new Response(FAVICON, {
      status: 200,
      headers: withCors(new Headers({ "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=604800" }))
    });
  }
  if (ICONS[pathname]) {
    return new Response(ICONS[pathname], {
      status: 200,
      headers: withCors(new Headers({ "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" }))
    });
  }
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
    const manifest = await listenerText(env);
    let guarded = /* @__PURE__ */ new Set();
    let masters = /* @__PURE__ */ new Set();
    try {
      if (manifest) {
        const m = JSON.parse(manifest);
        guarded = guardedKeys(m);
        masters = masterKeys(m);
      }
    } catch {
      return fail(503, "this music is temporarily unavailable");
    }
    if (masters.has(key.slice("audio/".length))) {
      return fail(403, "this file is only available as a download, to someone who bought it");
    }
    if (guarded.has(key.slice("audio/".length))) {
      const who = await whoIsAsking(request, env);
      if (!who) {
        return fail(401, "this track is for listeners who have said who they are");
      }
    }
    return serveObject(env, request, key, CACHE_AUDIO, "audio/mpeg");
  }
  if (pathname.startsWith("/art/")) {
    const key = safeKey("art", pathname.slice("/art/".length));
    if (key === null) return fail(400, "bad key");
    return serveObject(env, request, key, CACHE_ART, "image/jpeg");
  }
  return fail(404, "not found");
}
export {
  index_default as default
};
