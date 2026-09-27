/**
 * What's playing: the mini player above the tabs, and the full screen it opens.
 * Both show what the current song costs, as a small badge.
 */
import { Icon } from "./icons.jsx";
import { mmss, gradient, artStyle } from "./looks.js";
import { REPEAT } from "./player.js";
import { useSwipe, usePullDown, useReorder } from "./gestures.js";
import { useRef, useEffect, useState } from "preact/hooks";
import { Waveform, palette } from "./waveform.jsx";
import { TIP_AMOUNTS } from "./tips.js";

export function MiniPlayer({ state, player, cost, onOpen }) {
  const t = state.track;
  // Which way the song goes when it changes, as on Now playing: a swipe or
  // the next button sends it left; "previous" only if it really goes back.
  const move = useRef({ dir: null, x: 0 });
  const next = () => {
    if (!state.hasNext) return false;
    move.current.dir = "next"; player.next(); return true;
  };
  const prev = () => {
    const changes = state.hasPrev && (state.at || 0) <= 3;
    if (changes) move.current.dir = "prev";
    player.prev();
    return changes;
  };
  // The song after this one, fetched ahead so its cover is there when it's on.
  useEffect(() => { warmCover(state.upNext?.[0]); }, [state.upNext?.[0]?.art]);
  // The song slides; a swipe anywhere on the bar moves it.
  const slides = useSlides({ class: "mini-slides", track: t, move, onNext: next, onPrev: prev, onUp: onOpen, far: "100% + 24px",
    render: (song, now) => <>
      <Cover class="art s40" track={song} />
      <span class="mini-text">
        <b>{song.title}</b>
        <span class="mini-sub">
          {!now ? song.artistName
            : drag != null ? <span class="mini-time">{mmss(drag * state.duration)} / {mmss(state.duration)}</span>
            : state.refused ? <span class="warn-ink">Can't play</span>
            : <>{song.artistName}{cost.tag && <span class={`badge ${cost.tone}`}>{cost.tag}</span>}</>}
        </span>
      </span>
    </> });
  // Dragging the line along the top: it follows the finger, the song seeks
  // once on release, and the line holds that spot until the music catches up.
  const [drag, setDrag] = useState(null);     // 0..1 while dragging
  const [hold, setHold] = useState(null);
  const strip = useRef(null);
  const now = state.duration ? Math.min(1, Math.max(0, (state.at || 0) / state.duration)) : 0;
  useEffect(() => { if (hold != null && Math.abs(now - hold) < 0.01) setHold(null); }, [now, hold]);
  useEffect(() => { if (hold == null) return; const h = setTimeout(() => setHold(null), 2000); return () => clearTimeout(h); }, [hold]);
  if (!t) return null;
  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
  // How far through the song, as a line along the top in the cover's colour.
  const done = drag ?? hold ?? now;
  const at = (e) => {
    const r = strip.current.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };
  const commit = (f) => { player.seek(f * state.duration); setHold(f); setDrag(null); };
  const scrub = {
    onPointerDown: (e) => { e.stopPropagation(); if (!state.duration) return; strip.current.setPointerCapture?.(e.pointerId); setDrag(at(e)); },
    onPointerMove: (e) => { if (drag != null) setDrag(at(e)); },
    onPointerUp: (e) => { e.stopPropagation(); if (drag != null) commit(at(e)); },
    onPointerCancel: () => setDrag(null),
    // Not a tap on the player, nor a swipe to skip.
    onClick: (e) => e.stopPropagation(),
    onTouchStart: (e) => e.stopPropagation(),
    onKeyDown: (e) => {
      e.stopPropagation();
      const step = state.duration ? 5 / state.duration : 0;
      if (e.key === "ArrowRight") commit(Math.min(1, done + step));
      if (e.key === "ArrowLeft") commit(Math.max(0, done - step));
    },
  };
  return (
    <div class={`mini${drag != null ? " scrubbing" : ""}`} role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === "Enter" && onOpen()}
      aria-label={`Now playing: ${t.title}`} style={accentStyle(t.colors?.accent)} {...slides.gestures}>
      <span class="mini-progress" aria-hidden="true" style={`transform:scaleX(${done})`} />
      <span class="mini-knob" aria-hidden="true" style={`left:${done * 100}%`} />
      <span class="mini-scrub" ref={strip} role="slider" tabIndex={0} aria-label="Position"
        aria-valuemin={0} aria-valuemax={Math.round(state.duration || 0)} aria-valuenow={Math.round(done * (state.duration || 0))}
        aria-valuetext={mmss(done * (state.duration || 0))} {...scrub} />
      {slides.view()}
      <button class={`icon-btn${state.waiting ? " waiting" : ""}`} onClick={stop(() => player.toggle())} aria-label={state.playing ? "Pause" : "Play"}>
        {state.playing ? <Icon.pause size={24} /> : <Icon.play size={24} />}
      </button>
      <button class="icon-btn dim" onClick={stop(next)} disabled={!state.hasNext} aria-label="Next">
        <Icon.next size={16} />
      </button>
    </div>
  );
}

/**
 * The play button in the cover's colour (spec/colors.mjs), with whichever of
 * a dark or light icon reads better on it; a shade for each theme. Without a
 * cover colour, nothing is set and it stays orange.
 */
function accentStyle(accent) {
  if (!accent) return undefined;
  const pal = palette(accent);
  const ink = (rgb) => {
    const [r, g, b] = rgb.split(",").map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.3 ? "#131110" : "#fff";
  };
  return {
    "--np-accent": `rgb(${pal.line.dark})`, "--np-on": ink(pal.line.dark),
    "--np-accent-light": `rgb(${pal.line.light})`, "--np-on-light": ink(pal.line.light),
  };
}

/**
 * A cover that's there at once: the song's own colours (which come with its
 * details, before the picture) as a placeholder with a soft shimmer, and the
 * picture faded in over it once it has loaded. Without colours, the usual
 * gradient; without a picture, just that.
 */
export function Cover({ track, class: cls = "" }) {
  const [state, setState] = useState("loading");   // loading | loaded | failed
  const img = useRef(null);
  useEffect(() => {
    const el = img.current;
    setState(el && el.complete && el.naturalWidth > 0 ? "loaded" : "loading");
  }, [track.art]);
  const c = track.colors;
  const ground = c?.accent ? `background:linear-gradient(150deg,${c.accent} 0%,${c.deep || c.accent} 100%)` : `background:${gradient(track.releaseTitle || track.title)}`;
  const showing = !track.art || state !== "loading";
  return (
    <span class={`${cls} cover${showing ? " shown" : ""}`} style={ground}>
      {track.art && state !== "failed" && (
        <img ref={img} src={track.art} alt="" decoding="async" draggable={false}
          class={state === "loaded" ? "in" : ""} onLoad={() => setState("loaded")} onError={() => setState("failed")} />
      )}
    </span>
  );
}

/** Fetch a cover ahead of time, so it's ready when its song comes on. */
const warmed = new Set();
export function warmCover(track) {
  const url = track?.art;
  if (!url || warmed.has(url) || typeof Image === "undefined") return;
  warmed.add(url);
  const i = new Image();
  i.decoding = "async";
  i.src = url;
}

/**
 * What's playing, sliding over when the song changes: out one side and in
 * from the other — the next song from the right, the one before from the
 * left. A sideways swipe drags it with the finger; let go far enough and it
 * carries on from there, otherwise it springs back. `far` is how far a song
 * travels to be gone (off the screen, for Now playing's cover).
 *
 * `move` is how the caller says which way the next change goes ("next" or
 * "prev"), and where a drag left it, before it skips.
 */
const SLIDE = "transform .34s cubic-bezier(.2, .8, .2, 1)";
function Slides(props) {
  const { gestures, view } = useSlides(props);
  return view(gestures);
}
/** The same, for a caller that wants the swipe on something bigger (the whole mini player). */
function useSlides({ track, move, onNext, onPrev, onUp, far = "100%", class: cls = "", render }) {
  const key = track ? `${track.from}#${track.id}` : "";
  const [layers, setLayers] = useState({ key, old: null, dir: null, run: false });
  const cur = useRef(null);
  const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const last = useRef(track);                    // the song as it was, to slide away

  useEffect(() => {
    if (layers.key === key || !key) return;
    const dir = move.current.dir || "next", from = move.current.x || 0;
    move.current = { dir: null, x: 0 };
    const gone = last.current;
    last.current = track;
    // Nothing before it (the first song, or after stopping): it simply appears.
    if (still || !gone || !layers.key) { setLayers({ key, old: null, dir: null, run: false }); return; }
    setLayers({ key, old: { track: gone, key: layers.key, from }, dir, run: false });
    // The next frame, set them moving; once there, the old one goes.
    const f = requestAnimationFrame(() => requestAnimationFrame(() => setLayers((l) => ({ ...l, run: true }))));
    const t = setTimeout(() => setLayers((l) => ({ ...l, old: null, dir: null, run: false })), 380);
    return () => { cancelAnimationFrame(f); clearTimeout(t); };
  }, [key]);
  // The same song with new details (edited, say): kept, for when it leaves.
  useEffect(() => { last.current = track; }, [track]);

  const follow = (dx) => {
    const el = cur.current;
    if (!el || layers.old) return;
    el.style.transition = "none";
    el.style.transform = `translateX(${dx}px)`;
    move.current.x = dx;
  };
  const back = () => {
    const el = cur.current;
    move.current = { dir: null, x: 0 };
    if (el) { el.style.transition = SLIDE; el.style.transform = ""; }
  };
  const gestures = useSwipe({
    onDrag: (dx) => follow(dx),
    left: () => { if (!onNext()) back(); },
    right: () => { if (!onPrev()) back(); },
    up: onUp ? () => { back(); onUp(); } : undefined,
    onCancel: back,
  });

  const { old, dir, run } = layers;
  const away = (d) => (d === "next" ? `calc(-1 * (${far}))` : `calc(${far})`);   // where a leaving song goes
  const from = (d) => (d === "next" ? `calc(${far})` : `calc(-1 * (${far}))`);   // where an arriving one starts
  const view = (attrs = {}) => track && (
    <div class={`slides ${cls}`} {...attrs}>
      {old && (
        <div class="slide gone" key={old.key} aria-hidden="true"
          style={`transform:translateX(${run ? away(dir) : `${old.from}px`});transition:${run ? SLIDE : "none"}`}>
          {render(old.track, false)}
        </div>
      )}
      <div class="slide" key={key} ref={cur}
        style={old ? `transform:translateX(${run ? "0" : from(dir)});transition:${run ? SLIDE : "none"}` : ""}>
        {render(track, true)}
      </div>
    </div>
  );
  return { gestures, view };
}

/** Is there any way to tip here? Then the coin shows on Now playing. */
export const canTip = (tips) => !!tips && !!(tips.artist || tips.links.length || tips.amply);

/**
 * Tipping the artist, in the sheet Now playing's coin opens: a few amounts,
 * sent from the listener's wallet once confirmed (app.jsx), and any tip links
 * the artist publishes. Amply too, in smaller type, when it takes tips.
 */
export function Tips({ tips }) {
  if (!canTip(tips)) return null;
  const amounts = (send) => TIP_AMOUNTS.map((d) => (
    <button key={d} class="tip-chip" onClick={() => send(d)}>${d}</button>
  ));
  return (
    <section class="tips">
      {(tips.artist || tips.links.length > 0) && <>
        <span class="label">TIP {tips.name.toUpperCase()}</span>
        <div class="tip-row">
          {tips.artist && amounts(tips.artist)}
          {tips.links.map((l) => (
            <a key={l.url} class="pill" href={l.url} target="_blank" rel="noopener">{l.label} <Icon.external size={13} /></a>
          ))}
        </div>
      </>}
      {tips.amply && (
        <div class="tip-amply">
          <span class="mono-dim">TIP AMPLY</span>
          {amounts(tips.amply)}
        </div>
      )}
    </section>
  );
}

export function NowPlaying({ state, player, cost, session, onClose, onArtist, liked, onLike, onAddTo, onShare, onTip, viz, tips, wave = "ribbons", onWave }) {
  const t = state.track;
  if (!t) return null;
  // Scrubbing. A finger anywhere on the line jumps the playhead there and
  // drags it; the music seeks once, on release, and the line holds that spot
  // until the music has caught up rather than flicking back. (A plain range
  // input only moved when its invisible thumb was grabbed, on iOS.)
  const [drag, setDrag] = useState(null);
  const [hold, setHold] = useState(null);
  const strip = useRef(null);
  const at = drag ?? hold ?? state.at;
  const pct = state.duration ? Math.min(100, (at / state.duration) * 100) : 0;
  const timeAt = (e) => {
    const r = strip.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (state.duration || 0);
  };
  const commit = (v) => { player.seek(v); setHold(v); setDrag(null); };
  useEffect(() => { if (hold != null && Math.abs(state.at - hold) < 0.75) setHold(null); }, [state.at, hold]);
  useEffect(() => { if (hold == null) return; const t = setTimeout(() => setHold(null), 2000); return () => clearTimeout(t); }, [hold]);
  const scrub = {
    onPointerDown: (e) => { if (!state.duration) return; strip.current.setPointerCapture?.(e.pointerId); setDrag(timeAt(e)); viz?.start(player.element()); },
    onPointerMove: (e) => { if (drag != null) setDrag(timeAt(e)); },
    onPointerUp: (e) => { if (drag != null) commit(timeAt(e)); },
    onPointerCancel: () => setDrag(null),
    onTouchStart: (e) => e.stopPropagation(),       // a drag here isn't a swipe to close
    onKeyDown: (e) => {
      if (e.key === "ArrowRight") commit(Math.min(state.duration || 0, at + 5));
      if (e.key === "ArrowLeft") commit(Math.max(0, at - 5));
    },
  };
  const repeatOn = state.repeat !== REPEAT.OFF;
  const box = useRef(null);
  // Skipping, and which way the cover should slide. Each says whether the
  // song will change: "previous" more than a few seconds in restarts it,
  // and there may be no next.
  const move = useRef({ dir: null, x: 0 });
  const next = () => {
    if (!state.hasNext) return false;
    move.current.dir = "next"; player.next(); return true;
  };
  const prev = () => {
    const changes = state.hasPrev && (state.at || 0) <= 3;
    if (changes) move.current.dir = "prev";
    player.prev();
    return changes;
  };
  // Closing: pull down anywhere — the art, the controls, the queue — or the
  // chevron. Only the waveform's line (a scrubber) is left out.
  const dismiss = usePullDown(box, onClose, { skip: ".scrub-hit" });
  // Up next: press and hold a song, then drag it into place.
  const queue = useRef(null);
  useReorder(queue, { onMove: (from, to) => player.moveNextTo(from, to) });

  return (
    <div class="np" role="dialog" aria-label="Now playing" ref={box} style={accentStyle(t.colors?.accent)}>
      {/* The first screen: the song and its controls, at least a screen tall,
          so what's next is there on scrolling down, not before. */}
      <div class="np-stage">
      <div class="np-top">
        <button class="np-close" onClick={dismiss} aria-label="Close"><Icon.down size={26} /></button>
      </div>
      <Slides class="np-art" track={t} move={move} onNext={next} onPrev={prev} far="50vw + 50% + 8px"
        render={(song) => <Cover class="art-layer" track={song} />} />
      <div class="np-body">
        <h1>{t.title}</h1>
        <div class="np-who">
          <button class="np-artist" onClick={onArtist}>
            {t.artistName}
            {t.local ? null : t.verified ? <span class="good-ink"><Icon.check size={13} /></span> : <span class="warn-ink"><Icon.warn size={13} /></span>}
          </button>
          {cost.tag && <span class={`badge ${cost.tone}`}>{cost.tag}</span>}
        </div>

        {/* The waveform is the progress bar. Only the line in its middle seeks. */}
        <div class="wave-scrub">
          <Waveform viz={viz} playing={state.playing && !state.waiting} progress={pct / 100} accent={state.track?.colors?.accent} style={wave} />
          <div class="scrub-hit" ref={strip} role="slider" tabIndex={0} aria-label="Position"
            aria-valuemin={0} aria-valuemax={Math.round(state.duration || 0)} aria-valuenow={Math.round(at || 0)}
            aria-valuetext={mmss(at)} {...scrub} />
          <div class="times"><span>{mmss(at)}</span><span>{mmss(state.duration)}</span></div>
        </div>

        <div class="controls">
          <button class={`icon-btn${state.shuffle ? " on" : ""}`} onClick={() => player.toggleShuffle()} aria-label="Shuffle" aria-pressed={state.shuffle}>
            <Icon.shuffle size={20} />
          </button>
          <button class="icon-btn" onClick={prev} aria-label="Previous"><Icon.prev size={24} /></button>
          <button class={`play-big${state.waiting ? " waiting" : ""}`} onClick={() => player.toggle()} aria-label={state.waiting ? "Buffering" : state.playing ? "Pause" : "Play"}>
            {state.playing ? <Icon.pause size={26} /> : <Icon.play size={26} />}
          </button>
          <button class="icon-btn" onClick={next} disabled={!state.hasNext} aria-label="Next"><Icon.next size={24} /></button>
          <button class={`icon-btn${repeatOn ? " on" : ""}`} onClick={() => player.cycleRepeat()}
            aria-label={["Repeat off", "Repeat all", "Repeat one"][state.repeat]}>
            <Icon.repeat size={20} />
            {state.repeat === REPEAT.ONE && <span class="badge-1">1</span>}
          </button>
        </div>

        <div class="np-actions">
          <button class={`icon-btn${liked ? " on" : ""}`} onClick={onLike} aria-label={liked ? "Unlike" : "Like"} aria-pressed={liked}>
            {liked ? <Icon.heartOn size={21} /> : <Icon.heart size={21} />}
          </button>
          <button class="icon-btn" onClick={onAddTo} aria-label="Add to playlist"><Icon.plus size={21} /></button>
          {!t.local && <button class="icon-btn" onClick={onShare} aria-label="Share"><Icon.share size={20} /></button>}
          {canTip(tips) && <button class="icon-btn" onClick={onTip} aria-label={`Tip ${tips.name}`}><Icon.tip size={21} /></button>}
          {session && <span class="mono-dim">{session} this session</span>}
          {/* How the music is drawn: shows the current style; a tap moves to the next. */}
          <button class="icon-btn wave-toggle" onClick={onWave}
            aria-label={`Waveform: ${{ ribbons: "ribbons", boxes: "boxes", hills: "hills" }[wave] || "ribbons"}. Change`}>
            {wave === "boxes" ? <Icon.boxes size={20} /> : wave === "hills" ? <Icon.hills size={21} /> : <Icon.ribbons size={21} />}
          </button>
        </div>

      </div>
      </div>

      <div class="np-more">
        <section class="upnext">
          <div class="label-row">
            <span class="label">UP NEXT</span>
            {state.from && <span class="dim small">{state.from}</span>}
          </div>
          <div class="q-list" ref={queue}>
            {state.upNext?.length ? state.upNext.map((q, k) => (
              <div class="q-row" data-reorder key={`${q.from}#${q.id}#${k}`}>
                <span class="art s40 q-art" style={artStyle(q.art, q.releaseTitle || q.title)} />
                <span class="q-text"><b>{q.title}</b><span>{q.artistName}</span></span>
                <button class="icon-btn dim" onClick={() => player.removeNext(k)} aria-label={`Remove ${q.title}`}><Icon.close size={15} /></button>
              </div>
            )) : <p class="dim small">Nothing queued</p>}
          </div>
        </section>
      </div>
    </div>
  );
}
