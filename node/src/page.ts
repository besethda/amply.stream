/**
 * The page a listener sees.
 *
 * An artist's node URL is the only way anyone finds them — there is no Amply
 * directory, no search, no algorithm. So this URL has to be a real page, not a
 * 404 or a blob of JSON. It is what gets pasted into a bio, a post, a message.
 *
 * Rendered from the manifest on each request rather than stored, so it can
 * never disagree with what the artist published, and there is nothing extra to
 * upload or keep in sync.
 */

interface Track { id: string; title: string; duration: number; url: string; explicit?: boolean }
interface Release { id: string; title: string; date?: string; art?: string; tracks?: Track[] }
interface Manifest {
  artist?: { name?: string; bio?: string; image?: string; links?: { label: string; url: string }[] };
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
    `style-src 'nonce-${nonce}'`,
    "img-src https: data:",
    "media-src https:",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function renderPage(manifest: Manifest, origin: string, nonce: string): string {
  const name = esc(manifest.artist?.name || "Untitled");
  const bio = manifest.artist?.bio ? `<p class="bio">${esc(manifest.artist.bio)}</p>` : "";
  const avatar = safeUrl(manifest.artist?.image);

  const links = (manifest.artist?.links || [])
    .map((l) => { const u = safeUrl(l.url); return u ? `<a href="${esc(u)}" rel="noopener">${esc(l.label)}</a>` : ""; })
    .join("");

  const wallet = (manifest.payment || []).find((p) => p.type === "solana-usdc");
  const support = (manifest.payment || [])
    .filter((p) => p.type === "link")
    .map((p) => { const u = safeUrl(p.url); return u ? `<a class="btn" href="${esc(u)}" rel="noopener">${esc(p.label)}</a>` : ""; })
    .join("");

  const releases = (manifest.releases || []).map((r) => {
    const art = safeUrl(r.art);
    const tracks = (r.tracks || []).map((t) => {
      const u = safeUrl(t.url);
      if (!u) return "";
      return `<li class="t">
        <button class="play" data-src="${esc(u)}" aria-label="Play ${esc(t.title)}">▶</button>
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

  const empty = !(manifest.releases || []).some((r) => (r.tracks || []).length)
    ? `<p class="muted">No music published yet.</p>` : "";

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
  ${wallet?.ratePerMinute
    ? `<p>Listening in an Amply player pays ${name} <strong>$${esc(wallet.ratePerMinute)}</strong> a
       minute, directly. No platform takes a cut.</p>`
    : `<p>Payments go straight to the artist. Nothing is taken in between.</p>`}
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
</script>
</body></html>`;
}
