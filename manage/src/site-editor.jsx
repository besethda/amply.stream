/**
 * The visual website editor.
 *
 * The page is shown exactly as visitors will see it (the same renderer, from
 * spec/site.mjs, run in edit mode) inside a shadow root, so the site's styles
 * and the editor's never touch. Click a thing on it to change it; the side
 * panel holds the controls that don't fit inline: pictures, links, dates,
 * sections, look.
 *
 * Nothing here ever builds HTML out of the artist's words. The canvas markup
 * comes only from renderSite (which escapes everything), and text typed
 * straight onto the page is read back with innerText.
 */
import { useState, useEffect, useRef, useMemo } from "preact/hooks";
import { SECTION_TYPES, THEMES, FONTS, starterSite, newSection, newItem, renderSite, httpsUrl } from "../../spec/site.mjs";
import { COVER_PX, BANNER_PX } from "./images.js";

// ── paths: "sections.2.items.0.url" ─────────────────────────────────────────

const keys = (p) => String(p).split(".").map((k) => (/^\d+$/.test(k) ? Number(k) : k));

/** Read a value at a path, or undefined. */
export function getAt(obj, path) {
  return keys(path).reduce((v, k) => (v == null ? undefined : v[k]), obj);
}

/** A copy of obj with the value at path replaced. Never changes obj. */
export function setAt(obj, path, value) {
  const ks = keys(path);
  const go = (node, i) => {
    if (i === ks.length) return value;
    const k = ks[i];
    const base = node ?? (typeof k === "number" ? [] : {});
    const copy = Array.isArray(base) ? base.slice() : { ...base };
    copy[k] = go(base[k], i + 1);
    return copy;
  };
  return go(obj, 0);
}

const moved = (arr, i, d) => {
  const j = i + d;
  if (j < 0 || j >= arr.length) return arr;
  const out = arr.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
};

// What each field is, from its name alone.
const KIND = { title: "text", name: "text", price: "text", city: "text", venue: "text", label: "text",
  tagline: "long", text: "long", image: "image", url: "url", date: "date" };
const kindOf = (path) => KIND[String(path).split(".").pop()] || "text";
const LABEL = { title: "Title", name: "Name", price: "Price", city: "City", venue: "Venue", label: "Name of the link",
  tagline: "Tagline", text: "Text", image: "Picture", url: "Link", date: "Date" };
const labelOf = (path) => (path === "hero.title" ? "Your name" : path === "hero.image" ? "Banner picture"
  : LABEL[String(path).split(".").pop()] || "Text");

const LISTS = ["news", "shows", "merch", "links"];
const FIRST = { news: "title", shows: "city", merch: "name", links: "label" };
const itemName = (type, it) => (type === "news" ? it.title : type === "shows" ? [it.city, it.venue].filter(Boolean).join(" · ")
  : type === "merch" ? it.name : it.label) || "Untitled";

const ACCENTS = ["#f6711e", "#e5484d", "#d6409f", "#7c5cfc", "#2f7de1", "#12a594", "#30a46c", "#131110"];

// ── icons ───────────────────────────────────────────────────────────────────

const Eye = ({ off }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />
    {off && <path d="M3 3l18 18" />}
  </svg>
);

// ── the canvas ──────────────────────────────────────────────────────────────

// What sits on top of the site's own styles, inside the shadow root.
const EDIT_CSS = `
[data-edit], section[data-section], header[data-section] { cursor: pointer; }
[data-edit]:hover { outline: 1px solid rgba(246,113,30,.4); outline-offset: 1px; }
section[data-section]:hover, header[data-section]:hover { outline: 1px solid rgba(246,113,30,.4); outline-offset: -1px; }
.x-sel, .x-sel:hover { outline: 2px solid #f6711e !important; outline-offset: 0 !important; box-shadow: 0 0 0 4px #fff; }
section.x-sel, header.x-sel, section.x-sel:hover, header.x-sel:hover { outline-offset: -2px !important; box-shadow: inset 0 0 0 4px #fff; }
[contenteditable] { cursor: text; outline-offset: 0; min-width: 2ch; }
[contenteditable]:focus { outline: 2px solid #f6711e; }
.x-gap { position: relative; height: 0; z-index: 3; }
.x-gap::before { content: ""; position: absolute; left: 0; right: 0; top: -12px; height: 24px; }
.x-gap button { position: absolute; left: 50%; top: 0; transform: translate(-50%, -50%); opacity: 0; transition: opacity .12s;
  font: 600 14px/1 system-ui, sans-serif; padding: 9px 16px; border-radius: 999px; border: 2px solid #fff; cursor: pointer;
  background: #f6711e; color: #131110; box-shadow: 0 2px 10px rgba(0,0,0,.25); }
.x-gap:hover button, .x-gap button:focus-visible { opacity: 1; }
@media (hover: none) { .x-gap button { opacity: .85; } }
.s-site a { cursor: pointer; }
.s-hero-img.x-sel { outline-offset: -2px !important; box-shadow: inset 0 0 0 4px #fff; }
.s-hero-img.ph-img { place-items: start center; padding-top: 14px; }
.s-hero-in { pointer-events: none; }
.s-hero-in > * { pointer-events: auto; }
`;
// The site's own @media rules answer to the browser window, not to the phone
// frame, so the frame gets the small-screen layout spelled out.
const PHONE_CSS = `
.s-about { grid-template-columns: 1fr !important; }
.s-shows li { grid-template-columns: 1fr auto !important; }
.s-shows .s-date { grid-column: 1 / -1; }
`;

function Canvas({ doc, phone, cb, hostRef }) {
  const cbr = useRef(cb);
  cbr.current = cb;
  const st = useRef({ typing: null, last: "", dirty: false, timer: 0 });
  const docRef = useRef(doc);
  docRef.current = doc;

  const mark = () => {
    const root = hostRef.current?.shadowRoot;
    if (!root) return;
    root.querySelectorAll(".x-sel").forEach((n) => n.classList.remove("x-sel"));
    const sel = cbr.current.sel;
    if (!sel) return;
    const q = sel[0] === "@" ? (sel === "@hero" ? 'header[data-section="hero"]' : `section[data-section="${sel.slice(1)}"]`)
      : `[data-edit="${CSS.escape(sel)}"]`;
    const el = root.querySelector(q);
    if (!el) return;
    el.classList.add("x-sel");
    if (sel[0] !== "@" && /^(text|long)$/.test(el.dataset.kind || "")) makeEditable(el);
  };

  const paint = (force) => {
    const host = hostRef.current;
    const root = host?.shadowRoot;
    const s = st.current;
    if (!root || s.typing) return;
    const d = docRef.current;
    const key = (phone ? "p" : "d") + d.css + d.body;
    if (force || key !== s.last) {
      s.last = key;
      const style = document.createElement("style");
      style.textContent = d.css + EDIT_CSS + (phone ? PHONE_CSS : "");
      // The renderer's own output: every word in it is already escaped.
      const tpl = document.createElement("template");
      tpl.innerHTML = d.body;
      const site = tpl.content.querySelector(".s-site");
      if (site) {
        const secs = [...site.querySelectorAll(":scope > section[data-section]")];
        const gap = (i) => {
          const g = document.createElement("div");
          g.className = "x-gap";
          const b = document.createElement("button");
          b.type = "button";
          b.dataset.add = String(i);
          b.textContent = "+ Add a section";
          b.setAttribute("aria-label", "Add a section here");
          g.append(b);
          return g;
        };
        secs.forEach((n) => n.before(gap(Number(n.dataset.section))));
        const last = secs[secs.length - 1] || site.querySelector(":scope > header");
        if (last) last.after(gap(secs.length));
      }
      root.replaceChildren(style, ...tpl.content.childNodes);
    }
    mark();
  };

  // Set up once: the shadow root and its listeners.
  useEffect(() => {
    const host = hostRef.current;
    const root = host.attachShadow({ mode: "open" });
    const s = st.current;
    const fieldOf = (e) => (e.target instanceof Element ? e.target.closest("[data-edit]") : null);

    root.addEventListener("click", (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      e.preventDefault(); // nothing on the canvas is a real link
      const c = cbr.current;
      if (t.classList.contains("x-gap")) return;
      const add = t.closest("[data-add]");
      if (add) { c.add(Number(add.dataset.add)); return; }
      const f = t.closest("[data-edit]");
      if (f) {
        const p = f.dataset.edit;
        const typed = f.dataset.kind === "text" || f.dataset.kind === "long";
        if (c.sel === p) { if (!typed) c.select(null); return; } // typed: let the caret move
        c.select(p);
        if (typed) { makeEditable(f); f.focus(); }
        return;
      }
      const sec = t.closest("[data-section]");
      if (sec) { const k = "@" + sec.dataset.section; c.select(c.sel === k ? null : k); return; }
      c.select(null);
    });

    root.addEventListener("focusin", (e) => {
      const f = fieldOf(e);
      if (!f || !f.isContentEditable) return;
      s.typing = f;
      const v = getAt(cbr.current.site, f.dataset.edit) || "";
      const long = f.dataset.kind === "long";
      // Typing happens on plain text, so what you see is what is saved.
      if (long || !v) {
        f.textContent = v;
        if (long) f.style.whiteSpace = "pre-wrap";
        const r = document.createRange();
        r.selectNodeContents(f);
        r.collapse(false);
        const g = window.getSelection();
        g.removeAllRanges();
        g.addRange(r);
      }
    });

    root.addEventListener("focusout", (e) => {
      const f = fieldOf(e);
      if (!f || s.typing !== f) return;
      s.typing = null;
      // Put the page back as the renderer draws it, but not under a click that
      // is still on its way.
      clearTimeout(s.timer);
      s.timer = setTimeout(() => { if (!s.typing) paint(true); }, 400);
    });

    root.addEventListener("input", (e) => {
      const f = fieldOf(e);
      if (!f || !f.isContentEditable) return;
      let v = f.innerText.replace(/\r/g, "");
      if (f.dataset.kind === "text") v = v.replace(/\s*\n+\s*/g, " ");
      if (v.replace(/\n/g, "") === "") v = "";
      cbr.current.text(f.dataset.edit, v);
    });

    root.addEventListener("keydown", (e) => {
      const f = fieldOf(e);
      if (e.key === "Enter" && f && f.dataset.kind === "text") { e.preventDefault(); f.blur(); }
    });

    paint(true);
    return () => clearTimeout(s.timer);
  }, []);

  useEffect(() => { paint(); });

  return <div class="se-host" ref={hostRef} />;
}

// Text is typed straight onto the page. Plain text only, where the browser allows.
function makeEditable(el) {
  if (el.isContentEditable) return;
  el.contentEditable = "plaintext-only";
  if (el.contentEditable !== "plaintext-only") el.contentEditable = "true";
}

// ── small controls ──────────────────────────────────────────────────────────

function Pic({ value, onSet, art, px }) {
  const [busy, setBusy] = useState(false);
  const file = useRef(null);
  function pick(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    setBusy(true);
    Promise.resolve(art(f, (url) => onSet(url), px)).finally(() => setBusy(false));
  }
  return (
    <div class="se-pic">
      {value ? <img src={value} alt="" /> : <div class="se-pic-empty">No picture yet</div>}
      <div class="se-row">
        <button type="button" class="se-btn" disabled={busy} onClick={() => file.current && file.current.click()}>
          {busy ? "Uploading…" : "Upload a picture"}
        </button>
        {value && <button type="button" class="se-btn ghost" onClick={() => onSet("")}>Remove</button>}
      </div>
      <input type="file" accept="image/*" hidden ref={file} onChange={pick} aria-label="Choose a picture" />
    </div>
  );
}

function Url({ value, onInput }) {
  const bad = value && !httpsUrl(value);
  return (
    <label class="se-f">
      <span>Link</span>
      <input type="url" inputmode="url" placeholder="https://" value={value || ""} onInput={(e) => onInput(e.currentTarget.value)} />
      <small class={bad ? "se-warn" : ""}>
        {bad ? "This needs to start with https:// or it won't show on your page." : "Must start with https://"}
      </small>
    </label>
  );
}

function Field({ path, label, value, kind, onInput, art }) {
  if (kind === "image") return <Pic value={value} onSet={onInput} art={art} px={path === "hero.image" ? BANNER_PX : COVER_PX} />;
  if (kind === "url") return <Url value={value} onInput={onInput} />;
  if (kind === "date") {
    return (
      <label class="se-f"><span>{label}</span>
        <input type="date" value={value || ""} onInput={(e) => onInput(e.currentTarget.value)} /></label>
    );
  }
  if (kind === "long") {
    return (
      <label class="se-f"><span>{label}</span>
        <textarea rows="6" value={value || ""} onInput={(e) => onInput(e.currentTarget.value)} />
        <small>A blank line starts a new paragraph.</small></label>
    );
  }
  return (
    <label class="se-f"><span>{label}</span>
      <input type="text" value={value || ""} onInput={(e) => onInput(e.currentTarget.value.replace(/\s*\n+\s*/g, " "))} /></label>
  );
}

// ── the editor ──────────────────────────────────────────────────────────────

/**
 * Where the website is, and whether it's showing: one bar above the editor.
 * On or off, the address to open or copy, and a way to put it on the
 * artist's own domain. Changes here go live on Publish, like everything else.
 */
function SiteBar({ site, setSite, nodeUrl }) {
  const on = site.on !== false;
  const address = String(nodeUrl || "").replace(/^https:\/\//, "").replace(/\/$/, "");
  // The domain page needs the workers.dev address (the service's own name).
  const workers = typeof location !== "undefined" && /\.workers\.dev$/.test(location.host) ? location.host
    : /\.workers\.dev$/.test(address) ? address : "";
  const own = !/\.workers\.dev$/.test(address);
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard?.writeText(`https://${address}`).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {});
  return (
    <div class={`se-top${on ? "" : " off"}`}>
      <label class="se-switch">
        <input type="checkbox" checked={on} onChange={() => setSite({ ...site, on: !on })} />
        <span class="se-knob" aria-hidden="true" />
        <span>{on ? "Website on" : "Website off"}</span>
      </label>
      <span class="se-addr">
        <a href={`https://${address}`} target="_blank" rel="noopener">{address} ↗</a>
        <button type="button" class="se-copy" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
      </span>
      {!own && workers && (
        <a class="se-domain" href={`https://amply.stream/domain?addr=${encodeURIComponent(workers)}`} target="_blank" rel="noopener">
          Use your own domain ↗</a>
      )}
      {!on && <span class="se-offnote">Visitors see your music page. Publish to apply.</span>}
    </div>
  );
}

export function SiteEditor({ site, setSite, manifest, nodeUrl, art, notify }) {
  const [sel, setSel] = useState(null);
  const [view, setView] = useState("desktop");
  const [adding, setAdding] = useState(null); // index to insert at, or null
  const [sheet, setSheet] = useState(false); // phones: is the side panel open
  const [preview, setPreview] = useState(false); // seeing it as visitors do
  // Undo: earlier versions of the draft. Typing in one place within a moment
  // counts as one step, so undo takes back a word, not a letter.
  const history = useRef([]);
  const lastPush = useRef({ at: 0, path: null });
  const hostRef = useRef(null);
  const sideRef = useRef(null);
  const siteRef = useRef(site);
  siteRef.current = site;
  const selRef = useRef(sel);
  const undoRef = useRef(null);

  const ok = site && sel && (sel === "@hero" || (sel[0] === "@" ? !!site.sections?.[Number(sel.slice(1))] : getAt(site, sel) !== undefined));
  const cur = ok ? sel : null;
  selRef.current = cur;

  const doc = useMemo(() => {
    if (!site) return { css: "", body: "" };
    const r = renderSite(site, manifest, { edit: !preview, listenUrl: preview ? "#" : "" });
    return { css: r.css, body: r.body };
  }, [site, manifest, preview]);

  useEffect(() => {
    const onKey = (e) => {
      // Cmd/Ctrl+Z undoes a change, except while typing, where the browser's
      // own undo is the right one.
      const typing = e.target?.isContentEditable || /^(INPUT|TEXTAREA)$/.test(e.target?.tagName || "")
        || hostRef.current?.shadowRoot?.activeElement?.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z" && !typing) { e.preventDefault(); undoRef.current?.(); return; }
      if (e.key !== "Escape") return;
      if (adding !== null) setAdding(null);
      else if (sheet) setSheet(false);
      else if (selRef.current) setSel(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [adding, sheet]);

  useEffect(() => { if (adding !== null && sideRef.current) sideRef.current.scrollTop = 0; }, [adding]);

  if (site === undefined) return <p class="muted">Loading your website…</p>;

  if (site === null) {
    return (
      <div class="card se-start">
        <h2>Make your website</h2>
        <p>Your music, news and shows on one page. Edit it by clicking on it.</p>
        <button type="button" class="btn sm" onClick={() => setSite(starterSite(manifest))}>Start from what I have</button>
      </div>
    );
  }

  // ── changes ──
  const commit = (fn, path = null) => {
    const before = siteRef.current;
    const now = Date.now();
    const same = path && lastPush.current.path === path && now - lastPush.current.at < 1500;
    if (!same) {
      history.current.push(before);
      if (history.current.length > 60) history.current.shift();
    }
    lastPush.current = { at: now, path };
    setSite(fn(before));
  };
  const undo = () => {
    const prev = history.current.pop();
    if (prev === undefined) return;
    lastPush.current = { at: 0, path: null };
    setSite(prev);
  };
  const setPath = (path, v) => commit((s) => setAt(s, path, v), path);
  const patchSec = (i, patch) => commit((s) => ({ ...s, sections: s.sections.map((x, k) => (k === i ? { ...x, ...patch } : x)) }));
  const setLook = (patch) => commit((s) => ({ ...s, look: { ...s.look, ...patch } }));
  const taken = () => (siteRef.current.sections || []).map((s) => s.id);

  const reveal = (q) => setTimeout(() => {
    const h = hostRef.current;
    const el = h && h.shadowRoot && h.shadowRoot.querySelector(q);
    if (!el) return;
    const top = el.getBoundingClientRect().top - h.getBoundingClientRect().top + h.scrollTop - 56;
    h.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }, 40);
  const revealSection = (i) => reveal(i === "hero" ? 'header[data-section="hero"]' : `section[data-section="${i}"]`);

  const select = (next) => {
    setSel(next);
    setAdding(null);
    // Pictures, links and dates are changed in the panel; on a phone, bring it up.
    if (next && next[0] !== "@" && !/^(text|long)$/.test(kindOf(next))) setSheet(true);
  };
  const pickSection = (i) => { setSel("@" + i); setAdding(null); setSheet(false); revealSection(i); };

  const move = (i, d) => {
    commit((s) => ({ ...s, sections: moved(s.sections, i, d) }));
    if (cur === "@" + i) setSel("@" + (i + d));
  };
  const toggle = (i) => {
    const s = siteRef.current.sections[i];
    const { hidden, ...rest } = s;
    commit((x) => ({ ...x, sections: x.sections.map((y, k) => (k === i ? (hidden ? rest : { ...rest, hidden: true }) : y)) }));
  };
  const remove = (i) => {
    const s = site.sections[i];
    if (!window.confirm(`Delete the "${s.title}" section? Everything in it goes too. (You can undo this.)`)) return;
    commit((x) => ({ ...x, sections: x.sections.filter((_, k) => k !== i) }));
    setSel(null);
  };
  const addSection = (type, at) => {
    if (site.sections.length >= 16) { notify("error", "That's the most sections a page can hold. Remove one to add another."); return; }
    const s = newSection(type, taken());
    commit((x) => ({ ...x, sections: [...x.sections.slice(0, at), s, ...x.sections.slice(at)] }));
    setAdding(null);
    setSel("@" + at);
    setSheet(false);
    revealSection(at);
  };
  const addItem = (i) => {
    const s = site.sections[i];
    if ((s.items || []).length >= 40) { notify("error", "That's the most a list can hold."); return; }
    patchSec(i, { items: [...(s.items || []), newItem(s.type)] });
  };
  const moveItem = (i, k, d) => patchSec(i, { items: moved(site.sections[i].items, k, d) });
  const removeItem = (i, k) => patchSec(i, { items: site.sections[i].items.filter((_, n) => n !== k) });
  const pickItem = (i, k) => {
    const s = site.sections[i];
    setSel(`sections.${i}.items.${k}.${FIRST[s.type]}`);
    setSheet(false);
    reveal(`[data-item="sections.${i}.items.${k}"]`);
  };

  const openAdd = (i) => { setAdding(i); setSheet(true); };
  undoRef.current = undo;

  const canvasCb = {
    sel: cur, site, select,
    text: (path, v) => setPath(path, v),
    add: openAdd,
  };

  // ── pictures already in use ──
  const pics = [];
  const seen = new Set();
  const addPic = (u) => { if (u && httpsUrl(u) && !seen.has(u)) { seen.add(u); pics.push(u); } };
  addPic(site.hero?.image);
  (site.sections || []).forEach((s) => { addPic(s.image); (s.items || []).forEach((it) => addPic(it.image)); });
  const a = manifest?.artist || {};
  addPic(a.image); addPic(a.banner);
  (manifest?.releases || []).forEach((r) => addPic(r.art));

  const imageSel = cur && cur[0] !== "@" && kindOf(cur) === "image" ? cur : null;
  const usePic = (u) => { if (imageSel) setPath(imageSel, u); };
  const uploadPic = (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    art(f, (url) => { const p = selRef.current; if (p && p[0] !== "@" && kindOf(p) === "image") setPath(p, url); else notify("ok", "Picture uploaded. Pick a picture spot on your page, then click it below."); },
      imageSel === "hero.image" ? BANNER_PX : COVER_PX);
  };

  // ── the selected thing ──
  let panel = null;
  if (cur && cur[0] !== "@") {
    const kind = kindOf(cur);
    panel = (
      <section class="se-panel" aria-label="Selected">
        <h3>Selected: {labelOf(cur)}</h3>
        <Field path={cur} label={labelOf(cur)} kind={kind} value={getAt(site, cur)} onInput={(v) => setPath(cur, v)} art={art} />
        {kind === "image" && pics.length > 0 && (
          <>
            <div class="se-label">Or use one you already have</div>
            <div class="se-grid">
              {pics.map((u) => (
                <button key={u} type="button" aria-label="Use this picture" onClick={() => usePic(u)}><img src={u} alt="" loading="lazy" /></button>
              ))}
            </div>
          </>
        )}
        <button type="button" class="se-btn ghost" onClick={() => setSel(null)}>Done</button>
      </section>
    );
  } else if (cur === "@hero") {
    panel = (
      <section class="se-panel" aria-label="Selected">
        <h3>Selected: Top of the page</h3>
        <Field path="hero.title" label="Your name" kind="text" value={site.hero.title} onInput={(v) => setPath("hero.title", v)} />
        <Field path="hero.tagline" label="Tagline" kind="long" value={site.hero.tagline} onInput={(v) => setPath("hero.tagline", v)} />
        <div class="se-f"><span>Banner picture</span>
          <Pic value={site.hero.image} onSet={(u) => setPath("hero.image", u)} art={art} px={BANNER_PX} /></div>
        <button type="button" class="se-btn ghost" onClick={() => setSel(null)}>Done</button>
      </section>
    );
  } else if (cur) {
    const i = Number(cur.slice(1));
    const s = site.sections[i];
    panel = (
      <section class="se-panel" aria-label="Selected">
        <h3>Selected: {SECTION_TYPES[s.type].label} section</h3>
        <Field path={`sections.${i}.title`} label="Section title" kind="text" value={s.title}
          onInput={(v) => setPath(`sections.${i}.title`, v)} />
        {s.hidden && <p class="se-hint">Hidden from your page. Use the eye in Sections below to show it again.</p>}
        {s.type === "about" && (
          <>
            <div class="se-f"><span>Picture</span>
              <Pic value={s.image} onSet={(u) => setPath(`sections.${i}.image`, u)} art={art} /></div>
            <Field path={`sections.${i}.text`} label="Text" kind="long" value={s.text} onInput={(v) => setPath(`sections.${i}.text`, v)} />
          </>
        )}
        {s.type === "music" && <p class="se-hint">Your releases show up here on their own.</p>}
        {LISTS.includes(s.type) && (
          <div class="se-items">
            <div class="se-label">{s.type === "news" ? "Posts" : s.type === "shows" ? "Shows" : s.type === "merch" ? "Items" : "Links"}</div>
            <ul>
              {(s.items || []).map((it, k) => (
                <li key={it.id || k}>
                  <button type="button" class="se-item-name" onClick={() => pickItem(i, k)}>{itemName(s.type, it)}</button>
                  <button type="button" class="se-ico" aria-label={`Move ${itemName(s.type, it)} up`} disabled={k === 0} onClick={() => moveItem(i, k, -1)}>↑</button>
                  <button type="button" class="se-ico" aria-label={`Move ${itemName(s.type, it)} down`} disabled={k === s.items.length - 1} onClick={() => moveItem(i, k, 1)}>↓</button>
                  <button type="button" class="se-ico" aria-label={`Remove ${itemName(s.type, it)}`} onClick={() => removeItem(i, k)}>✕</button>
                </li>
              ))}
            </ul>
            <button type="button" class="se-btn" onClick={() => addItem(i)}>+ Add one</button>
          </div>
        )}
        <button type="button" class="se-btn" onClick={() => setSel(null)}>Done</button>
        <p class="se-hint">To move or hide it, use the arrows and the eye in Sections below.</p>
        <button type="button" class="se-delete" onClick={() => remove(i)}>Delete this section</button>
      </section>
    );
  }

  const L = site.look || {};
  return (
    <>
    <SiteBar site={site} setSite={setSite} nodeUrl={nodeUrl} />
    <div class={`se${sheet ? " open" : ""}`}>
      {sheet && <button type="button" class="se-scrim" aria-label="Close the panel" onClick={() => setSheet(false)} />}
      <aside class="se-side" ref={sideRef} aria-label="Website tools">
        <div class="se-sheet-head">
          <strong>Edit panel</strong>
          <button type="button" class="se-btn" onClick={() => setSheet(false)}>Back to my page</button>
        </div>

        <div class="se-tools">
          <button type="button" class="se-btn ghost" disabled={!history.current.length} onClick={undo} title="Undo (Ctrl/Cmd+Z)">↶ Undo</button>
          <button type="button" class="se-btn ghost" aria-pressed={preview} onClick={() => { setPreview((p) => !p); setSel(null); setAdding(null); }}>
            {preview ? "Back to editing" : "See it as visitors do"}</button>
        </div>

        <div class="se-label se-pad-x">Preview on</div>
        <div class="se-view" role="group" aria-label="Preview size">
          <button type="button" aria-pressed={view === "desktop"} onClick={() => setView("desktop")}>Desktop</button>
          <button type="button" aria-pressed={view === "phone"} onClick={() => setView("phone")}>Phone</button>
        </div>

        {adding !== null && (
          <section class="se-panel" aria-label="Add a section">
            <h3>Add a section</h3>
            <ul class="se-types">
              {Object.entries(SECTION_TYPES).map(([t, v]) => (
                <li key={t}>
                  <button type="button" onClick={() => addSection(t, adding)}>
                    <b>{v.label}</b><span>{v.hint}</span>
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" class="se-btn ghost" onClick={() => setAdding(null)}>Cancel</button>
          </section>
        )}

        {adding === null && panel}
        {!panel && adding === null && <p class="se-hint se-pad">{preview ? "This is how visitors see it. Press Back to editing to change things." : "Click anything on your page to change it."}</p>}

        <section class="se-block" aria-label="Sections">
          <h3>Sections</h3>
          <ul class="se-secs">
            <li class={cur === "@hero" ? "on" : ""}>
              <button type="button" class="se-sec-main" onClick={() => pickSection("hero")}>
                <b>Top of the page</b><span>Your name, line and banner (always first)</span>
              </button>
            </li>
            {site.sections.map((s, i) => (
              <li key={s.id} class={`${cur === "@" + i ? "on" : ""}${s.hidden ? " off" : ""}`}>
                <button type="button" class="se-sec-main" onClick={() => pickSection(i)}>
                  <b>{s.title}</b>{(s.title !== SECTION_TYPES[s.type].label || s.hidden) && (
                    <span>{s.title !== SECTION_TYPES[s.type].label ? SECTION_TYPES[s.type].label : ""}{s.title !== SECTION_TYPES[s.type].label && s.hidden ? " · " : ""}{s.hidden ? "hidden" : ""}</span>)}
                </button>
                <button type="button" class="se-ico se-eye" aria-pressed={!s.hidden} title={s.hidden ? "Show it" : "Hide it"}
                  aria-label={s.hidden ? `Show ${s.title} on the page` : `Hide ${s.title} from the page`} onClick={() => toggle(i)}>
                  <Eye off={s.hidden} /><small>{s.hidden ? "Show" : "Hide"}</small>
                </button>
                <button type="button" class="se-ico" aria-label={`Move ${s.title} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                <button type="button" class="se-ico" aria-label={`Move ${s.title} down`} disabled={i === site.sections.length - 1} onClick={() => move(i, 1)}>↓</button>
              </li>
            ))}
          </ul>
          <button type="button" class="se-btn" onClick={() => openAdd(site.sections.length)}>+ Add a section</button>
        </section>

        <section class="se-block" aria-label="Look">
          <h3>Look</h3>
          <div class="se-label">Colours</div>
          <div class="se-swatches">
            {Object.entries(THEMES).map(([k, t]) => (
              <button key={k} type="button" class="se-theme" aria-pressed={L.theme === k} onClick={() => setLook({ theme: k })}
                style={{ background: t.bg, color: t.ink, borderColor: L.theme === k ? "#f6711e" : "#374151" }}>
                <i style={{ background: t.bg2, borderColor: t.line }}>Aa</i>{t.label}
              </button>
            ))}
          </div>
          <div class="se-label">Writing</div>
          <div class="se-fonts">
            {Object.entries(FONTS).map(([k, f]) => (
              <button key={k} type="button" aria-pressed={L.font === k} style={{ fontFamily: f.css }} onClick={() => setLook({ font: k })}>
                {f.label}
              </button>
            ))}
          </div>
          <div class="se-label">Accent colour</div>
          <div class="se-accents">
            {ACCENTS.map((c) => (
              <button key={c} type="button" aria-label={`Accent ${c}`} aria-pressed={L.accent === c}
                style={{ background: c }} onClick={() => setLook({ accent: c })} />
            ))}
            {L.accent !== "#f6711e" && (
              <button type="button" class="se-reset" onClick={() => setLook({ accent: "#f6711e" })}>Reset</button>
            )}
            <label class="se-custom">
              <span class="se-sr">Pick any colour</span>
              <input type="color" value={L.accent || "#f6711e"} onInput={(e) => setLook({ accent: e.currentTarget.value })} />
            </label>
          </div>
        </section>


        <p class="se-note">Changes go live when you press Publish at the top.</p>
        <div class="se-sheet-foot">
          <button type="button" class="btn sm" onClick={() => setSheet(false)}>Done</button>
        </div>
      </aside>

      <div class="se-stage">
        <div class={`se-frame${view === "phone" ? " phone" : ""}`}>
          <Canvas doc={doc} phone={view === "phone"} cb={canvasCb} hostRef={hostRef} />
        </div>
      </div>

      <div class="se-bar">
        <button type="button" class="btn sm" onClick={() => setSheet(true)}>Edit panel</button>
      </div>
    </div>
    </>
  );
}
