/**
 * The waveform, which is also the progress bar.
 *
 * Three ribbons, one per band, each running the full width but swelling where
 * its frequencies live: bass on the left, treble on the right. Each rises with
 * its own band's loudness, from the song's waves file, so it lands on the
 * beat; all in shades of the cover's colour (or orange). Through the middle
 * runs the progress line — played in that colour, still to come faint — and
 * the ribbons after the playhead are dimmed, so the song reads left to right.
 */
import { useEffect, useRef } from "preact/hooks";
import { EASE_S } from "./visualizer.js";

const LOOK = [
  // where it peaks (0..1 across), cycles across the width, speed, width, dark colour, light colour
  { at: 0.17, cycles: 1.6, speed: 1.3, width: 3.4, dark: "246,113,30", light: "214,86,16" },    // lows
  { at: 0.5, cycles: 3.0, speed: 2.6, width: 2.4, dark: "255,178,90", light: "210,120,30" },    // mids
  { at: 0.83, cycles: 5.6, speed: 4.4, width: 1.5, dark: "255,236,200", light: "150,96,20" },   // highs
];
/** The played line and playhead, without a cover colour. */
const LINE = { dark: "246,113,30", light: "246,113,30" };

// ── colour from the cover ──────────────────────────────────────────────────

function hsl(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), c = max - min, l = (max + min) / 2;
  let h = 0;
  if (c) h = max === r ? ((g - b) / c) % 6 : max === g ? (b - r) / c + 2 : (r - g) / c + 4;
  return { h: (h * 60 + 360) % 360, s: c ? c / (1 - Math.abs(2 * l - 1)) : 0, l };
}
function rgb(h, s, l) {
  s = Math.min(1, s); h = (h + 360) % 360;
  const a = s * Math.min(l, 1 - l), k = (n) => (n + h / 30) % 12;
  return [0, 8, 4].map((n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))))).join(",");
}

/**
 * The ribbons' and the line's colours from a cover's accent (spec/colors.mjs),
 * shaded the way the default oranges are: the bass in the colour itself, the
 * mids lighter and a touch warmer, the highs a pale tint; deeper on a light
 * screen. Without an accent, the default oranges.
 */
export function palette(accent) {
  if (!/^#[0-9a-f]{6}$/i.test(accent || "")) {
    return { dark: LOOK.map((l) => l.dark), light: LOOK.map((l) => l.light), line: LINE };
  }
  const { h, s, l } = hsl(accent);
  const dark = [rgb(h, s, l), rgb(h + 8, s, Math.min(0.74, l + 0.17)), rgb(h + 14, s, 0.89)];
  const light = [rgb(h, s, 0.45), rgb(h + 8, s * 0.8, 0.47), rgb(h + 14, s * 0.75, 0.33)];
  return { dark, light, line: { dark: dark[0], light: light[0] } };
}

/**
 * Between songs, the colour moves from the old cover's to the new one's over
 * about this long, round the colour wheel rather than through grey.
 */
const BLEND_S = 0.18;            // time constant: settled in about half a second
const ORANGE = "#f6711e";        // the default accent, to blend from and to

function hex({ h, s, l }) {
  return "#" + rgb(h, s, l).split(",").map((c) => Number(c).toString(16).padStart(2, "0")).join("");
}
/** One step of the way from `a` to `b` (HSL), `k` of the distance. */
function toward(a, b, k) {
  let dh = ((b.h - a.h + 540) % 360) - 180;            // the short way round
  if (a.s < 0.05) dh = b.h - a.h;                      // from grey, no hue to keep
  return { h: (a.h + dh * k + 360) % 360, s: a.s + (b.s - a.s) * k, l: a.l + (b.l - a.l) * k };
}
const near = (a, b) => Math.abs(((b.h - a.h + 540) % 360) - 180) < 0.5 && Math.abs(a.s - b.s) < 0.004 && Math.abs(a.l - b.l) < 0.004;

const SPREAD = 0.24;    // how wide each band's swell is, as a share of the width
const STEP = 6;         // px between points along a ribbon

// ── boxes ───────────────────────────────────────────────────────────────────
// A level meter in small square boxes: across, the frequencies, bass on the
// left and treble on the right; each column lights as many boxes up from the
// progress line as it's loud, so together the lit ones trace the waveform.
// Their colour, all from the cover's, varies two ways: up each column, from
// a deep shade at the line to a pale, differently tinted top; and across,
// bass leaning one way round the colour wheel and treble the other. Below
// the line, the same again as a shorter, fainter reflection. Unlit boxes
// aren't drawn.
const BOX_PX = 11;        // css px per column, box and gap
const BOX_FILL = 0.76;    // of each cell, the box; the rest is gap
const BOX_ROWS = 4;       // boxes a column can light above the line
const REFLECT_ROWS = 3;   // and below it, as its reflection
const REFLECTION = 0.5;   // how strong the reflection is
const BOX_FLOOR = 0.08;   // a column never quite empties: a hint of its first box
const HUE_UP = 50;        // degrees the hue turns from a column's foot to its top
const HUE_ACROSS = 28;    // and from the bass end to the treble end
// Peaks, from the same eight bands and nothing invented: each column shows the
// band it falls in (no blending between bands, which smoothed them into hills),
// its middle column now and those either side a moment earlier, so a beat is a
// sharp peak that tapers; loud bands are made to stand taller than quiet ones;
// and the whole tapers gently towards both ends, like a waveform.
// And each moment, the columns are measured against each other: those louder
// than the typical column now rise, those below it fall back, so what shows is
// which frequencies lead at that instant, as a spectrum does.
const DETAIL_S = 0.05;    // how much earlier each column away from a band's middle shows
const DETAIL_MAX = 3;     // at most this many steps back
const EDGE_DROP = 0.3;    // a band's outer columns lower, so each band peaks
const RELATIVE = 0.65;    // how much of the typical column's level is taken off
const CONTRAST = 1.2;     // loud against quiet, after that
const SILHOUETTE = 0.28;  // how much lower the two ends sit
/**
 * The frequencies leading at a moment: each level (0..1) measured against the
 * typical one then, so those above it rise and those below fall back; scaled
 * so the loudest reaches the top when the music is loud.
 */
function leading(values) {
  const typical = values.slice().sort((p, q) => p - q)[Math.floor(values.length / 2)];
  const floor = RELATIVE * typical, loud = Math.max(...values), top = Math.max(0.05, loud - floor);
  return values.map((v) => Math.pow(Math.max(0, v - floor) / top * Math.min(1, loud * 1.15), CONTRAST));
}

// ── hills ───────────────────────────────────────────────────────────────────
// Three filled, flowing shapes, one each for the lows, mids and highs, in
// three colours from the cover's: each centred on its own part of the width
// (bass left, treble right) but spreading into the others', like the
// ribbons, overlapping where their colours mix and glow. Each rises with its
// own frequencies (the ribbons' levels), and its outline is a soft moving
// wave that flows faster the louder they are. Below the progress line, a
// reflection of the same wave, a little smaller.
const HILL_HEIGHT = 0.33;   // of the canvas, above the line, at the loudest
const HILL_ECHO = 0.8;      // the reflection below, as a share of that
const HILL_FLOOR = 0.1;     // never quite flat
const HILL_OWN = 0.5;       // how much of what the three share is taken out
const HILL_LIFT = 1.4;      // and a lift after, to fill the space again
const HILL_SPREAD = 70;     // degrees round the colour wheel from the lows to the highs
const HILLS = [
  // where it centres (0..1 across), how wide (sigma, share of the width), waves across it, pace
  { at: 0.2, width: 0.2, cycles: 1.4, pace: 0.65 },   // lows
  { at: 0.5, width: 0.2, cycles: 2.2, pace: 0.95 },   // mids
  { at: 0.8, width: 0.2, cycles: 3.2, pace: 1.3 },    // highs
];
/** Each band's colours, bass to treble: [at the line, at the tip]. */
function hillColours(accent, light, n) {
  const { h, s } = hsl(accent || ORANGE);
  return Array.from({ length: n }, (_, b) => {
    const hue = h + (b / Math.max(1, n - 1) - 0.5) * HILL_SPREAD;
    return light
      ? [rgb(hue, s, 0.48), rgb(hue, s * 0.8, 0.66)]
      : [rgb(hue, s, 0.5), rgb(hue, s * 0.85, 0.72)];
  });
}

/** Every box's colour, column by column and row by row, from the accent. */
function boxColours(accent, light, cols) {
  const { h, s } = hsl(accent || ORANGE);
  return Array.from({ length: cols }, (_, c) => {
    const across = (c / Math.max(1, cols - 1) - 0.5) * HUE_ACROSS;
    return Array.from({ length: BOX_ROWS }, (_, r) => {
      const up = r / (BOX_ROWS - 1);
      const hue = h - HUE_UP * 0.4 + HUE_UP * up + across;
      return light
        ? rgb(hue, s * (0.75 + 0.25 * up), 0.72 - 0.4 * up)
        : rgb(hue, s * (1 - 0.3 * up), 0.34 + 0.54 * Math.pow(up, 1.1));
    });
  });
}

export function Waveform({ viz, playing, progress = 0, accent = null, inset = 20, style = "ribbons" }) {
  const canvas = useRef(null);
  const live = useRef({ playing, progress, accent, style });
  live.current = { playing, progress, accent, style };

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const g = el.getContext("2d");
    const still = matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let raf = 0, nap = 0;
    const t0 = performance.now();
    const shown = LOOK.map(() => 0);
    let dpr = 1, cached = null;

    const size = () => {
      const r = el.getBoundingClientRect();
      // 1.5x is plenty for moving lines, and draws ~44% fewer pixels than 2x.
      dpr = Math.min(1.5, devicePixelRatio || 1);
      el.width = Math.round(r.width * dpr); el.height = Math.round(r.height * dpr);
      cached = null;
    };
    size();
    addEventListener("resize", size);

    // Gradients and each ribbon's swell only change with the size and theme,
    // so work them out once rather than every frame.
    const prepared = (w, h, pad, light, accent) => {
      const key = `${w}x${h}${light}${accent}`;
      const hillsFor = () => {
        // A gradient per band, paler towards the tips on both sides of the line.
        const reach = h * HILL_HEIGHT, n = HILLS.length, a = light ? 0.42 : 0.5;
        const fills = hillColours(accent, light, n).map(([base, tip]) => {
          const grad = g.createLinearGradient(0, h / 2 - reach, 0, h / 2 + reach);
          grad.addColorStop(0, `rgba(${tip},${a})`);
          grad.addColorStop(0.5, `rgba(${base},${a})`);
          grad.addColorStop(1, `rgba(${tip},${a})`);
          return grad;
        });
        const left = pad * 1.2, right = w - pad * 1.2;
        return { reach, fills, left, right };
      };
      const boxesFor = () => {
        // Columns of square cells across the width, centred on the middle line.
        const avail = w - 2 * pad, cols = Math.max(12, Math.min(40, Math.round(avail / (BOX_PX * dpr))));
        const cell = avail / cols, size = cell * BOX_FILL;
        return {
          cols, size, cell, x0: pad + (cell - size) / 2, radius: Math.min(2.5 * dpr, size / 3),
          colours: boxColours(accent, light, cols),
        };
      };
      if (cached?.key === key) return cached;
      const pal = palette(accent), line = light ? pal.line.light : pal.line.dark;
      const lin = (x0, x1, stops) => {
        const grad = g.createLinearGradient(x0, 0, x1, 0);
        stops.forEach(([at, c]) => grad.addColorStop(at, c));
        return grad;
      };
      const fade = pad * 2.2, taper = pad * 1.6;
      const edge = Math.min(0.45, taper / Math.max(1, w - pad * 0.4));
      const faded = (rgb, a) => lin(pad * 0.2, w - pad * 0.2,
        [[0, `rgba(${rgb},0)`], [edge, `rgba(${rgb},${a})`], [1 - edge, `rgba(${rgb},${a})`], [1, `rgba(${rgb},0)`]]);
      const rest = light ? "19,17,16" : "248,244,241";
      const xs = [];
      for (let x = 0; x <= w + STEP; x += STEP) xs.push(x);
      // Pinned at both edges; swelling around the band's own place.
      const shape = LOOK.map((look) => {
        const centre = look.at * w, spread = SPREAD * w;
        return Float32Array.from(xs, (x) => Math.sin((Math.PI * Math.min(x, w)) / w) *
          (0.12 + 0.88 * Math.exp(-((x - centre) ** 2) / (2 * spread * spread))));
      });
      cached = {
        key, fade, xs, shape,
        left: lin(0, fade, [[0, "rgba(0,0,0,1)"], [1, "rgba(0,0,0,0)"]]),
        right: lin(w - fade, w, [[0, "rgba(0,0,0,0)"], [1, "rgba(0,0,0,1)"]]),
        restGlow: faded(rest, light ? 0.05 : 0.06), restLine: faded(rest, light ? 0.16 : 0.2),
        playGlow: faded(line, light ? 0.18 : 0.28), playLine: faded(line, 1),
        ribbons: light ? pal.light : pal.dark, line,
        boxes: boxesFor(),
        hills: hillsFor(),
      };
      return cached;
    };

    let last = performance.now();
    // The colour shown, blending towards the cover's (or the default orange).
    let shownHsl = hsl(live.current.accent || ORANGE);
    const draw = (now) => {
      const w = el.width, h = el.height, t = (now - t0) / 1000;
      // The same easing whether the screen draws at 60 or 120 frames a second.
      const dt = Math.min(0.1, (now - last) / 1000);
      const ease = 1 - Math.exp(-dt / EASE_S);
      last = now;
      // Not laid out yet (or hidden): nothing to draw, try again next frame.
      if (w < 80 || h < 20) { raf = requestAnimationFrame(draw); return; }
      const light = document.documentElement.dataset.theme === "light";
      const pad = inset * dpr, mid = h / 2;
      const head = pad + (w - 2 * pad) * Math.min(1, Math.max(0, live.current.progress || 0));
      const want = hsl(live.current.accent || ORANGE);
      if (!near(shownHsl, want)) shownHsl = toward(shownHsl, want, 1 - Math.exp(-dt / BLEND_S));
      const settled = near(shownHsl, want);
      if (settled) shownHsl = want;
      // Settled, the cover's own colour (or the hand-tuned oranges); between
      // songs, the blend. Gradients are only rebuilt while it's moving.
      const P = prepared(w, h, pad, light, settled ? live.current.accent : hex(shownHsl));
      g.clearRect(0, 0, w, h);

      const real = live.current.playing ? viz?.levels() : null;
      // Without readable audio: a slow breath while playing; paused, it settles flat.
      const levels = real || LOOK.map((_, i) => (live.current.playing ? 0.18 + 0.12 * Math.sin(t * 1.4 - i * 0.6) : 0.02));

      // Eased a touch, to take the jerk out; the levels are read that much ahead to make up for it.
      LOOK.forEach((_, i) => { shown[i] += (levels[i] - shown[i]) * (real ? ease : 0.2); });

      if (live.current.style === "boxes") drawBoxes(P, w, h, mid, t, !!real);
      else if (live.current.style === "hills") drawHills(P, w, h, mid, t, !!real, light, dt);
      else drawRibbons(P, w, h, mid, t, light);

      // Fade out at both edges, where ribbons would stack into a stub.
      g.globalCompositeOperation = "destination-out";
      g.fillStyle = P.left; g.fillRect(0, 0, P.fade, h);
      g.fillStyle = P.right; g.fillRect(w - P.fade, 0, P.fade, h);
      afterRibbons(now, real, settled, P, w, h, mid, pad, head, light);
    };

    const drawRibbons = (P, w, h, mid, t, light) => {
      g.globalCompositeOperation = light ? "source-over" : "lighter";
      LOOK.forEach((look, i) => {
        const amp = h * 0.46 * (0.04 + shown[i]);
        const phase = still ? 0 : t * look.speed;
        const k = (look.cycles * Math.PI * 2) / w;
        const shape = P.shape[i];
        g.beginPath();
        P.xs.forEach((x, j) => {
          const y = mid + amp * shape[j] * (0.65 * Math.sin(x * k + phase) + 0.35 * Math.sin(x * k * 2.1 - phase * 1.3));
          j ? g.lineTo(x, y) : g.moveTo(x, y);
        });
        const c = P.ribbons[i];
        g.strokeStyle = `rgba(${c},${light ? 0.85 : 0.95})`;
        g.lineWidth = look.width * dpr;
        g.stroke();
      });
    };

    /**
     * `cols` levels across, from the eight bands `age` seconds ago: each the
     * band it falls in, its middle column then and those either side a moment
     * earlier and a little lower, so each band peaks and a beat tapers. Null
     * when there's no music to read.
     */
    const sampleColumns = (cols, age = 0) => {
      const past = Array.from({ length: DETAIL_MAX + 1 }, (_, k) => viz.bands(age + k * DETAIL_S));
      const bands = past[0];
      if (!bands) return null;
      return Array.from({ length: cols }, (_, c) => {
        const f = (c / (cols - 1)) * (bands.length - 1), b = Math.round(f);
        const away = Math.abs(f - b) * ((cols - 1) / (bands.length - 1));
        const k = Math.min(DETAIL_MAX, Math.round(away));
        return Math.max(0, (past[k]?.[b] ?? bands[b]) * (1 - EDGE_DROP * Math.min(1, away / 2)));
      });
    };

    const hillPhase = HILLS.map((_, i) => i * 2.1);   // where each shape's wave has flowed to
    const drawHills = (P, w, h, mid, t, playingReal, light, dt) => {
      const H = P.hills, span = H.right - H.left;
      g.globalCompositeOperation = light ? "source-over" : "lighter";
      // Each shape's own share: part of what the three have in common now is
      // taken out, so a beat that lifts everything doesn't lift them as one.
      const common = HILL_OWN * (shown[0] + shown[1] + shown[2]) / 3;
      HILLS.forEach((hill, i) => {
        // Its frequencies' level (the ribbons', eased; a gentle breath with none).
        const level = Math.min(1, HILL_LIFT * Math.max(0, shown[i] - common) / (1 - HILL_OWN));
        // Its wave flows on, quicker the louder it is.
        if (!still) hillPhase[i] += dt * hill.pace * (0.6 + 1.4 * level);
        const ph = hillPhase[i];
        const height = H.reach * (HILL_FLOOR + (1 - HILL_FLOOR) * level);
        const cx = H.left + hill.at * span, sigma = hill.width * span, k = (hill.cycles * Math.PI * 2) / span;
        // Its own part of the width, fading into the others'; pinned at both ends.
        const reach = (x, phase) => {
          const env = Math.exp(-((x - cx) ** 2) / (2 * sigma * sigma)) * Math.pow(Math.sin(Math.PI * Math.max(0, Math.min(1, (x - H.left) / span))), 0.5);
          const wave = 0.62 + 0.24 * Math.sin(x * k + phase) + 0.14 * Math.sin(x * k * 2.3 - phase * 1.4);
          return height * env * wave;
        };
        g.beginPath();
        g.moveTo(H.left, mid);
        for (let x = H.left; x <= H.right; x += STEP) g.lineTo(x, mid - reach(x, ph));
        g.lineTo(H.right, mid);
        // Its reflection below: the same wave, a little smaller.
        for (let x = H.right; x >= H.left; x -= STEP) g.lineTo(x, mid + HILL_ECHO * reach(x, ph));
        g.closePath();
        g.fillStyle = H.fills[i];
        g.fill();
      });
      if (window.__amplyHills) window.__amplyHills.push(HILLS.map((_, i) => Math.min(1, Math.max(0, shown[i] - common) / (1 - HILL_OWN))));   // tests only
    };

    const drawBoxes = (P, w, h, mid, t, playingReal) => {
      const B = P.boxes;
      g.globalCompositeOperation = "source-over";
      const round = typeof g.roundRect === "function";
      const gap = B.cell - B.size;
      const raw = playingReal ? sampleColumns(B.cols) : null;
      // Measured against each other: the columns leading now stand out.
      const led = raw ? leading(raw) : null;
      for (let c = 0; c < B.cols; c++) {
        let v;
        const x = c / (B.cols - 1);
        if (led) {
          v = led[c] * (1 - SILHOUETTE + SILHOUETTE * Math.sin(Math.PI * x));
        } else {
          // No music to read: a slow drift while playing, low and still when not.
          v = live.current.playing ? 0.3 + 0.18 * Math.sin(t * 1.3 + c * 0.35) : 0;
        }
        // How many boxes it lights, the last one partly.
        const lit = (BOX_FLOOR + (1 - BOX_FLOOR) * Math.max(0, Math.min(1, v))) * BOX_ROWS;
        const left = B.x0 + c * B.cell;
        for (let r = 0; r < BOX_ROWS; r++) {
          const fill = Math.min(1, lit - r);
          if (fill <= 0.02) break;
          const colour = B.colours[c][r];
          // Above the line, and (for the first few) its reflection below.
          const at = [[mid - gap / 2 - (r + 1) * B.cell + gap, fill]];
          if (r < REFLECT_ROWS) at.push([mid + gap / 2 + r * B.cell, fill * REFLECTION * (1 - r / REFLECT_ROWS / 1.5)]);
          for (const [y, a] of at) {
            g.fillStyle = `rgba(${colour},${a})`;
            if (round) { g.beginPath(); g.roundRect(left, y, B.size, B.size, B.radius); g.fill(); }
            else g.fillRect(left, y, B.size, B.size);
          }
        }
      }
    };

    const afterRibbons = (now, real, settled, P, w, h, mid, pad, head, light) => {
      // Still to come: dim the ribbons after the playhead. Not the boxes: across,
      // they're frequencies, and cutting them at the playhead only confuses.
      if (live.current.style === "ribbons") {
        g.fillStyle = "rgba(0,0,0,0.55)";
        g.fillRect(head, 0, w - head, h);
      }

      // The progress line through the middle: glowing, and fading in and out
      // at its ends rather than stopping square.
      g.globalCompositeOperation = light ? "source-over" : "lighter";
      g.lineCap = "round";
      const end = w - pad;
      const stroke = (from, to, style, width) => {
        if (to - from < 1) return;
        g.strokeStyle = style; g.lineWidth = width * dpr;
        g.beginPath(); g.moveTo(from, mid); g.lineTo(to, mid); g.stroke();
      };
      stroke(head, end + pad * 0.8, P.restGlow, 9);        // glow, to come
      stroke(head, end + pad * 0.8, P.restLine, 2.5);      // line, to come
      stroke(pad * 0.2, head, P.playGlow, 12);             // glow, played
      stroke(pad * 0.2, head, P.playLine, 3);              // line, played
      // The playhead: a soft halo (a gradient, much cheaper than a blur) and a dot.
      const halo = g.createRadialGradient(head, mid, 0, head, mid, 18 * dpr);
      halo.addColorStop(0, `rgba(${P.line},0.55)`); halo.addColorStop(1, `rgba(${P.line},0)`);
      g.fillStyle = halo;
      g.beginPath(); g.arc(head, mid, 18 * dpr, 0, Math.PI * 2); g.fill();
      g.globalCompositeOperation = "source-over";
      g.fillStyle = light ? "#131110" : "#fff7ef";
      g.beginPath(); g.arc(head, mid, 6.5 * dpr, 0, Math.PI * 2); g.fill();
      next(now, real, settled);
    };
    const next = (now, real, settled) => {
      g.globalCompositeOperation = "source-over";
      if (window.__amplyPerf) window.__amplyPerf.push(performance.now() - now);   // tests only
      // Paused and settled: nothing is moving but the playhead, so redraw a
      // few times a second instead of sixty, and spare the battery.
      const resting = !live.current.playing && Math.max(...shown) < 0.03 && settled;
      if (resting) { raf = 0; nap = setTimeout(() => { raf = requestAnimationFrame(draw); }, 250); }
      else if (!still || !real) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); clearTimeout(nap); removeEventListener("resize", size); };
  }, [viz]);

  return <canvas ref={canvas} class="waveform" aria-hidden="true" />;
}
