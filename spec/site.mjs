/**
 * An artist's website: the sections on their page, beyond the music.
 *
 * Shared by the artist's server, which renders it for visitors, and the
 * editor, which renders the very same markup as the canvas the artist clicks
 * on. One renderer, so what they edit is what visitors see.
 *
 * Everything here is artist-supplied. Text is escaped and never treated as
 * HTML; links are https only; pictures are https only. cleanSite() is the
 * one gate: the server runs it on every save, and the renderer only ever
 * sees what it returns.
 */

export const SITE_VERSION = 1;

export const SECTION_TYPES = {
  music: { label: "Music", hint: "Your releases, with play buttons." },
  about: { label: "About", hint: "A picture and a few paragraphs about you." },
  news: { label: "News", hint: "Short posts: a new song, a tour, a thank-you." },
  shows: { label: "Shows", hint: "Dates, places and ticket links." },
  merch: { label: "Merch", hint: "Things you sell elsewhere, with a link to buy." },
  links: { label: "Links", hint: "Your other places: Instagram, Bandcamp, a newsletter." },
};

export const THEMES = {
  light: { label: "Light", bg: "#ffffff", bg2: "#f7f4f1", ink: "#131110", ink2: "#4a4644", mut: "#66615d", line: "#e3ddd8" },
  dark: { label: "Dark", bg: "#121110", bg2: "#1d1b19", ink: "#f7f3ef", ink2: "#d4ccc4", mut: "#a39a92", line: "#34302c" },
  paper: { label: "Paper", bg: "#f4eee3", bg2: "#ebe3d4", ink: "#231d16", ink2: "#4b4134", mut: "#76695a", line: "#d8ccb8" },
};
export const FONTS = {
  sans: { label: "Clean", css: '"Archivo",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Helvetica,sans-serif' },
  serif: { label: "Classic", css: 'ui-serif,Georgia,"Times New Roman",serif' },
  mono: { label: "Typewriter", css: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace' },
};

const MAX = { short: 120, text: 4000, url: 500, sections: 16, items: 40, label: 60, price: 20 };

// ── cleaning ────────────────────────────────────────────────────────────────

const str = (v, n) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").slice(0, n) : "");
const line = (v, n) => str(v, n).replace(/\s+/g, " ").trim();
export function httpsUrl(v) {
  try {
    const u = new URL(String(v || "").trim());
    return u.protocol === "https:" && u.href.length <= MAX.url ? u.href : "";
  } catch { return ""; }
}
const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "");
const colour = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v || "")) ? String(v).toLowerCase() : d);
const idOf = (v, i) => (/^[a-z0-9-]{1,40}$/.test(String(v || "")) ? String(v) : `s${i}`);

/** Make anything into a valid site, dropping what doesn't fit. */
export function cleanSite(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const look = r.look || {};
  const hero = r.hero || {};
  const seen = new Set();
  const sections = (Array.isArray(r.sections) ? r.sections : []).slice(0, MAX.sections).map((s, i) => {
    if (!s || !SECTION_TYPES[s.type]) return null;
    let id = idOf(s.id, i);
    while (seen.has(id)) id = `${id}-${i}`;
    seen.add(id);
    const out = { id, type: s.type, title: line(s.title, MAX.short) || SECTION_TYPES[s.type].label };
    if (s.hidden === true) out.hidden = true;
    const items = (Array.isArray(s.items) ? s.items : []).slice(0, MAX.items);
    if (s.type === "about") { out.text = str(s.text, MAX.text); out.image = httpsUrl(s.image); }
    if (s.type === "news") {
      out.items = items.map((p, k) => ({ id: idOf(p?.id, k), title: line(p?.title, MAX.short), date: date(p?.date),
        text: str(p?.text, MAX.text), image: httpsUrl(p?.image) }));
    }
    if (s.type === "shows") {
      out.items = items.map((p, k) => ({ id: idOf(p?.id, k), date: date(p?.date), city: line(p?.city, MAX.short),
        venue: line(p?.venue, MAX.short), url: httpsUrl(p?.url) }));
    }
    if (s.type === "merch") {
      out.items = items.map((p, k) => ({ id: idOf(p?.id, k), name: line(p?.name, MAX.short), price: line(p?.price, MAX.price),
        image: httpsUrl(p?.image), url: httpsUrl(p?.url) }));
    }
    if (s.type === "links") {
      out.items = items.map((p, k) => ({ id: idOf(p?.id, k), label: line(p?.label, MAX.label), url: httpsUrl(p?.url) }));
    }
    return out;
  }).filter(Boolean);
  return {
    v: SITE_VERSION,
    look: {
      theme: THEMES[look.theme] ? look.theme : "light",
      font: FONTS[look.font] ? look.font : "sans",
      accent: colour(look.accent, "#f6711e"),
    },
    hero: { title: line(hero.title, MAX.short), tagline: str(hero.tagline, 300), image: httpsUrl(hero.image) },
    sections,
  };
}

/** A first website from what the artist already has. */
export function starterSite(manifest) {
  const a = manifest?.artist || {};
  return cleanSite({
    hero: { title: a.name || "", tagline: "", image: a.banner || "" },
    sections: [
      { id: "music", type: "music", title: "Music" },
      { id: "about", type: "about", title: "About", text: a.bio || "", image: a.image || "" },
      { id: "shows", type: "shows", title: "Shows", items: [] },
      { id: "links", type: "links", title: "Links", items: (a.links || []).map((l, i) => ({ id: `l${i}`, label: l.label, url: l.url })) },
    ],
  });
}

/** A new, empty section of a type, with a starter item where it helps. */
export function newSection(type, taken = []) {
  let n = 1;
  while (taken.includes(`${type}-${n}`)) n++;
  const base = { id: `${type}-${n}`, type, title: SECTION_TYPES[type].label };
  if (type === "news") return { ...base, items: [newItem("news")] };
  if (type === "shows") return { ...base, items: [newItem("shows")] };
  if (type === "merch") return { ...base, items: [newItem("merch")] };
  if (type === "links") return { ...base, items: [newItem("links")] };
  if (type === "about") return { ...base, text: "", image: "" };
  return base;
}

export function newItem(type) {
  const id = `i${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  if (type === "news") return { id, title: "A new post", date: new Date().toISOString().slice(0, 10), text: "", image: "" };
  if (type === "shows") return { id, date: "", city: "City", venue: "Venue", url: "" };
  if (type === "merch") return { id, name: "T-shirt", price: "$25", image: "", url: "" };
  return { id, label: "Instagram", url: "" };
}

// ── rendering ───────────────────────────────────────────────────────────────

export function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const paras = (t) => esc(t).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
const niceDate = (d) => {
  if (!d) return "";
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};

/**
 * The site as HTML: `css` for a <style>, and `body`. In edit mode every
 * editable thing carries data-edit (its path in the site) and data-kind, and
 * every section data-section, so the editor can make them clickable. Empty
 * fields show a placeholder only while editing.
 */
export function renderSite(input, manifest, { edit = false, slots = {}, listenUrl = "" } = {}) {
  const site = cleanSite(input);
  const t = THEMES[site.look.theme];
  const font = FONTS[site.look.font].css;
  const e = (path, kind) => (edit ? ` data-edit="${esc(path)}" data-kind="${kind}"` : "");
  const ph = (value, placeholder) => (value ? esc(value) : edit ? `<span class="ph">${esc(placeholder)}</span>` : "");
  const img = (src, path, cls, placeholder) => (src
    ? `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy"${e(path, "image")}>`
    : edit ? `<div class="${cls} ph-img"${e(path, "image")}>${esc(placeholder)}</div>` : "");
  const name = site.hero.title || manifest?.artist?.name || "";
  const shown = site.sections.filter((s) => edit || !s.hidden);

  const nav = shown.filter((s) => !s.hidden).map((s) => `<a href="#${esc(s.id)}">${esc(s.title)}</a>`).join("");

  const heroImg = site.hero.image;
  const hero = `<header class="s-hero${heroImg ? " has-img" : ""}" data-section="hero">
  ${heroImg ? `<img class="s-hero-img" src="${esc(heroImg)}" alt=""${e("hero.image", "image")}>` : edit ? `<div class="s-hero-img ph-img"${e("hero.image", "image")}>Add a banner picture</div>` : ""}
  <div class="s-hero-in">
    <h1${e("hero.title", "text")}>${ph(name, "Your name")}</h1>
    ${site.hero.tagline || edit ? `<p class="s-tag"${e("hero.tagline", "long")}>${ph(site.hero.tagline, "A line about you")}</p>` : ""}
    ${listenUrl ? `<a class="s-btn" href="${esc(listenUrl)}">Listen in Amply</a>` : edit ? `<span class="s-btn">Listen in Amply</span>` : ""}
  </div>
</header>`;

  const sections = shown.map((s, i) => {
    const p = `sections.${i}`;
    const head = `<h2${e(`${p}.title`, "text")}>${esc(s.title)}</h2>`;
    let inner = "";
    if (s.type === "music") {
      inner = slots.music || `<p class="muted">Your releases appear here.</p>`;
    } else if (s.type === "about") {
      inner = `<div class="s-about">${img(s.image, `${p}.image`, "s-about-img", "Add a picture")}
        <div class="s-text"${e(`${p}.text`, "long")}>${s.text ? paras(s.text) : edit ? `<p class="ph">Write a few lines about you</p>` : ""}</div></div>`;
    } else if (s.type === "news") {
      inner = `<div class="s-news">${(s.items || []).map((n, k) => `<article class="s-post" data-item="${p}.items.${k}">
        ${img(n.image, `${p}.items.${k}.image`, "s-post-img", "Add a picture")}
        <p class="s-date"${e(`${p}.items.${k}.date`, "date")}>${ph(niceDate(n.date), "Date")}</p>
        <h3${e(`${p}.items.${k}.title`, "text")}>${ph(n.title, "Title")}</h3>
        <div class="s-text"${e(`${p}.items.${k}.text`, "long")}>${n.text ? paras(n.text) : edit ? `<p class="ph">Write the post</p>` : ""}</div>
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
        ${img(x.image, `${p}.items.${k}.image`, "s-card-img", "Add a picture")}
        <b${e(`${p}.items.${k}.name`, "text")}>${ph(x.name, "Name")}</b>
        <span class="muted"${e(`${p}.items.${k}.price`, "text")}>${ph(x.price, "Price")}</span>
        ${x.url ? `<a class="s-btn sm" href="${esc(x.url)}" rel="noopener"${e(`${p}.items.${k}.url`, "url")}>Buy</a>` : edit ? `<span class="s-btn sm ghost"${e(`${p}.items.${k}.url`, "url")}>Add shop link</span>` : ""}
      </div>`).join("")}</div>`;
    } else if (s.type === "links") {
      const items = (s.items || []).filter((x) => edit || x.url);
      inner = `<div class="s-links">${items.map((x, k) => edit
        ? `<span class="s-link" data-item="${p}.items.${k}"><span${e(`${p}.items.${k}.label`, "text")}>${ph(x.label, "Label")}</span> <span class="s-url"${e(`${p}.items.${k}.url`, "url")}>${x.url ? "↗" : "add link"}</span></span>`
        : `<a class="s-link" href="${esc(x.url)}" rel="noopener">${esc(x.label || x.url)} ↗</a>`).join("")}</div>`;
    }
    return `<section class="s-sec s-${s.type}${s.hidden ? " is-hidden" : ""}" id="${esc(s.id)}" data-section="${i}">${head}${inner}</section>`;
  }).join("\n");

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
.s-hero-in{position:relative;z-index:1;width:100%;max-width:960px;margin:0 auto;padding:clamp(28px,5vw,56px) clamp(20px,4vw,48px)}
.s-hero.has-img .s-hero-in{color:#fff}
.s-hero h1{font-size:clamp(44px,9vw,104px);line-height:.92;letter-spacing:-.045em;margin:0;font-weight:800}
.s-tag{font-size:clamp(17px,2vw,21px);margin:16px 0 0;max-width:34em;opacity:.9}
.s-btn{display:inline-block;margin-top:24px;background:var(--ac);color:#131110 !important;text-decoration:none;font-weight:700;
 padding:13px 24px;border-radius:999px;font-size:16px}
.s-btn.sm{margin:0;padding:8px 16px;font-size:14px}
.s-btn.ghost{background:transparent;border:1.5px dashed var(--line);color:var(--mut) !important}
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
