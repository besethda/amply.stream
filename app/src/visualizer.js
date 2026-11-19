/**
 * How loud the lows, mids and highs are at any moment of the song, for the
 * waveform on Now playing.
 *
 * **Read, not worked out.** The artist's editor analyses each song once, at
 * upload, into a small waves file beside it (spec/waves.mjs): loudness in a
 * handful of frequency bands, many times a second. Here that file is fetched
 * — kilobytes, never the song a second time — and folded into the waveform's
 * three ribbons. While the song plays, the waveform looks up the value at its
 * current time: exact on every browser, nothing to keep in step, and nothing
 * worked out on the phone beyond a lookup.
 *
 * A song without a waves file (uploaded before they existed, or from a
 * service that doesn't make them) gets `levels()` null, and the drawing falls
 * back to a gentle idle motion.
 */
import { readWaves } from "../../spec/waves.mjs";

/** The ribbons, by the frequencies they gather: a band belongs to the ribbon its middle falls in. */
export const RIBBONS = [
  { name: "lows", below: 250 },
  { name: "mids", below: 4000 },
  { name: "highs", below: Infinity },
];
export const STAGGER_MS = 20;       // lows a touch ahead, highs a touch behind — centred on the beat
const RELEASE_S = 0.16;             // how long a hit takes to fall away
/**
 * The drawing eases towards each level over about this long, to take the
 * edge off; levels are read this far ahead so the easing doesn't make it late.
 */
export const EASE_S = 0.035;
const CEILING_AT = 0.97;            // a ribbon's 1 is how loud it gets in the loud parts
const CACHE = 6;                    // songs kept ready
const MAX_BYTES = 2 * 1048576;      // a waves file bigger than this isn't one

/**
 * Fold a waves file's bands into the three ribbons, once per song: each
 * ribbon's loudness per frame, rising at once to a hit and falling away over
 * RELEASE_S, scaled so the song's loud parts reach 1.
 */
export function ribbonsOf(w) {
  const N = w.bands.length, F = w.frames;
  const home = w.bands.map(([from, to]) => {
    const middle = Math.sqrt(Math.max(from, 20) * to);
    return RIBBONS.findIndex((r) => middle < r.below);
  });
  const fall = Math.exp(-1 / (w.fps * RELEASE_S));
  const env = RIBBONS.map((_, r) => {
    const out = new Float32Array(F);
    let last = 0;
    for (let i = 0; i < F; i++) {
      // Back to real loudness (the file keeps each band on its own scale and
      // square-rooted), then the ribbon's bands added as energy.
      let energy = 0;
      for (let b = 0; b < N; b++) {
        if (home[b] !== r) continue;
        const v = w.levels[i * N + b] / 255;
        const rms = v * v * w.ceilings[b];
        energy += rms * rms;
      }
      last = Math.max(Math.sqrt(energy), last * fall);
      out[i] = last;
    }
    return toCeiling(out);
  });
  return { fps: w.fps, frames: F, env };
}

/**
 * Scale a loudness curve so the song's loud parts reach 1: the level at the
 * CEILING_AT point of its own distribution becomes the top, and everything is
 * eased by a gentle curve beneath it. In place, and returned.
 */
function toCeiling(out) {
  const F = out.length;
  const sorted = Array.from(out).sort((p, q) => p - q);
  const ceiling = sorted[Math.min(F - 1, Math.floor(F * CEILING_AT))] || 0;
  for (let i = 0; i < F; i++) out[i] = ceiling > 0 ? Math.pow(Math.min(1, out[i] / ceiling), 0.8) : 0;
  return out;
}

/**
 * Every band of a waves file on its own, low to high, for styles that show
 * more than three ribbons: each band's loudness per frame, rising at once and
 * falling away over RELEASE_S, scaled so the song's loud parts reach 1.
 */
export function bandsOf(w) {
  const N = w.bands.length, F = w.frames;
  const fall = Math.exp(-1 / (w.fps * RELEASE_S));
  const env = w.bands.map((_, b) => {
    const out = new Float32Array(F);
    let last = 0;
    for (let i = 0; i < F; i++) {
      const v = w.levels[i * N + b] / 255;
      last = Math.max(v * v, last * fall);          // back to linear loudness
      out[i] = last;
    }
    return toCeiling(out);
  });
  return { fps: w.fps, frames: F, env };
}

/**
 * How loud the whole song is, moment by moment, all bands together: the shape
 * the desktop player's progress bar draws, so the quiet intro, the drop and
 * the fade-out can be seen (and jumped to) before they're heard. Each frame's
 * bands are put back on one scale (their ceilings) and added as energy, then
 * the curve is scaled so the song's loud parts reach 1.
 */
export function wholeOf(w) {
  const N = w.bands.length, F = w.frames;
  const out = new Float32Array(F);
  for (let i = 0; i < F; i++) {
    let energy = 0;
    for (let b = 0; b < N; b++) {
      const v = w.levels[i * N + b] / 255;
      const rms = v * v * w.ceilings[b];
      energy += rms * rms;
    }
    out[i] = Math.sqrt(energy);
  }
  return { fps: w.fps, frames: F, curve: toCeiling(out) };
}

/**
 * The song's shape in `n` columns, each the loudness of its stretch of the
 * song: mostly its peak, a little of its average, so a single snare doesn't
 * make a quiet passage look loud.
 */
export function columnsOf(whole, n) {
  const { curve, frames } = whole;
  const out = new Float32Array(n);
  for (let c = 0; c < n; c++) {
    const from = Math.floor((c / n) * frames), to = Math.max(from + 1, Math.floor(((c + 1) / n) * frames));
    let peak = 0, sum = 0;
    for (let i = from; i < to && i < frames; i++) { peak = Math.max(peak, curve[i]); sum += curve[i]; }
    out[c] = 0.7 * peak + 0.3 * (sum / Math.max(1, to - from));
  }
  return out;
}

/** Ribbon `r`'s level (0..1) at `t` seconds into the song, between frames. */
export function levelAt(s, r, t) {
  const f = t * s.fps - 0.5;   // values sit mid-frame
  const i = Math.floor(f);
  if (i < -1 || i >= s.frames) return 0;
  const at = (k) => (k < 0 || k >= s.frames ? 0 : s.env[r][k]);
  return at(i) + (at(i + 1) - at(i)) * (f - i);
}

export function createVisualizer({ get = (url) => fetch(url, { priority: "low" }) } = {}) {
  const ready = new Map();        // waves URL → ribbons, or a promise of them
  let main = null, current = null;

  function load(url) {
    if (!url || ready.has(url)) return;
    const pending = (async () => {
      const res = await get(url);
      if (!res.ok) throw new Error(`waves ${res.status}`);
      const bytes = await res.arrayBuffer();
      if (bytes.byteLength > MAX_BYTES) throw new Error("too big to be a waves file");
      const w = readWaves(bytes);
      return { ribbons: ribbonsOf(w), bands: bandsOf(w), whole: wholeOf(w) };
    })().then(
      (s) => { ready.set(url, s); return s; },
      () => { ready.delete(url); return null; },   // shown as the idle motion; tried again next time
    );
    ready.set(url, pending);
    while (ready.size > CACHE) ready.delete(ready.keys().next().value);
  }

  return {
    /** Follow `audio`'s clock. */
    start(audio) { main = audio; return true; },
    stop() { /* nothing runs between frames */ },
    /** The song now playing; its waves are fetched if they aren't already. */
    show(track) { current = track?.waves || null; load(current); },
    /** Fetch a song's waves ahead of time — the next one up, say. */
    prefetch(track) { load(track?.waves); },
    /** One level per ribbon, 0..1; or null when there's nothing to show. */
    levels() {
      const s = current && ready.get(current);
      if (!s || s instanceof Promise || !main) return null;
      const t = main.currentTime;
      return RIBBONS.map((_, r) => levelAt(s.ribbons, r, t + EASE_S + ((1 - r) * STAGGER_MS) / 1000));
    },
    /**
     * The current song's shape across `n` columns (see columnsOf), or null
     * while its waves are on their way, or when it has none.
     */
    overview(n) {
      const s = current && ready.get(current);
      if (!s || s instanceof Promise || !s.whole) return null;
      if (!s.columns || s.columns.length !== n) s.columns = columnsOf(s.whole, n);
      return s.columns;
    },
    /** How loud the whole song is right now, 0..1; or null. */
    loudness() {
      const s = current && ready.get(current);
      if (!s || s instanceof Promise || !main || !s.whole) return null;
      const w = s.whole, f = (main.currentTime + EASE_S) * w.fps - 0.5, i = Math.floor(f);
      const at = (k) => (k < 0 || k >= w.frames ? 0 : w.curve[k]);
      return at(i) + (at(i + 1) - at(i)) * (f - i);
    },
    /** Which song's waves are showing: changes when a new song's arrive. */
    key() {
      const s = current && ready.get(current);
      return s && !(s instanceof Promise) ? current : null;
    },
    /**
     * Every band's level (0..1), low to high, `ago` seconds before now; or
     * null when there's nothing to show.
     */
    bands(ago = 0) {
      const s = current && ready.get(current);
      if (!s || s instanceof Promise || !main) return null;
      const t = main.currentTime + EASE_S - ago;
      return s.bands.env.map((_, b) => levelAt(s.bands, b, t));
    },
  };
}
