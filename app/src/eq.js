/**
 * The equaliser: seven bands between the player and the speakers.
 *
 * Off by default, and nothing is routed through Web Audio until it's first
 * switched on. Routing is one-way for an element (a MediaElementSource can't
 * be undone), and an iPhone pauses Web Audio when locked, so a listener who
 * never touches the EQ keeps exactly the playback they had. Switched off
 * afterwards, every band goes to 0 dB, which passes the sound unchanged.
 *
 * Audio from another origin can only be shaped if it was fetched with CORS,
 * or the browser hands Web Audio silence. Artists' nodes send
 * Access-Control-Allow-Origin: * on everything, so once the EQ is on the
 * element asks with `crossOrigin = "anonymous"`, and the song playing at that
 * moment is fetched again from where it was.
 */

const KEY = "amply.eq.v1";

/** Hz. The ends are shelves, the middle peaks. */
export const BANDS = [60, 150, 400, 1000, 2400, 6000, 15000];
export const RANGE = 12;   // dB either way

export const PRESETS = [
  { id: "flat", name: "Flat", gains: [0, 0, 0, 0, 0, 0, 0] },
  { id: "bass", name: "Bass boost", gains: [6, 4.5, 1.5, 0, 0, 0, 0] },
  { id: "treble", name: "Treble boost", gains: [0, 0, 0, 0, 2, 4.5, 6] },
  { id: "vocal", name: "Vocal", gains: [-2, -1.5, 1, 3.5, 3, 1, -0.5] },
  { id: "loud", name: "Loudness", gains: [5, 3, 0, -1, 0, 3, 4.5] },
  { id: "rock", name: "Rock", gains: [4, 2.5, -1.5, -1, 1.5, 3.5, 4] },
  { id: "pop", name: "Pop", gains: [-1, 1.5, 3, 3.5, 2, 0, -1] },
  { id: "electronic", name: "Electronic", gains: [5, 3.5, 0, -1.5, 1, 3, 4.5] },
  { id: "hiphop", name: "Hip-hop", gains: [5.5, 4, 1, -1, 0.5, 1.5, 2] },
  { id: "jazz", name: "Jazz", gains: [3, 1.5, 0.5, 1.5, -1, 1.5, 3] },
  { id: "classical", name: "Classical", gains: [3.5, 2, 0, -0.5, 0, 2, 3.5] },
  { id: "acoustic", name: "Acoustic", gains: [3, 2, 0.5, 1, 2, 2.5, 2] },
  { id: "night", name: "Late night", gains: [-3, -1, 1, 2, 1, -1, -3] },
  { id: "speakers", name: "Small speakers", gains: [-4, 3.5, 2.5, 1, 0.5, 1, 0] },
];

const clamp = (g) => Math.max(-RANGE, Math.min(RANGE, Math.round(Number(g) * 2) / 2 || 0));

export function loadEq() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    if (s && Array.isArray(s.gains) && s.gains.length === BANDS.length) {
      return { on: !!s.on, preset: typeof s.preset === "string" ? s.preset : "custom", gains: s.gains.map(clamp) };
    }
  } catch { /* storage off or corrupt */ }
  return { on: false, preset: "flat", gains: BANDS.map(() => 0) };
}
export function saveEq(s) {
  try { localStorage.setItem(KEY, JSON.stringify({ on: s.on, preset: s.preset, gains: s.gains })); } catch { /* fine */ }
}
export { clamp as clampGain };

/** The preset these gains are, if any. */
export const presetOf = (gains) => PRESETS.find((p) => p.gains.every((g, i) => Math.abs(g - gains[i]) < 0.01))?.id || "custom";

// ── what it sounds like, drawn ─────────────────────────────────────────────

const Q = 1.05;
/**
 * The combined response in dB at frequency `f`, worked out the way a
 * BiquadFilterNode would (RBJ cookbook), so the curve on screen is what's
 * heard rather than a guess at it.
 */
export function responseAt(f, gains, rate = 48000) {
  let db = 0;
  BANDS.forEach((f0, i) => {
    const g = gains[i];
    if (!g) return;
    const type = i === 0 ? "lowshelf" : i === BANDS.length - 1 ? "highshelf" : "peaking";
    db += 20 * Math.log10(magnitude(type, f0, g, f, rate));
  });
  return db;
}
function magnitude(type, f0, gain, f, rate) {
  const A = Math.pow(10, gain / 40), w0 = (2 * Math.PI * f0) / rate, cos = Math.cos(w0), sin = Math.sin(w0);
  let b0, b1, b2, a0, a1, a2;
  if (type === "peaking") {
    const alpha = sin / (2 * Q);
    b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
  } else {
    // Shelves with S = 1, as Web Audio's lowshelf/highshelf.
    const alpha = (sin / 2) * Math.SQRT2, k = 2 * Math.sqrt(A) * alpha;
    if (type === "lowshelf") {
      b0 = A * ((A + 1) - (A - 1) * cos + k); b1 = 2 * A * ((A - 1) - (A + 1) * cos); b2 = A * ((A + 1) - (A - 1) * cos - k);
      a0 = (A + 1) + (A - 1) * cos + k; a1 = -2 * ((A - 1) + (A + 1) * cos); a2 = (A + 1) + (A - 1) * cos - k;
    } else {
      b0 = A * ((A + 1) + (A - 1) * cos + k); b1 = -2 * A * ((A - 1) + (A + 1) * cos); b2 = A * ((A + 1) + (A - 1) * cos - k);
      a0 = (A + 1) - (A - 1) * cos + k; a1 = 2 * ((A - 1) - (A + 1) * cos); a2 = (A + 1) - (A - 1) * cos - k;
    }
  }
  const w = (2 * Math.PI * f) / rate;
  const re = (c0, c1, c2) => c0 + c1 * Math.cos(w) + c2 * Math.cos(2 * w);
  const im = (c1, c2) => -(c1 * Math.sin(w) + c2 * Math.sin(2 * w));
  const num = Math.hypot(re(b0, b1, b2), im(b1, b2)), den = Math.hypot(re(a0, a1, a2), im(a1, a2));
  return num / den;
}

// ── the sound itself ───────────────────────────────────────────────────────

/** Headroom taken off when bands are raised, so a boost doesn't clip. */
const preampFor = (gains) => -Math.max(0, ...gains) * 0.6;

export function createEq(audio, { onTrouble = () => {} } = {}) {
  let ctx = null, filters = null, pre = null, out = null, volume = 1;
  let state = loadEq();

  // Fetch with CORS from the start if it was left on, so the first song
  // needn't be fetched twice.
  if (state.on && audio) audio.crossOrigin = "anonymous";

  function build() {
    if (filters || !audio) return !!filters;
    const AC = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return false;
    try {
      // A song already loaded without CORS would come through silent: ask
      // for it again, with it, from where it was.
      if (audio.crossOrigin !== "anonymous") {
        const at = audio.currentTime, was = !audio.paused, src = audio.currentSrc || audio.src;
        audio.crossOrigin = "anonymous";
        if (src && !src.startsWith("blob:")) {
          audio.src = src;
          const back = () => { try { audio.currentTime = at; } catch { /* fine */ } audio.removeEventListener("loadedmetadata", back); };
          audio.addEventListener("loadedmetadata", back);
          if (was) audio.play().catch(() => {});
        }
      }
      ctx = new AC();
      // A song from a server that doesn't allow CORS can't be shaped — the
      // browser hands Web Audio silence, or refuses to load it. Say so once
      // per song rather than leave the listener wondering.
      let told = null;
      audio.addEventListener("error", () => {
        const src = audio.currentSrc || audio.src || "";
        // Code 4 is what a refused CORS fetch looks like; a dropped connection isn't this.
        if (audio.error?.code === 4 && src && !src.startsWith("blob:") && told !== src) { told = src; onTrouble(); }
      });
      const source = ctx.createMediaElementSource(audio);
      pre = ctx.createGain();
      filters = BANDS.map((f, i) => {
        const b = ctx.createBiquadFilter();
        b.type = i === 0 ? "lowshelf" : i === BANDS.length - 1 ? "highshelf" : "peaking";
        b.frequency.value = f;
        if (b.type === "peaking") b.Q.value = Q;
        return b;
      });
      // Volume after the filters, in Web Audio: browsers differ on whether an
      // element's own volume still applies once it's routed here.
      out = ctx.createGain();
      out.gain.value = volume;
      audio.volume = 1;
      [source, pre, ...filters, out].reduce((a, b) => (a.connect(b), b)).connect(ctx.destination);
      // A context made outside a tap starts suspended; any play wakes it.
      audio.addEventListener("play", () => ctx.state !== "running" && ctx.resume().catch(() => {}));
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && !audio.paused) ctx.resume().catch(() => {});
      });
      return true;
    } catch {
      filters = null;
      return false;
    }
  }

  function apply(smooth = true) {
    if (!filters) return;
    const gains = state.on ? state.gains : BANDS.map(() => 0);
    const t = ctx.currentTime;
    filters.forEach((b, i) => {
      if (smooth) b.gain.setTargetAtTime(gains[i], t, 0.04); else b.gain.value = gains[i];
    });
    const p = Math.pow(10, preampFor(gains) / 20);
    if (smooth) pre.gain.setTargetAtTime(p, t, 0.04); else pre.gain.value = p;
    if (ctx.state !== "running") ctx.resume().catch(() => {});
  }

  return {
    get: () => state,
    /** Change any of on / preset / gains. Turning it on builds the graph. */
    set(patch) {
      state = { ...state, ...patch, unavailable: false };
      if (patch.gains) state.gains = patch.gains.map(clamp);
      if (state.on && !build()) {
        // No Web Audio here (or it refused): say so, and don't pretend it's on.
        state = { ...state, on: false, unavailable: true };
      }
      saveEq(state);
      if (filters) apply();
      return state;
    },
    /** The volume slider: on the element, or on the graph once there is one. */
    setVolume(v) {
      volume = Math.max(0, Math.min(1, v));
      if (out) { audio.volume = 1; out.gain.setTargetAtTime(volume, ctx.currentTime, 0.02); }
      else if (audio) audio.volume = volume;
    },
    /** If it was left on, connect on the first play (a tap), not before. */
    wake() {
      if (!state.on || filters) return;
      if (build()) apply(false);
      else { state = { ...state, on: false, unavailable: true }; saveEq(state); }
    },
  };
}
