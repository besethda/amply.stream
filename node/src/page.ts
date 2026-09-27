/**
 * The page a listener sees.
 *
 * An artist's address is the only way anyone finds them: there is no Amply
 * directory, no search, no algorithm. So this URL has to be a real page, not a
 * 404 or a blob of JSON. It is what gets pasted into a bio, a post, a message.
 *
 * Rendered from the manifest on each request rather than stored, so it can
 * never disagree with what the artist published, and there is nothing extra to
 * upload or keep in sync.
 */

import { charges, needsWallet, plans as subscriptionPlans, forSale, DOWNLOADS_PER_PURCHASE } from "../../spec/pricing.mjs";

interface Track {
  id: string; title: string; duration: number; url: string; explicit?: boolean;
  free?: boolean; needsWallet?: boolean;
}
interface Release { id: string; title: string; date?: string; art?: string; tracks?: Track[] }
interface Manifest {
  artist?: {
    name?: string; bio?: string; image?: string; banner?: string; contact?: string;
    links?: { label: string; url: string }[];
  };
  licence?: { type?: string; url?: string; notice?: string };
  payment?: ({ type: string; ratePerMinute?: number; label?: string; url?: string })[];
  releases?: Release[];
}

/** Manifest fields are artist-supplied: every one is escaped before it renders. */
function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Only ever emit https URLs, whatever the manifest claims. */
function safeUrl(u: unknown): string | null {
  try {
    const parsed = new URL(String(u));
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

export function pageCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}' https://fonts.googleapis.com`,
    "font-src https://fonts.gstatic.com",
    "img-src https: data:",
    "media-src https:",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** A song or an album the page was linked to: `/?song=<id>` or `/?album=<id>`. */
export interface Focus { kind: "song" | "album"; id: string }

/** The app's link for this artist, or for one of their songs or albums in it. */
export function appLink(origin: string, focus?: Focus | null): string {
  const m = encodeURIComponent(`${origin}/manifest.json`);
  return focus ? `https://amply.stream/app/?${focus.kind}=${m}&id=${encodeURIComponent(focus.id)}` : `https://amply.stream/app/?add=${m}`;
}

export function renderPage(manifest: Manifest, origin: string, nonce: string, focus: Focus | null = null): string {
  const name = esc(manifest.artist?.name || "Untitled");
  const bio = manifest.artist?.bio ? `<p class="bio">${esc(manifest.artist.bio)}</p>` : "";
  const avatar = safeUrl(manifest.artist?.image);
  // The picture a shared link shows: wide ones make the big card in Messages,
  // WhatsApp and the rest, so the banner first, then the newest release's
  // cover, then the artist's photo.
  const newest = (manifest.releases || []).filter((r) => safeUrl(r.art))
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))[0];
  const preview = safeUrl(manifest.artist?.banner) || safeUrl(newest?.art) || avatar;
  const wide = !!safeUrl(manifest.artist?.banner);
  const about = (manifest.artist?.bio || `Listen to ${manifest.artist?.name || "this artist"}'s music`).slice(0, 200);

  // Linked to one song or album: the card a message shows is that one — its
  // title, its cover — and the page's button opens it in the app.
  let focused: { title: string; art: string | null; kind: "song" | "album"; id: string; release: string } | null = null;
  if (focus) {
    for (const r of manifest.releases || []) {
      if (focus.kind === "album" && r.id === focus.id) focused = { title: r.title, art: safeUrl(r.art), kind: "album", id: r.id, release: r.id };
      const t = focus.kind === "song" ? (r.tracks || []).find((x) => x.id === focus.id) : null;
      if (t) focused = { title: t.title, art: safeUrl(r.art), kind: "song", id: t.id, release: r.id };
    }
  }
  const artistName = manifest.artist?.name || "this artist";
  const cardTitle = focused ? esc(`${focused.title} — ${artistName}`) : name;
  const cardAbout = focused ? `${focused.kind === "song" ? "A song" : "An album"} by ${artistName}. Listen in the Amply app.` : about;
  const cardImage = focused ? (focused.art || preview) : preview;
  const cardUrl = focused ? `${origin}/?${focused.kind}=${encodeURIComponent(focused.id)}` : `${origin}/`;
  const cardType = focused ? (focused.kind === "song" ? "music.song" : "music.album") : "music.musician";
  const cardWide = focused ? !!cardImage : wide;

  const links = (manifest.artist?.links || [])
    .map((l) => { const u = safeUrl(l.url); return u ? `<a href="${esc(u)}" rel="noopener">${esc(l.label)}</a>` : ""; })
    .join("");

  const wallet = (manifest.payment || []).find((p) => p.type === "solana-usdc");

  // An artist who charges is paid for their music, including here: playing
  // paid tracks in the browser would make the artist's own link the easiest
  // way not to pay them. Paid tracks send the listener to the app, which pays
  // as it plays; the tracks the artist made free play right here.
  const paid = charges(manifest);
  const inApp = appLink(origin, focused ? { kind: focused.kind, id: focused.id } : null);
  const support = (manifest.payment || [])
    .filter((p) => p.type === "link")
    .map((p) => { const u = safeUrl(p.url); return u ? `<a class="btn" href="${esc(u)}" rel="noopener">${esc(p.label)}</a>` : ""; })
    .join("");

  const lic = manifest.licence;
  const licUrl = lic?.type === "amply-personal-1"
    ? "https://amply.stream/licence/personal-1"
    : safeUrl(lic?.url);
  const licence = lic?.type
    ? `<p class="lic">${lic.notice ? esc(lic.notice) + " " : ""}` +
      `${paid ? "" : "Listen freely. "}${licUrl
        ? `<a href="${esc(licUrl)}" rel="noopener">These recordings may not be redistributed</a>`
        : "These recordings may not be redistributed"} ` +
      `or included in another service without ${name}'s permission.</p>`
    : "";

  const releases = (manifest.releases || []).map((r) => {
    const art = safeUrl(r.art);
    const tracks = (r.tracks || []).map((t) => {
      const u = safeUrl(t.url);
      if (!u) return "";
      const title = `${esc(t.title)}${t.explicit ? ' <em class="e">explicit</em>' : ""}`;
      if (needsWallet(manifest, t)) {
        return `<li class="t${focused?.id === t.id ? " focus" : ""}" id="song-${esc(t.id)}">
        <a class="play paid" href="${esc(appLink(origin, { kind: "song", id: t.id }))}" aria-label="Listen to ${esc(t.title)} in the Amply app">▶</a>
        <span class="tt">${title}</span>
        <span class="d">${mmss(t.duration)}</span>
      </li>`;
      }
      return `<li class="t${focused?.id === t.id ? " focus" : ""}" id="song-${esc(t.id)}">
        <button class="play" data-src="${esc(u)}" aria-label="Play ${esc(t.title)}">▶</button>
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

  const empty = !(manifest.releases || []).some((r) => (r.tracks || []).length)
    ? `<p class="muted">No music published yet.</p>` : "";

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
  <p>${name}'s music is paid for as you listen — <strong>$${esc(wallet?.ratePerMinute)}</strong> a
  minute, straight to them, with nothing taken in between. Listen in the Amply app.</p>
  <a class="btn" href="${esc(inApp)}">Open in the Amply app</a>
</div>` : ""}
${releases}
${empty}
<div class="pay">
  <h3>Support ${name}</h3>
  ${wallet?.ratePerMinute
    ? `<p>Listening in an Amply player pays ${name} <strong>$${esc(wallet.ratePerMinute)}</strong> a
       minute, directly. Nobody in between takes a cut.</p>`
    : `<p>Payments go straight to the artist. Nothing is taken in between.</p>`}
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
</script>
</body></html>`;
}

/**
 * The artist's privacy notice, generated from what they published.
 *
 * An artist who charges holds a record of every wallet that plays their paid
 * music, which makes them that record's controller under GDPR, and a
 * controller has to tell people what they hold, why, for how long, and how to
 * get it back or get rid of it (Article 13). Almost no musician will write
 * that, and the ones who try will describe a system they cannot see into. So
 * the notice is written by the software that does the processing, from the
 * facts it actually operates on, and can never drift from them.
 *
 * It is plain on purpose. Every sentence is about this artist's server; none
 * is about Amply, which holds nothing.
 */
export function renderPrivacy(manifest: Manifest, origin: string, nonce: string): string {
  const name = esc(manifest.artist?.name || "This artist");
  const paid = charges(manifest);
  const subs = subscriptionPlans(manifest).length > 0;
  const selling = forSale(manifest).length > 0;
  const card = forSale(manifest).some((s) => s.card);
  // Buying a song or an album leaves a record whether or not the listening is
  // charged for: what was bought, by which wallet, and its downloads.
  const bought = selling ? `<p><strong>If you buy</strong> a song or an album, this server keeps a record of the
purchase: your wallet address, what you bought, the payment's reference (a Stripe checkout or a
Solana transaction), when, and how many times you have downloaded each song (up to
${DOWNLOADS_PER_PURCHASE}). A gift is recorded against the wallet that claims it. This is kept for as
long as you own what you bought, because it is what lets you download it again; asking to be
forgotten doesn't remove it, and ${name} may also need it for their accounts.${card ? ` Paying by card, Stripe
holds your name, email and card in ${name}'s own Stripe account, under Stripe's privacy policy.` : ""}</p>` : "";
  const contact = manifest.artist?.contact || "";
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(contact);
  const contactLine = !contact
    ? `<p class="warn">${name} has not added a contact address yet. Until they do, you can
       still see and erase your record yourself, from the Amply app, as described below.</p>`
    : isEmail
      ? `<p>Contact them about your data at <a href="mailto:${esc(contact)}">${esc(contact)}</a>.</p>`
      : `<p>Contact them about your data here: <a href="${esc(safeUrl(contact) || "")}" rel="noopener">${esc(contact)}</a>.</p>`;

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
long as it stands — with every other figure removed.</p>

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
subscription and for you as a customer, and the date it runs to — enough to serve what you paid
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
<title>Privacy — ${name}</title>
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
