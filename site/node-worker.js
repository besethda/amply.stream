var __toBinary = Uint8Array.fromBase64 || /* @__PURE__ */ (() => {
  var table = new Uint8Array(128);
  for (var i = 0; i < 64; i++) table[i < 26 ? i + 65 : i < 52 ? i + 71 : i < 62 ? i - 4 : i * 4 - 205] = i;
  return (base64) => {
    var n = base64.length, bytes = new Uint8Array((n - (base64[n - 1] == "=") - (base64[n - 2] == "=")) * 3 / 4 | 0);
    for (var i2 = 0, j = 0; i2 < n; ) {
      var c0 = table[base64.charCodeAt(i2++)], c1 = table[base64.charCodeAt(i2++)];
      var c2 = table[base64.charCodeAt(i2++)], c3 = table[base64.charCodeAt(i2++)];
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
  if (payload.iss && payload.iss !== `https://${config.team}`) return null;
  if (!payload.exp || payload.exp * 1e3 <= Date.now()) return null;
  return payload.email || "authenticated";
}

// ../spec/pricing.mjs
function perMinute(manifest) {
  return (manifest?.payment || []).some(
    (p) => p && p.type === "solana-usdc" && Number(p.ratePerMinute) > 0
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
  return plans(manifest).length > 0 && !perMinute(manifest);
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
  if (!w) return null;
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
    `style-src 'nonce-${nonce}' https://fonts.googleapis.com`,
    "font-src https://fonts.gstatic.com",
    "img-src https: data:",
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
function renderPage(manifest, origin, nonce, focus = null) {
  const name = esc(manifest.artist?.name || "Untitled");
  const bio = manifest.artist?.bio ? `<p class="bio">${esc(manifest.artist.bio)}</p>` : "";
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
  const cardTitle = focused ? esc(`${focused.title} \u2014 ${artistName}`) : name;
  const cardAbout = focused ? `${focused.kind === "song" ? "A song" : "An album"} by ${artistName}. Listen in the Amply app.` : about;
  const cardImage = focused ? focused.art || preview : preview;
  const cardUrl = focused ? `${origin}/?${focused.kind}=${encodeURIComponent(focused.id)}` : `${origin}/`;
  const cardType = focused ? focused.kind === "song" ? "music.song" : "music.album" : "music.musician";
  const cardWide = focused ? !!cardImage : wide;
  const links = (manifest.artist?.links || []).map((l) => {
    const u = safeUrl(l.url);
    return u ? `<a href="${esc(u)}" rel="noopener">${esc(l.label)}</a>` : "";
  }).join("");
  const wallet = (manifest.payment || []).find((p) => p.type === "solana-usdc");
  const paid = charges(manifest);
  const inApp = appLink(origin, focused ? { kind: focused.kind, id: focused.id } : null);
  const support = (manifest.payment || []).filter((p) => p.type === "link").map((p) => {
    const u = safeUrl(p.url);
    return u ? `<a class="btn" href="${esc(u)}" rel="noopener">${esc(p.label)}</a>` : "";
  }).join("");
  const lic = manifest.licence;
  const licUrl = lic?.type === "amply-personal-1" ? "https://amply.stream/licence/personal-1" : safeUrl(lic?.url);
  const licence = lic?.type ? `<p class="lic">${lic.notice ? esc(lic.notice) + " " : ""}${paid ? "" : "Listen freely. "}${licUrl ? `<a href="${esc(licUrl)}" rel="noopener">These recordings may not be redistributed</a>` : "These recordings may not be redistributed"} or included in another service without ${name}'s permission.</p>` : "";
  const releases = (manifest.releases || []).map((r) => {
    const art = safeUrl(r.art);
    const tracks = (r.tracks || []).map((t) => {
      const u = safeUrl(t.url);
      if (!u) return "";
      const title = `${esc(t.title)}${t.explicit ? ' <em class="e">explicit</em>' : ""}`;
      if (needsWallet(manifest, t)) {
        return `<li class="t${focused?.id === t.id ? " focus" : ""}" id="song-${esc(t.id)}">
        <a class="play paid" href="${esc(appLink(origin, { kind: "song", id: t.id }))}" aria-label="Listen to ${esc(t.title)} in the Amply app">\u25B6</a>
        <span class="tt">${title}</span>
        <span class="d">${mmss(t.duration)}</span>
      </li>`;
      }
      return `<li class="t${focused?.id === t.id ? " focus" : ""}" id="song-${esc(t.id)}">
        <button class="play" data-src="${esc(u)}" aria-label="Play ${esc(t.title)}">\u25B6</button>
        <span class="tt">${title}${paid ? ' <em class="free">free</em>' : ""}</span>
        <span class="d">${mmss(t.duration)}</span>
      </li>`;
    }).join("");
    return `<section class="r${focused?.release === r.id ? " focus" : ""}" id="album-${esc(r.id)}">
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
<title>${cardTitle}</title>
<meta name="description" content="${esc(cardAbout.slice(0, 160))}">
<meta property="og:title" content="${cardTitle}">
<meta property="og:description" content="${esc(cardAbout)}">
<meta property="og:type" content="${cardType}">
<meta property="og:url" content="${esc(cardUrl)}">
<meta name="twitter:card" content="${cardWide ? "summary_large_image" : "summary"}">
<meta name="twitter:title" content="${cardTitle}">
<meta name="twitter:description" content="${esc(cardAbout)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;700;800&display=swap">
${cardImage ? `<meta property="og:image" content="${esc(cardImage)}">
<meta property="og:image:alt" content="${cardTitle}">
<meta name="twitter:image" content="${esc(cardImage)}">` : ""}
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
</style>
</head><body><div class="w">
<header>
  ${avatar ? `<img class="av" src="${esc(avatar)}" alt="">` : ""}
  <div><h1>${name}</h1></div>
</header>
${focused ? `<div class="linked">
  ${focused.art ? `<img src="${esc(focused.art)}" alt="">` : ""}
  <div><h2>${esc(focused.title)}</h2><p>${focused.kind === "song" ? "A song" : "An album"} by ${name}</p>
  <a class="btn" href="${esc(inApp)}">Open in the Amply app</a></div>
</div>` : ""}
${bio}
${links ? `<div class="links">${links}</div>` : ""}
${paid ? `<div class="listen">
  <p>${name}'s music is paid for as you listen \u2014 <strong>$${esc(wallet?.ratePerMinute)}</strong> a
  minute, straight to them, with nothing taken in between. Listen in the Amply app.</p>
  <a class="btn" href="${esc(inApp)}">Open in the Amply app</a>
</div>` : ""}
${releases}
${empty}
<div class="pay">
  <h3>Support ${name}</h3>
  ${wallet?.ratePerMinute ? `<p>Listening in an Amply player pays ${name} <strong>$${esc(wallet.ratePerMinute)}</strong> a
       minute, directly. Nobody in between takes a cut.</p>` : `<p>Payments go straight to the artist. Nothing is taken in between.</p>`}
  ${support}
</div>
<footer>
  <p>Follow in an Amply player by adding this address:<br><code>${esc(origin)}/manifest.json</code></p>
  <p>This page is hosted by the artist, on infrastructure they own. <a href="/privacy">Privacy</a></p>
  ${licence}
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
function renderPrivacy(manifest, origin, nonce) {
  const name = esc(manifest.artist?.name || "This artist");
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
       still see and erase your record yourself, from the Amply app, as described below.</p>` : isEmail ? `<p>Contact them about your data at <a href="mailto:${esc(contact)}">${esc(contact)}</a>.</p>` : `<p>Contact them about your data here: <a href="${esc(safeUrl(contact) || "")}" rel="noopener">${esc(contact)}</a>.</p>`;
  const body = paid ? `
<h2>What is kept about you, and why</h2>
<p>${name} charges for their music, and pays for it to be served. To be paid, and to be able
to stop serving someone who listens without paying, their server keeps one record per
wallet that plays their paid tracks:</p>
<ul>
  <li>your wallet address;</li>
  <li>how many tracks you have played, and for how many minutes in total;</li>
  <li>when you first and last listened;</li>
  <li>whether ${name} has stopped serving that wallet.</li>
</ul>
<p><strong>What is not kept:</strong> which tracks you played, or when you played any one of
them. This server does not record that at all. Nothing is kept for tracks ${name} has made
free, which anyone can play without a wallet.</p>
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
<p class="lead">${name}'s streaming service, at ${esc(new URL(origin).host)}. ${name} is responsible
for what it keeps.</p>
${body}
<footer><a href="/">Back to ${name}</a></footer>
</div></body></html>`;
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
async function counted(db, pubkey, seconds, now = Date.now()) {
  const clean = Math.max(0, Math.min(Math.round(seconds), 3600));
  await db.prepare(
    `INSERT INTO listeners (pubkey, plays, seconds, first_seen, last_seen) VALUES (?, 1, ?, ?, ?)
     ON CONFLICT(pubkey) DO UPDATE SET
       plays = plays + 1,
       seconds = seconds + excluded.seconds,
       last_seen = excluded.last_seen`
  ).bind(pubkey, clean, now, now).run();
}
async function listeners(db, limit = 500) {
  const { results } = await db.prepare(
    `SELECT l.*, s.until AS subscribed_until
       FROM listeners l LEFT JOIN subscriptions s ON s.wallet = l.pubkey
      ORDER BY l.seconds DESC LIMIT ?`
  ).bind(Math.min(limit, 1e3)).all();
  return results ?? [];
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
}
var KEEP_FOR = 365 * 864e5;
async function pruneStale(db, now = Date.now()) {
  await db.prepare("DELETE FROM listeners WHERE blocked = 0 AND last_seen < ?").bind(now - KEEP_FOR).run();
}
async function remove(db, pubkey) {
  await db.prepare("DELETE FROM listeners WHERE pubkey = ?").bind(pubkey).run();
  await db.prepare("DELETE FROM subscriptions WHERE wallet = ?").bind(pubkey).run();
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
  const load = fetchSubscription ?? ((id) => call(connection.key, "GET", `/subscriptions/${id}`));
  if (event.type === "checkout.session.completed") {
    if (obj.mode !== "subscription" || !obj.subscription) return "ignored";
    const wallet = String(obj.client_reference_id || "");
    const key = fromBase58(wallet);
    if (!key || key.length !== 32) return "ignored";
    const sub = await load(String(obj.subscription));
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
async function connect(db, { key, plans: plans2, origin, artist, returnTo }) {
  if (!/^(sk|rk)_(live|test)_[A-Za-z0-9]+$/.test(key)) {
    throw new StripeError(/^pk_/.test(key) ? "That's Stripe's publishable key. Amply needs the secret key shown with it, which starts rk_." : "That doesn't look like a Stripe secret key. Copy the one that starts rk_.");
  }
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
  if (!/^(sk|rk)_(live|test)_[A-Za-z0-9]+$/.test(useKey)) throw new StripeError("That doesn't look like a Stripe secret key. Copy the one that starts rk_.");
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
  for (const h of had) {
    if (!next.some((n) => n.linkId === h.linkId)) await call(useKey, "POST", `/payment_links/${h.linkId}`, { active: false }).catch(() => {
    });
  }
  await putSetting(db, STRIPE_KEY, JSON.stringify({ ...c, sales: next }));
  return next;
}
async function claimSale(db, wallet, sessionId, { loadSession } = {}) {
  const c = await connectionOf(db);
  const links = c?.sales || [];
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
  if (pathname === "/stripe/webhook") return null;
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

// ../site/app/icon-180.png
var icon_180_default = __toBinary("iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAIAAACyr5FlAAAFf0lEQVR42u3dwbGqMBiGYSqxDduwDZaWoB24dkMJLizABpyhA3du3akIeu8iMxwGVFCTP3/C+w3LM3qCT0ISY5L8I+RFEm4BAQcBBwEHAQcBBwEHAQcBBwEHAQch4CDgIOAg4CDgIOAg4CDgIOAg4CAEHAQcBBwEHAQcBBxx5XE6Fll6nk9um+XjdAQH+ct1NTvPJ+a6bZbgIH+pZZznk8tiCg7yHMd5PgGHxlT59n7Yx4SjyrdVvpXvx0SF437YXxZT89kUWRoBjsfpWJfospgK+4gKR7NLeJ5PqnwbOo7bZtl8TWHxUeFofTwR4DBjY1/9XHCEhEO4nwsOcIADHOAYiONxOt42yyJLy91aEoeZYr+uZkWWDhl6gMMDjnp8aHGqu/dTbI5LBw5NwSGNo8q3Lu5472uWu3Xrb3rbLXCMBUf3k+6dtwAHOMABDnCAAxzgAAc4wAGOp9MS5W592ywHrg4Bx1hwtCashszEg2MsOL74rhwcI8Ux5FMBBzg04nC0bBYcYeNo9o2uq5ndRabgCBtHa5Gp3R9TgSNsHK0/sLsCGRzgAAc4wAEOcIADHOAABzjAAQ5wgAMc4AAHOMABDnCAAxzgAAc4wAEOcIADHOAABzjAAQ5wgAMc4AAHOMABDnCAAxzgAAc4wAEOcASEw8r+HN1Nanv3hAGHRhz3w/7TPfa9bG8NDg84mpvn29oTrPmaA8+eBYdSHD++u5XXBAc4wKEGx+N0bP7ZdTULBUf3sweHZRym8TB9Q4tbJbnA0dsvBod9HALvbutl74d9kaWv+sXgGDWOH5874FCBozmHIXY6MDjCwFEPgiTPFQdHGDhqIpJvB46QcAgHHOAABzjAAQ5wgAMc4AAHOMABDnCAQ0Huh32Vb7vXR7Or4IgHhzmO9Lqatf7V7lVkablbf7rIFBxB4hhoontdV7M3i1jHguNxOrYa2DhwlLt18wvb767LYjq69RxVvi2y9H2VMmu1hywB14bjcTp+11q8uRWtB02EOMzqpi9qz/sV/apwdJcxW7kui2mzXFHhuB/2v1emV0T04Ggd2mj9qosWCQ7zex6LFajcrXXi+KJR/K6GRILjftj/3inrfQZrwCEjoy5g8DgcPX27a/K843Ba0lfFDxiHwP2qffjF0fqNiZcrJBxiNcn40LP6HBy62tjuZyOJw/XwJCoc3Xosf4nh0FDYkHDYnRlUjkNJsxEGju7+RnHjUCIjDBwaumZiOJTUhDBw6LlZMjg0PECDwaGk2RDDoUeGdhzyU4R+cagqr3Yckt8saMChqsOhHYeqOyWAQ1VlUI1Dw5cL4FCKQ9sDWACHqqGKahzaqpEADlXlBYcuHHrG7eCgzwEOcIADHNav7qJrcDBD6qTI4Ihqasdu6Wzi0LPmxVwDD9GJZsBi6/iHUUyCyaz00VMl7HY4LOPQs5TSRTXS/2Sxvqd2Emsba34tKBMNpXZRGZJY21iZDoeeL+5dlDeJso0dcgxsTI2Ho2eo/WWCGr6otN41U14rHJ3gkUR2m7w0G36nedz1rpz8NMFv4yHfbHh8uDgdlCWRtbG+mo16MC/pw/WRUK5+Dulr2CI5SPE7EyhwWJjDX9nLP1wk5zb8+pA5Ri6Jpo0VO5DRe9nFDhhMwr1HamXUZXcxfpEsaRJ0HVIro/mIsVX81g6kMeBw7UOzjOb8+i934Om+mpHgcDd+CetElS/2xr+uZh7LKLqDscXdSLu7gIcSs/9/kaWveiRmr3cN7pPg2tj3R0yQsHHUrchHnfneXfFJPDiaSsrd+unBGqbt/fRkKxIPDgIOAg4CDgIOAg5CwEHAQcBBwEHAQcBBwEHAQcBBwEEIOAg4CDgIOAg4CDgIOAg4CDgIOAgBB3mb/0fItpzfM6h3AAAAAElFTkSuQmCC");

// ../site/app/icon-192.png
var icon_192_default = __toBinary("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");

// ../site/app/icon-512.png
var icon_512_default = __toBinary("iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAASpElEQVR42u3du5HqyAKA4RPJSYM0SAPzhIAywMYhBBkEQAJUkQEeLt4BxGPW0K25W7M8pBnUanV/X7W7uzWz3fql1mN+fQCQpV9+BQACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAIAAACAAAAgAAAIAgAAAIABAaLf9riqL42z898/vv39+nxaT82ru14IAQOIum2V93P8yDtPRbb/z+0EAIK+jvwYgAJCy23735Ohfj+Ns7BeFAEBqqrJ4GYC/f35ft2u/KwQAknKYjpoEoCoLvysEAJLS5OhfPxTkd4UAgACAAIAAgACAAIAAgAAgAIAAIACAAETrtt9dNkuTQQCI1Hk1Py0m9UPrp8WkKguvJgnAD12369Ni8uW7Fz6BJwBE5LJZPnpZydtJAvBtXw79XzLg9EIAiOLo//zAdJiO/JYE4I1Hf1+/EABiuUK3PS0Ab3dezZv8yM4tBIA+ff5xEidrAhD+R/7757f7AQJAP5p8pthFgAC09XJT0XewBYCBLVRX6wLQUJPd/38PM0QA6EHD79RbqAIgAAJAaixUATCvBAABsFAFwLwSAATAQhUA80oAEAALVQDMKwFAACxUATCvBAABQADMKwHAQkUAzCsBwEJFAMwrAcBCRQDMKwHAQkUAzCsBwEIVgKABuGyWn+O235lXAgBxLdTzav7le9SnxSS9706HDMBtv7v7v/U4Gwf7xQqAACAAL45Tj/4IZXp/hzJYAF5+3jXML1YABAAB+ObRP9u/jvLDH7nhx70D/GIFQAAQgIca/hmyy2YpAA01/NOeYX6xAiAACMBPD1XJ/AmaAAFo/qc9A/xiBUAAEIA3/EfTuCHcdQBanf4HuAgQAAFAAO57ufuf3l8M7zoArf60Z4A7AQIgAAjAj46GKd0K7vqHbfv/UQAEAARAAARAABAAARAAARAABEAABEAABAABEAABEAABQAAEQAAEQAAQAAEQAAEQAARAAARAAAQAARAAARAAAUAABEAABEAAEAABEAABEAAEQAAEQAAEAAEQAAEQAAFAAARAAARAABAAARAABAABEAABQAAQAAEQAAQAARAAAUAAEAABEAABAAF44bbfVWVxnI0//53H2TjwnxoWAAEQAAQgdADOq/mjf/NhOrpu1wIgAAKAACQYgCY/3WWzFAABEAAEIKkAPDn3/zJu+50ACIAAIACJBOC23zX/TxxnYwEQAAFAABIJQPPT/3p0fTNAAARAABCAQAFo+3N1/VCQAAiAACAAgQIQ1dFQAARAABAAARAAARAABEAABEAABAABEAABsBIFAAEQAAFAABAAARCAZs6r+WkxOUxH9SsdVVkE+8KHACAAAiAA/cyry2ZZH/fv/nQBXvAWAARAAASgh3l12Syf/zsP01HaDRAABEAAcgzAdbuO5CMfAoAACIAABJ1Xj3Z+wr/jLQAIgAAIQLh51fD0P/mLAAFAAAQguwBUZeEZUwFAAAQgxwB4yUAAEAABEAABAAEQAAEQABAAARAAAQABEAABEAAQAAEQAAEAARAAARAAEAABEAABQAAEQAAEQAAQAAEQAAEQAARAAARAAAQAARAAARAAAUAABEAABEAAEAABEAABEAAEQAAEQAAEAAEQAAEQAAFAAARAAARAABAAARAAARAABEAABEAABAABEAABEAABQAAEQAAEQAAQAAEQAAEQAARAAARAAAQAARAAARAAAUAABEAABEAAEAABEAABAAEQAAEQABAAARAAAQABEAABEAAQAAEQAAEAARAAARAABEAABEAABAABEAABEAABQAAEQAAEQAAQAAEQAAEQAARAAARAAAQAARAAARAAAUAABEAABEAAEAABEAABEAAEQAAEQAAEAAEQAAEQAAFAAARAAARAABAAARAAARAABEAABEAABAABEAABEAABQAAEQAAEQAAQAAEQAAEQAARAAARAAAQAARAAARAAEAABEAABAAEQAAEQABAAARAAAQABEAABEAAQAAEQAAEAARAAARAABEAABEAABAABEAABEAABQAAEQAAEQAAQAAEQAAEQAARAAARAAAQAARAAARAAAUAABEAABEAAEAABEAABEAAEQAAEQAAEAAEQAAEQAAFAAARAAARAABAAARAA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");

// src/studio.ts
var ICONS = {
  "/studio/icon-180.png": icon_180_default,
  "/studio/icon-192.png": icon_192_default,
  "/studio/icon-512.png": icon_512_default
};
var MANIFEST_PATH = "/studio.webmanifest";
var studioManifest = () => JSON.stringify({
  name: "Amply \u2014 your music",
  short_name: "Your music",
  description: "Publish your music, set your prices, see who listens.",
  start_url: "/manage",
  scope: "/manage",
  display: "standalone",
  background_color: "#ffffff",
  theme_color: "#ffffff",
  icons: [
    { src: "/studio/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/studio/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/studio/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
  ]
});

// src/constants.ts
var VERSION = "3.18.4";
var SPEC_VERSION = 1;
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

// src/index.ts
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
var cachedManifest = null;
async function manifestText(env) {
  const now = Date.now();
  if (cachedManifest && now - cachedManifest.at < MANIFEST_CACHE) return cachedManifest.body;
  const body = await setting(env.DB, MANIFEST_KEY);
  cachedManifest = { at: now, body };
  return body;
}
async function serveManifest(env) {
  const body = await manifestText(env);
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
  const raw = await setting(env.DB, ACCESS_KEY);
  if (!raw) return null;
  try {
    const c = JSON.parse(raw);
    return c && c.team && c.aud ? c : null;
  } catch {
    return null;
  }
}
function noStore(extra) {
  const h = withCors(new Headers(extra));
  h.set("Cache-Control", "no-store");
  return h;
}
async function handleManage(request, env, path) {
  const config = await accessConfig(env);
  if (!config) {
    return fail(
      503,
      "This streaming service has no sign-in set up, so the editor cannot be opened. Go to https://amply.stream/repair and rebuild it with your email address \u2014 your music and settings are untouched."
    );
  }
  const email = await verifyAccess(request, config);
  if (!email) {
    if (!new URL(request.url).host.endsWith(".workers.dev")) {
      return fail(401, "Your editor isn't on this address. Open it at your .workers.dev address, the one from setup.");
    }
    return fail(401, "not signed in");
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    const origin = request.headers.get("Origin");
    const site = request.headers.get("Sec-Fetch-Site");
    const here = new URL(request.url).origin;
    const sameOrigin = origin ? origin === here : site === "same-origin" || site === null;
    if (!sameOrigin) return fail(403, "that request did not come from your editor");
  }
  if (request.method === "GET" && (path === "" || path === "/")) {
    const obj = await env.MEDIA.get(`${MANAGE_PREFIX}/index.html`);
    if (obj === null) return fail(404, "editor not installed on this node");
    const h = noStore({ "Content-Type": "text/html; charset=utf-8" });
    h.set("Content-Security-Policy", MANAGE_CSP);
    return new Response(obj.body, { status: 200, headers: h });
  }
  if (request.method === "GET" && path === "/whoami") {
    const home = await setting(env.DB, "home");
    return new Response(JSON.stringify({ email, version: VERSION, home }), {
      status: 200,
      headers: noStore({ "Content-Type": "application/json; charset=utf-8" })
    });
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
        origin,
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
    await putSetting(env.DB, MANIFEST_KEY, text);
    cachedManifest = null;
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
    const text = await manifestText(env);
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
      const u = new URL(track.url);
      if (u.origin === new URL(request.url).origin && u.pathname.startsWith("/audio/")) key = safeKey("audio", u.pathname.slice("/audio/".length));
    } catch {
    }
    if (!key) return fail(409, "this song's file isn't kept on this server");
    const head = await env.MEDIA.head(key);
    if (!head) return fail(404, "that file is missing");
    const taken = await takeDownload(env.DB, manifest, proof.address, trackId);
    if (!taken) return fail(403, "you don't own this song here, or its downloads are used up");
    const object = await env.MEDIA.get(key);
    if (!object) return fail(404, "that file is missing");
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
    const body = await jsonBody(request);
    await counted(env.DB, who, Number(body?.seconds) || 0);
    if (Math.random() < 0.02) await pruneStale(env.DB);
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
      const body = await manifestText(env);
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
      return new Response(renderPage(manifest, new URL(request.url).origin, nonce, focus), {
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
    if (pathname === MANIFEST_PATH) {
      return new Response(studioManifest(), {
        status: 200,
        headers: withCors(new Headers({ "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=86400" }))
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
      const manifest = await manifestText(env);
      let guarded = /* @__PURE__ */ new Set();
      try {
        if (manifest) guarded = guardedKeys(JSON.parse(manifest));
      } catch {
        return fail(503, "this music is temporarily unavailable");
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
};
export {
  index_default as default
};
