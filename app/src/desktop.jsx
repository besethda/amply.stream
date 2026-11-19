/**
 * The app on a computer: the same screens, laid out for a big window and a
 * mouse rather than a thumb.
 *
 *   ┌──────────┬───────────────────────────────┬────────────┐
 *   │ sidebar  │ main panel (the screens)      │ now playing│
 *   │          │                               │ or queue   │
 *   ├──────────┴───────────────────────────────┴────────────┤
 *   │ player bar: song · controls + its shape · volume       │
 *   └────────────────────────────────────────────────────────┘
 *
 * Nothing here decides anything the phone layout doesn't: every action is the
 * app's own (app.jsx), passed in. This file only arranges them.
 *
 * The waveform changes most. On a phone it is the progress bar on Now
 * playing, moving with the music. Stretched across a desktop window that
 * ribbon would be a thin line in a sea of space, so here it splits in two:
 * the player bar draws the whole song's shape (SongShape) — loud and quiet
 * parts you can see and click to — and the expanded view keeps the live
 * waveform, large, as the centrepiece.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon, Logo } from "./icons.jsx";
import { artStyle, mmss } from "./looks.js";
import { REPEAT } from "./player.js";
import { palette, Waveform } from "./waveform.jsx";
import { Cover, canTip } from "./playing.jsx";
import { setScroller } from "./scroll.js";
import { useReorder } from "./gestures.js";

/** Wide enough for a sidebar beside the music. */
const WIDE = "(min-width: 1024px)";

export function useDesktop() {
  const get = () => typeof matchMedia === "function" && matchMedia(WIDE).matches;
  const [on, setOn] = useState(get);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const m = matchMedia(WIDE);
    const change = () => setOn(m.matches);
    m.addEventListener?.("change", change);
    return () => m.removeEventListener?.("change", change);
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("desk", !!on);
  }, [on]);
  return !!on;
}

const imageOf = (e) => e?.manifest?.artist?.image || null;
const nameOf = (e) => e?.manifest?.artist?.name || "Artist";

/** The cover's colour as CSS variables, for whatever sits around the song. */
export function accentVars(accent) {
  if (!accent) return undefined;
  const pal = palette(accent);
  const ink = (rgb) => {
    const [r, g, b] = rgb.split(",").map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.3 ? "#131110" : "#fff";
  };
  return {
    "--np-accent": `rgb(${pal.line.dark})`, "--np-on": ink(pal.line.dark),
    "--np-accent-light": `rgb(${pal.line.light})`, "--np-on-light": ink(pal.line.light),
    "--np-rgb": pal.line.dark, "--np-rgb-light": pal.line.light,
  };
}

// ── the frame ───────────────────────────────────────────────────────────────

/**
 * The main panel: it scrolls, not the page, so the sidebar and the player
 * stay put. Registered with scroll.js so screens keep their places.
 */
export function MainPanel({ children, top, screenKey }) {
  const box = useRef(null);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    setScroller(box.current);
    return () => setScroller(null);
  }, []);
  useEffect(() => { setScrolled((box.current?.scrollTop || 0) > 8); }, [screenKey]);
  return (
    <main class={`d-main${scrolled ? " scrolled" : ""}`} ref={box}
      onScroll={(e) => { const s = e.currentTarget.scrollTop > 8; if (s !== scrolled) setScrolled(s); }}>
      {top}
      <div class="d-screen" key={screenKey}>{children}</div>
    </main>
  );
}

/** Along the top of the main panel: back and forward, adding an artist, you. */
export function TopBar({ onAdd, depth, themeName, onTheme, balance, pair, onYou, needsBackup }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function submit(e) {
    e.preventDefault();
    if (!value.trim()) return;
    setBusy(true); setError(null);
    try { await onAdd(value); setValue(""); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <div class="d-top">
      <div class="d-nav">
        <button class="d-round" onClick={() => history.back()} disabled={!depth} aria-label="Back" title="Back"><Icon.back size={17} /></button>
        <button class="d-round" onClick={() => history.forward()} aria-label="Forward" title="Forward"><Icon.chevron size={17} /></button>
      </div>
      <form class={`d-add${error ? " bad" : ""}`} onSubmit={submit} title="Follow an artist by the link or website they gave you">
        <Icon.link size={17} />
        <input type="text" inputMode="url" autocapitalize="off" autocorrect="off" spellcheck={false}
          value={value} disabled={busy} placeholder="Paste an artist's link or website to follow them"
          aria-label="An artist's link or website" onInput={(e) => { setValue(e.target.value); setError(null); }} />
        {busy ? <span class="bars" aria-hidden="true"><i /><i /><i /></span>
          : value.trim() ? <button class="d-add-go">Follow</button> : <kbd class="d-kbd">⌘V</kbd>}
        {error && <span class="d-add-error" role="alert">{error}</span>}
      </form>
      <div class="d-top-right">
        <button class="d-round" onClick={onTheme} aria-label={themeName === "dark" ? "Light mode" : "Dark mode"} title={themeName === "dark" ? "Light mode" : "Dark mode"}>
          {themeName === "dark" ? <Icon.sun size={17} /> : <Icon.moon size={17} />}
        </button>
        <button class="d-wallet" onClick={onYou} title="Your wallet and settings">
          <span class="d-wallet-dot">{needsBackup && <i />}<Icon.you size={16} /></span>
          <span>{pair && balance ? `$${Math.max(0, balance.usdc).toFixed(2)}` : "You"}</span>
        </button>
      </div>
    </div>
  );
}

/** On the left: where to go, and everything you follow and keep. */
export function Sidebar({
  tab, onTab, here, entries, lists, liked, localEntry, onOpenArtist, onOpenPlaylist, onOpenLiked, onOpenLocal,
  onNewPlaylist, onAdd, playingFrom, playing, needsBackup,
}) {
  const [filter, setFilter] = useState("all");
  const items = [];
  if (filter !== "artists") {
    items.push({ key: "liked", kind: "liked", title: "Liked songs", sub: `Playlist · ${liked} song${liked === 1 ? "" : "s"}`, on: here === "liked", open: onOpenLiked });
    for (const p of lists) {
      items.push({ key: p.id, kind: "playlist", art: p.art, seed: p.name, title: p.name, sub: `Playlist · ${p.tracks.length} song${p.tracks.length === 1 ? "" : "s"}`, on: here === `pl:${p.id}`, open: () => onOpenPlaylist(p.id) });
    }
    if (localEntry) items.push({ key: "local", kind: "local", title: "On this computer", sub: `${localEntry.tracks.length} songs`, on: here === "local", open: onOpenLocal });
  }
  if (filter !== "playlists") {
    for (const e of entries) {
      items.push({ key: e.url, kind: "artist", art: imageOf(e), seed: nameOf(e), title: nameOf(e), sub: "Artist", on: here === e.url, open: () => onOpenArtist(e.url), playing: playing && playingFrom === e.url });
    }
  }
  return (
    <aside class="d-side" aria-label="Sections and your library">
      <nav class="d-card d-menu">
        <div class="d-brand"><Logo size={26} /><span>amply</span></div>
        {[["home", "Home", Icon.home], ["library", "Library", Icon.library], ["you", "You", Icon.you]].map(([id, label, I]) => (
          <button key={id} class={`d-menu-item${tab === id && !here ? " on" : ""}`} onClick={() => onTab(id)} aria-current={tab === id && !here ? "page" : undefined}>
            <span class="d-menu-icon"><I size={21} />{id === "you" && needsBackup && <i class="tab-dot" />}</span>
            {label}
          </button>
        ))}
      </nav>
      <section class="d-card d-lib">
        <div class="d-lib-head">
          <span class="d-lib-title"><Icon.library size={20} /> Your music</span>
          <span class="d-lib-acts">
            <button class="d-ghost" onClick={onNewPlaylist} aria-label="New playlist" title="New playlist"><Icon.plus size={17} /></button>
          </span>
        </div>
        <div class="d-chips" role="tablist">
          {[["all", "All"], ["playlists", "Playlists"], ["artists", "Artists"]].map(([id, label]) => (
            <button key={id} role="tab" aria-selected={filter === id} class={`d-chip${filter === id ? " on" : ""}`} onClick={() => setFilter(id)}>{label}</button>
          ))}
        </div>
        <div class="d-lib-list">
          {items.map((it) => (
            <button key={it.key} class={`d-lib-item${it.on ? " on" : ""}`} onClick={it.open} title={it.title}>
              {it.kind === "liked" ? <span class="d-lib-art liked"><Icon.heartOn size={18} /></span>
                : it.kind === "local" ? <span class="d-lib-art local"><Icon.folder size={18} /></span>
                : <span class={`d-lib-art${it.kind === "artist" ? " round" : ""}`} style={artStyle(it.art, it.seed)} />}
              <span class="d-lib-text"><b>{it.title}</b><span>{it.sub}</span></span>
              {it.playing && <span class="bars" aria-label="Playing"><i /><i /><i /></span>}
            </button>
          ))}
          {filter !== "playlists" && (
            <button class="d-lib-item add" onClick={onAdd}>
              <span class="d-lib-art dashed round"><Icon.plus size={18} /></span>
              <span class="d-lib-text"><b>Follow an artist</b><span>By their link or website</span></span>
            </button>
          )}
        </div>
      </section>
    </aside>
  );
}

// ── the song's shape: the player bar's progress ────────────────────────────

const BAR = 2.6, GAP = 1.6;   // css px: each column's bar, and the space after it
const BIG = { bar: 4, gap: 3 };   // in Now playing, where it's the scrubber across the window

/**
 * The whole song drawn as its loudness, played part in the cover's colour,
 * the rest faint; hover to see where a click would land, drag to scrub. The
 * column under the playhead breathes with the music, so it reads as alive
 * even though the shape is the whole song. Without a waves file, a plain line.
 */
export function SongShape({ viz, state, player, accent, trackKey, big = false }) {
  const barW = big ? BIG.bar : BAR, gapW = big ? BIG.gap : GAP;
  const canvas = useRef(null);
  const box = useRef(null);
  const [hover, setHover] = useState(null);     // 0..1 under the pointer
  const [drag, setDrag] = useState(null);       // 0..1 while dragging
  const [hold, setHold] = useState(null);       // where a seek was asked for, until the music catches up
  const live = useRef({});
  const dur = state.duration || 0;
  const now = dur ? Math.min(1, Math.max(0, (state.at || 0) / dur)) : 0;
  useEffect(() => { if (hold != null && Math.abs(now - hold) < 0.01) setHold(null); }, [now, hold]);
  useEffect(() => { if (hold == null) return; const h = setTimeout(() => setHold(null), 2000); return () => clearTimeout(h); }, [hold]);
  const shown = drag ?? hold ?? now;
  live.current = { progress: shown, hover: drag ?? hover, playing: state.playing, accent, trackKey, at: state.at, dur };

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const g = el.getContext("2d");
    const still = matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let raf = 0, dpr = 1, cols = 0, born = performance.now(), lastKey = null, lastWaves = null, glow = 0, smooth = 0;
    const size = () => {
      const r = el.getBoundingClientRect();
      dpr = Math.min(2, devicePixelRatio || 1);
      el.width = Math.round(r.width * dpr); el.height = Math.round(r.height * dpr);
      cols = Math.max(24, Math.floor(r.width / (barW + gapW)));
    };
    size();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(size) : null;
    ro?.observe(el);

    const draw = (t) => {
      const L = live.current, w = el.width, h = el.height;
      if (w < 10) { raf = requestAnimationFrame(draw); return; }
      const light = document.documentElement.dataset.theme === "light";
      const pal = palette(L.accent);
      const line = light ? pal.line.light : pal.line.dark;
      const rest = light ? "19,17,16" : "248,244,241";
      const shape = viz?.overview(cols);
      const key = `${L.trackKey}|${viz?.key?.() || ""}`;
      // A new song, or its shape just arrived: the bars grow in, left to right.
      if (key !== lastKey) { lastKey = key; born = t; }
      if ((shape ? 1 : 0) !== lastWaves) { lastWaves = shape ? 1 : 0; born = t; }
      const grow = still ? 1 : Math.min(1, (t - born) / 650);
      const loud = (L.playing && viz?.loudness?.()) || 0;
      smooth += (loud - smooth) * 0.35;
      glow += ((L.playing ? 1 : 0) - glow) * 0.08;
      g.clearRect(0, 0, w, h);
      const mid = h / 2, cell = (barW + gapW) * dpr, bw = barW * dpr, x0 = (w - cols * cell + gapW * dpr) / 2;
      const head = L.progress * w, hov = L.hover;

      if (!shape) {
        // No shape to draw: a line, like any player's.
        const th = 4 * dpr, y = mid - th / 2, r = th / 2;
        const bar = (from, to, style) => { if (to - from < 1) return; g.fillStyle = style; g.beginPath(); g.roundRect ? g.roundRect(from, y, to - from, th, r) : g.rect(from, y, to - from, th); g.fill(); };
        bar(0, w, `rgba(${rest},${light ? 0.14 : 0.18})`);
        if (hov != null && hov > L.progress) bar(head, hov * w, `rgba(${line},0.35)`);
        bar(0, head, `rgb(${line})`);
      } else {
        for (let c = 0; c < cols; c++) {
          const x = x0 + c * cell, cx = x + bw / 2, f = (c + 0.5) / cols;
          // Grows in from the left as a song arrives.
          const reveal = Math.min(1, Math.max(0, grow * 1.6 - (c / cols) * 0.6));
          const ease = 1 - Math.pow(1 - reveal, 3);
          let v = 0.1 + 0.9 * shape[c];
          // The column at the playhead, and a few beside it, breathe with the music.
          const near = Math.abs(cx - head) / (cell * 2.2);
          if (near < 1) v = Math.min(1.12, v + smooth * 0.32 * (1 - near) * glow);
          const bh = Math.max(2 * dpr, v * (h - 2 * dpr) * ease);
          let style;
          if (cx <= head) {
            style = `rgba(${line},${0.95})`;
          } else if (hov != null && f <= hov) {
            style = `rgba(${line},0.42)`;
          } else {
            style = `rgba(${rest},${light ? 0.2 : 0.24})`;
          }
          g.fillStyle = style;
          g.beginPath();
          if (g.roundRect) g.roundRect(x, mid - bh / 2, bw, bh, bw / 2); else g.rect(x, mid - bh / 2, bw, bh);
          g.fill();
        }
        // The playhead: a soft glow that swells with the music.
        if (glow > 0.02 || L.progress > 0) {
          const rad = (10 + 10 * smooth) * dpr;
          const halo = g.createRadialGradient(head, mid, 0, head, mid, rad);
          halo.addColorStop(0, `rgba(${line},${0.22 + 0.3 * smooth * glow})`);
          halo.addColorStop(1, `rgba(${line},0)`);
          g.globalCompositeOperation = light ? "source-over" : "lighter";
          g.fillStyle = halo; g.beginPath(); g.arc(head, mid, rad, 0, Math.PI * 2); g.fill();
          g.globalCompositeOperation = "source-over";
          if (big) {
            // A dot on the playhead, as on the line through the phone's waves.
            g.fillStyle = light ? "#fff" : "#fff7ef";
            g.beginPath(); g.arc(head, mid, 6.5 * dpr, 0, Math.PI * 2); g.fill();
            if (light) { g.fillStyle = `rgb(${line})`; g.beginPath(); g.arc(head, mid, 4.5 * dpr, 0, Math.PI * 2); g.fill(); }
          }
        }
      }
      // The hover line: where a click would go.
      if (hov != null) {
        g.fillStyle = light ? "rgba(19,17,16,.55)" : "rgba(255,247,239,.75)";
        g.fillRect(Math.round(hov * w - dpr / 2), 0, Math.max(1, dpr), h);
      }
      const busy = L.playing || grow < 1 || hov != null || Math.abs(smooth) > 0.01 || glow > 0.01;
      raf = busy ? requestAnimationFrame(draw) : (setTimeout(() => { raf = requestAnimationFrame(draw); }, 200), 0);
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); ro?.disconnect(); };
  }, [viz, big]);

  const at = (e) => {
    const r = box.current.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };
  const commit = (f) => { player.seek(f * dur); setHold(f); setDrag(null); };
  const tipAt = drag ?? hover;
  return (
    <div class={`d-shape-row${big ? " big" : ""}`}>
      <span class="d-time">{mmss((drag ?? hold ?? now) * dur)}</span>
      <div class="d-shape" ref={box} role="slider" tabIndex={0} aria-label="Position"
        aria-valuemin={0} aria-valuemax={Math.round(dur)} aria-valuenow={Math.round(shown * dur)} aria-valuetext={mmss(shown * dur)}
        onPointerDown={(e) => { if (!dur) return; e.currentTarget.setPointerCapture?.(e.pointerId); setDrag(at(e)); }}
        onPointerMove={(e) => { const f = at(e); setHover(f); if (drag != null) setDrag(f); }}
        onPointerUp={(e) => { if (drag != null) commit(at(e)); }}
        onPointerLeave={() => setHover(null)}
        onPointerCancel={() => setDrag(null)}
        onKeyDown={(e) => {
          if (!dur) return;
          if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); commit(Math.min(1, shown + 5 / dur)); }
          if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); commit(Math.max(0, shown - 5 / dur)); }
        }}>
        <canvas ref={canvas} class="d-shape-canvas" aria-hidden="true" />
        {tipAt != null && dur > 0 && <span class="d-shape-tip" style={`left:${tipAt * 100}%`}>{mmss(tipAt * dur)}</span>}
      </div>
      <span class="d-time">{mmss(dur)}</span>
    </div>
  );
}

// ── the line along the top of the player bar ───────────────────────────────

/**
 * How far through the song, as the phone's mini player shows it: a thin line
 * along the top of the bar in the cover's colour, with a small dot at the
 * playhead. Hover thickens it and shows the time under the pointer; click or
 * drag to go there.
 */
function BarLine({ state, player }) {
  const box = useRef(null);
  const [hover, setHover] = useState(null);
  const [drag, setDrag] = useState(null);
  const [hold, setHold] = useState(null);
  const dur = state.duration || 0;
  const now = dur ? Math.min(1, Math.max(0, (state.at || 0) / dur)) : 0;
  useEffect(() => { if (hold != null && Math.abs(now - hold) < 0.01) setHold(null); }, [now, hold]);
  useEffect(() => { if (hold == null) return; const h = setTimeout(() => setHold(null), 2000); return () => clearTimeout(h); }, [hold]);
  const shown = drag ?? hold ?? now;
  const at = (e) => {
    const r = box.current.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };
  const commit = (f) => { player.seek(f * dur); setHold(f); setDrag(null); };
  const tipAt = drag ?? hover;
  return (
    <div class={`d-line${drag != null ? " held" : ""}`} ref={box} role="slider" tabIndex={0} aria-label="Position"
      aria-valuemin={0} aria-valuemax={Math.round(dur)} aria-valuenow={Math.round(shown * dur)} aria-valuetext={mmss(shown * dur)}
      onPointerDown={(e) => { if (!dur) return; e.currentTarget.setPointerCapture?.(e.pointerId); setDrag(at(e)); }}
      onPointerMove={(e) => { const f = at(e); setHover(f); if (drag != null) setDrag(f); }}
      onPointerUp={(e) => { if (drag != null) commit(at(e)); }}
      onPointerLeave={() => setHover(null)}
      onPointerCancel={() => setDrag(null)}
      onKeyDown={(e) => {
        if (!dur) return;
        if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); commit(Math.min(1, shown + 5 / dur)); }
        if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); commit(Math.max(0, shown - 5 / dur)); }
      }}>
      <span class="d-line-track" aria-hidden="true">
        {hover != null && hover > shown && <span class="d-line-ahead" style={`left:${shown * 100}%;width:${(hover - shown) * 100}%`} />}
        <span class="d-line-done" style={`transform:scaleX(${shown})`} />
      </span>
      <span class="d-line-dot" aria-hidden="true" style={`left:${shown * 100}%`} />
      {tipAt != null && dur > 0 && <span class="d-line-tip" style={`left:${tipAt * 100}%`}>{mmss(tipAt * dur)}</span>}
    </div>
  );
}

// ── the player bar ──────────────────────────────────────────────────────────

const REFUSED = {
  nowallet: "Add money to play", empty: "Add money to play", price: "Agree to the price to play",
  subscribe: "Subscribers only", offline: "Artist offline", unpaid: "Pay what's owed to play",
};

function useVolume(player, eq) {
  const read = () => { try { const v = parseFloat(localStorage.getItem("amply.volume")); return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1; } catch { return 1; } };
  const [vol, setVol] = useState(read);
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    if (eq) eq.setVolume(muted ? 0 : vol);
    else player.element().volume = muted ? 0 : vol;
    try { localStorage.setItem("amply.volume", String(vol)); } catch { /* fine */ }
  }, [vol, muted]);
  return { vol, muted, setVol: (v) => { setVol(v); if (v > 0) setMuted(false); }, toggleMute: () => setMuted((m) => !m) };
}

export function PlayerBar({
  state, player, viz, cost, liked, onLike, onArtist, onAlbum, panel, onPanel, onExpand, expanded, volume, wave = "ribbons",
}) {
  const t = state.track;
  const repeatOn = state.repeat !== REPEAT.OFF;
  const { vol, muted, setVol, toggleMute } = volume;
  const level = muted ? 0 : vol;
  return (
    <footer class={`d-bar${t ? "" : " idle"}${expanded ? " under" : ""}`} style={accentVars(t?.colors?.accent)} aria-label="Player">
      {/* The music, moving softly behind everything (in Now playing, its
          own larger waves take over); and the song's progress along the top
          edge, the one place it's shown, always. */}
      {t && !expanded && <div class="d-bar-waves" aria-hidden="true">
        <Waveform viz={viz} playing={state.playing && !state.waiting} accent={t.colors?.accent} style={wave} inset={0} wide bare />
      </div>}
      {t && <BarLine state={state} player={player} />}
      <div class="d-bar-song">
        {t ? <>
          <button class="d-bar-art" onClick={onExpand} aria-label="Open now playing" title="Open now playing">
            <Cover class="art d-bar-cover" track={t} />
            {!expanded && <span class="d-bar-art-hint"><Icon.down size={16} /></span>}
          </button>
          <span class="d-bar-text">
            <button class="d-bar-title" onClick={onAlbum} title={t.title}>{t.title}</button>
            <span class="d-bar-sub">
              {state.refused ? <span class="warn-ink">{REFUSED[state.refused.kind] || "Can't play"}</span>
                : <button class="d-bar-artist" onClick={onArtist}>{t.artistName}</button>}
              {!state.refused && cost.tag && <span class={`badge ${cost.tone}`}>{cost.tag}</span>}
            </span>
          </span>
          <button class={`icon-btn d-like${liked ? " on" : ""}`} onClick={onLike} aria-label={liked ? "Unlike" : "Like"} aria-pressed={liked} title={liked ? "Unlike" : "Like"}>
            {liked ? <Icon.heartOn size={18} /> : <Icon.heart size={18} />}
          </button>
        </> : <span class="d-bar-empty"><Icon.note size={20} /> Pick something to play</span>}
      </div>

      <div class="d-bar-mid">
        <div class="d-controls">
          <span class="d-time">{t ? mmss(state.at || 0) : ""}</span>
          <button class={`icon-btn d-ctl${state.shuffle ? " on" : ""}`} onClick={() => player.toggleShuffle()} aria-label="Shuffle" aria-pressed={state.shuffle} title="Shuffle" disabled={!t}>
            <Icon.shuffle size={17} />
          </button>
          <button class="icon-btn d-ctl" onClick={() => player.prev()} aria-label="Previous" title="Previous" disabled={!t}><Icon.prev size={19} /></button>
          <button class={`d-play${state.waiting ? " waiting" : ""}`} onClick={() => player.toggle()} disabled={!t}
            aria-label={state.waiting ? "Buffering" : state.playing ? "Pause" : "Play"} title={state.playing ? "Pause (space)" : "Play (space)"}>
            {state.playing ? <Icon.pause size={18} /> : <Icon.play size={18} />}
          </button>
          <button class="icon-btn d-ctl" onClick={() => player.next()} disabled={!state.hasNext} aria-label="Next" title="Next"><Icon.next size={19} /></button>
          <button class={`icon-btn d-ctl${repeatOn ? " on" : ""}`} onClick={() => player.cycleRepeat()} disabled={!t}
            aria-label={["Repeat off", "Repeat all", "Repeat one"][state.repeat]} title={["Repeat", "Repeat all", "Repeat one"][state.repeat]}>
            <Icon.repeat size={17} />
            {state.repeat === REPEAT.ONE && <span class="badge-1">1</span>}
          </button>
          <span class="d-time end">{t ? mmss(state.duration || 0) : ""}</span>
        </div>
      </div>

      <div class="d-bar-right">
        <button class={`icon-btn d-ctl${panel === "np" ? " on" : ""}`} onClick={() => onPanel("np")} aria-label="Now playing view" aria-pressed={panel === "np"} title="Now playing view"><Icon.note size={19} /></button>
        <button class={`icon-btn d-ctl${panel === "queue" ? " on" : ""}`} onClick={() => onPanel("queue")} aria-label="Queue" aria-pressed={panel === "queue"} title="Queue"><Icon.queue size={19} /></button>
        <div class="d-vol">
          <button class="icon-btn d-ctl" onClick={toggleMute} aria-label={muted || vol === 0 ? "Unmute" : "Mute"} title={muted ? "Unmute (M)" : "Mute (M)"}>
            <VolumeIcon level={level} />
          </button>
          <input type="range" class="d-range" min="0" max="1" step="0.01" value={level} aria-label="Volume"
            style={`--fill:${level * 100}%`} onInput={(e) => setVol(parseFloat(e.target.value))} />
        </div>
        <button class="icon-btn d-ctl" onClick={onExpand} disabled={!t} aria-label={expanded ? "Close now playing" : "Open now playing"} title={expanded ? "Close (Esc)" : "Full view"}>
          {expanded ? <Icon.down size={19} /> : <ExpandIcon />}
        </button>
      </div>
    </footer>
  );
}

function VolumeIcon({ level }) {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" stroke-width="1.4" />
      {level === 0 ? <path d="M16 9.5l5 5M21 9.5l-5 5" />
        : <>
          <path d="M15.5 9.2a4 4 0 010 5.6" />
          {level > 0.5 && <path d="M18.2 6.6a7.6 7.6 0 010 10.8" />}
        </>}
    </svg>
  );
}
function ExpandIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M14 4h6v6M20 4l-6.5 6.5M10 20H4v-6M4 20l6.5-6.5" />
    </svg>
  );
}

// ── the panel on the right: what's playing, or what's next ─────────────────

export function SidePanel({
  mode, state, player, artist, liked, onLike, onArtist, onFollow, followed, onClose, onAddTo, onShare, onTip, tips, onPlayAt,
}) {
  const t = state.track;
  const queue = useRef(null);
  useReorder(queue, { onMove: (from, to) => player.moveNextTo(from, to) });
  return (
    <aside class="d-card d-panel" style={accentVars(t?.colors?.accent)} aria-label={mode === "queue" ? "Queue" : "Now playing"}>
      <div class="d-panel-head">
        <b>{mode === "queue" ? "Queue" : "Now playing"}{mode !== "queue" && state.from && <span class="d-panel-from"> · {state.from}</span>}</b>
        <button class="d-ghost" onClick={onClose} aria-label="Close" title="Close"><Icon.close size={16} /></button>
      </div>
      <div class="d-panel-body">
        {!t && <p class="dim small d-panel-empty">Nothing playing yet. Pick a song and it shows up here.</p>}
        {t && mode === "np" && <>
          <div class="d-panel-cover"><Cover class="art-layer" track={t} /></div>
          <div class="d-panel-title">
            <span class="d-panel-text">
              <b title={t.title}>{t.title}</b>
              <button class="d-bar-artist" onClick={onArtist}>{t.artistName}</button>
            </span>
            <span class="d-panel-acts">
              {!t.local && <button class="icon-btn d-ctl" onClick={onShare} aria-label="Share" title="Share"><Icon.share size={19} /></button>}
              <button class="icon-btn d-ctl" onClick={onAddTo} aria-label="Add to playlist" title="Add to playlist"><Icon.plus size={20} /></button>
              <button class={`icon-btn d-ctl d-like${liked ? " on" : ""}`} onClick={onLike} aria-label={liked ? "Unlike" : "Like"} title={liked ? "Unlike" : "Like"}>
                {liked ? <Icon.heartOn size={20} /> : <Icon.heart size={20} />}
              </button>
            </span>
          </div>
          {artist && (
            <div class="d-about">
              <span class="d-about-banner" style={artStyle(artist.manifest?.artist?.banner || artist.manifest?.artist?.image, nameOf(artist))}>
                <span class="d-about-label">About the artist</span>
              </span>
              <div class="d-about-body">
                <div class="d-about-who">
                  <span class="art round s44" style={artStyle(imageOf(artist), nameOf(artist))} />
                  <button class="d-about-name" onClick={onArtist}>{nameOf(artist)}</button>
                  {followed
                    ? <span class="d-following">Following</span>
                    : <button class="pill sm" onClick={onFollow}>Follow</button>}
                </div>
                {artist.manifest?.artist?.bio && <p class="d-about-bio">{artist.manifest.artist.bio}</p>}
                {canTip(tips) && <button class="pill sm" onClick={onTip}><Icon.tip size={15} /> Tip {tips.name}</button>}
              </div>
            </div>
          )}
          <NextUp state={state} onPlayAt={onPlayAt} player={player} short />
        </>}
        {t && mode === "queue" && <>
          <span class="label">NOW PLAYING</span>
          <div class="d-q-now">
            <Cover class="art s44" track={t} />
            <span class="q-text"><b class="accent-ink">{t.title}</b><span>{t.artistName}</span></span>
            {state.playing && <span class="bars" aria-hidden="true"><i /><i /><i /></span>}
          </div>
          <span class="label">NEXT{state.from ? ` FROM ${state.from.toUpperCase()}` : ""}</span>
          <div class="q-list d-q-list" ref={queue}>
            {state.upNext?.length ? state.upNext.map((q, k) => (
              <div class="q-row d-q-row" data-reorder key={`${q.from}#${q.id}#${k}`}>
                <button class="d-q-play" onClick={() => onPlayAt(k)} aria-label={`Play ${q.title}`}>
                  <span class="art s40 q-art" style={artStyle(q.art, q.releaseTitle || q.title)}><span class="d-q-icon"><Icon.play size={14} /></span></span>
                  <span class="q-text"><b>{q.title}</b><span>{q.artistName}</span></span>
                </button>
                <button class="icon-btn dim" onClick={() => player.removeNext(k)} aria-label={`Remove ${q.title}`} title="Remove from queue"><Icon.close size={14} /></button>
              </div>
            )) : <p class="dim small">Nothing queued. Right-click a song, or use its ⋯ menu, to add it.</p>}
          </div>
        </>}
      </div>
    </aside>
  );
}

function NextUp({ state, onPlayAt, short }) {
  const list = (state.upNext || []).slice(0, short ? 3 : 50);
  if (!list.length) return null;
  return (
    <div class="d-next">
      <span class="label">NEXT IN QUEUE</span>
      {list.map((q, k) => (
        <button class="d-next-row" key={`${q.from}#${q.id}#${k}`} onClick={() => onPlayAt(k)}>
          <span class="art s40" style={artStyle(q.art, q.releaseTitle || q.title)}><span class="d-q-icon"><Icon.play size={14} /></span></span>
          <span class="q-text"><b>{q.title}</b><span>{q.artistName}</span></span>
        </button>
      ))}
    </div>
  );
}

// ── now playing, the whole window ──────────────────────────────────────────

const WAVE_NAMES = { ribbons: "Ribbons", boxes: "Boxes", hills: "Hills" };

/**
 * The song, large: its cover, its name, and the live waveform across the
 * width — the one place on a computer where the music is drawn moving. The
 * player bar stays below, so the controls are where they always are.
 */
export function Expanded({ state, player, viz, cost, wave, onWave, onClose, onArtist, liked, onLike, onAddTo, onShare, onTip, tips, session, onPlayAt }) {
  const t = state.track;
  useEffect(() => {
    // A sheet over it closes first; Escape again closes this.
    const esc = (e) => { if (e.key === "Escape" && !document.querySelector(".sheet-wrap")) onClose(); };
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, []);
  if (!t) return null;
  const c = t.colors;
  return (
    <div class="d-expanded" role="dialog" aria-label="Now playing" style={accentVars(c?.accent)}>
      <div class="d-exp-glow" style={c?.accent ? `--a:${c.accent};--d:${c.deep || c.accent}` : ""} />
      {/* The music, large, behind everything; where the song is, and where
          to go in it, is the line along the top of the player bar below. */}
      <div class="d-exp-wave" aria-hidden="true">
        <Waveform viz={viz} playing={state.playing && !state.waiting} accent={c?.accent} style={wave} inset={0} wide bare />
      </div>
      {/* How the music is drawn: changed where it's drawn. */}
      <button class="d-wave-pick" onClick={onWave} title="Change how the music is drawn">
        {wave === "boxes" ? <Icon.boxes size={17} /> : wave === "hills" ? <Icon.hills size={18} /> : <Icon.ribbons size={18} />}
        {WAVE_NAMES[wave] || "Ribbons"}
      </button>

      <div class="d-exp-top">
        <button class="d-round" onClick={onClose} aria-label="Close" title="Close (Esc)"><Icon.down size={18} /></button>
        <span class="d-exp-from">{state.from ? <>Playing from <b>{state.from}</b></> : "Now playing"}</span>
      </div>
      <div class="d-exp-main">
        <div class="d-exp-cover"><Cover class="art-layer" track={t} /></div>
        <div class="d-exp-info">
          <span class="d-exp-kind">{t.releaseTitle ? `From ${t.releaseTitle}` : "Single"}</span>
          <h1 class="d-exp-title">{t.title}</h1>
          <div class="d-exp-who">
            <button class="d-exp-artist" onClick={onArtist}>{t.artistName}</button>
            {!t.local && (t.verified
              ? <span class="good-ink" title="Their website vouches for them"><Icon.check size={15} /></span>
              : <span class="warn-ink" title="No website linked yet"><Icon.warn size={15} /></span>)}
            {cost.tag && <span class={`badge ${cost.tone}`}>{cost.tag}</span>}
            {session && <span class="mono-dim">{session} this session</span>}
          </div>
          <div class="d-exp-acts">
            <button class={`d-exp-btn${liked ? " on" : ""}`} onClick={onLike} aria-pressed={liked}>
              {liked ? <Icon.heartOn size={18} /> : <Icon.heart size={18} />}{liked ? "Liked" : "Like"}
            </button>
            <button class="d-exp-btn" onClick={onAddTo}><Icon.plus size={18} />Add to playlist</button>
            {!t.local && <button class="d-exp-btn" onClick={onShare}><Icon.share size={17} />Share</button>}
            {canTip(tips) && <button class="d-exp-btn" onClick={onTip}><Icon.tip size={18} />Tip</button>}
          </div>
        </div>
        <div class="d-exp-queue">
          <span class="label">UP NEXT</span>
          {(state.upNext || []).slice(0, 8).map((q, k) => (
            <button class="d-next-row" key={`${q.from}#${q.id}#${k}`} onClick={() => onPlayAt(k)}>
              <span class="art s40" style={artStyle(q.art, q.releaseTitle || q.title)}><span class="d-q-icon"><Icon.play size={14} /></span></span>
              <span class="q-text"><b>{q.title}</b><span>{q.artistName}</span></span>
            </button>
          ))}
          {!state.upNext?.length && <p class="dim small">Nothing queued.</p>}
        </div>
      </div>
    </div>
  );
}

// ── keys ────────────────────────────────────────────────────────────────────

/** Space to play or pause, arrows to seek, shift-arrows to skip, M to mute. */
export function useKeys({ player, state, volume, onLike }) {
  const live = useRef(null);
  live.current = { player, state, volume, onLike };
  useEffect(() => {
    const key = (e) => {
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const { player: p, state: s, volume: v, onLike: like } = live.current;
      if (document.querySelector(".sheet-wrap")) return;
      // Space plays and pauses from anywhere — except on a control that space
      // itself works (a switch, a tab, a choice), and never twice: a focused
      // button would otherwise take the same press as a click.
      const own = e.target?.closest?.('[role="switch"],[role="radio"],[role="tab"],[role="checkbox"],[role="slider"],summary');
      if (e.key === " " && !own) { e.preventDefault(); if (s.track) p.toggle(); }
      else if (e.key === "ArrowRight" && e.shiftKey) { e.preventDefault(); p.next(); }
      else if (e.key === "ArrowLeft" && e.shiftKey) { e.preventDefault(); p.prev(); }
      else if (e.key === "ArrowRight" && s.duration && !e.target?.closest?.("[role=slider]")) { e.preventDefault(); p.seek(Math.min(s.duration, (s.at || 0) + 5)); }
      else if (e.key === "ArrowLeft" && s.duration && !e.target?.closest?.("[role=slider]")) { e.preventDefault(); p.seek(Math.max(0, (s.at || 0) - 5)); }
      else if (e.key === "m" || e.key === "M") v.toggleMute();
      else if ((e.key === "l" || e.key === "L") && s.track) like();
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);
}

export { useVolume };
