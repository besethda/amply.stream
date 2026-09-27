/**
 * A release's colours, taken from its cover art when the artist picks it, so
 * a listening app can tint itself to match without working anything out on
 * the listener's phone — or waiting for the picture to load.
 *
 *   accent  the cover's most prominent vivid colour, made bright enough to
 *           draw with on a dark screen and dark enough on a light one:
 *           for a waveform, a play button, a progress line
 *   deep    the cover's main colour, taken very dark: a background tone
 *
 * Both are `#rrggbb`. A cover with nothing vivid in it (black and white, say)
 * gets no accent, and a client keeps its own. The accent is tuned for a dark
 * screen; on a light one a pale accent (a yellow, say) may need darkening.
 * This is plain arithmetic on pixels; the editor reads them from a shrunken
 * copy of the picture.
 */

const HUES = 24;                 // 15° each
const GREY = 0.12;               // below this chroma a pixel is grey, not a colour
const ACCENT_L = [0.5, 0.66];    // accent lightness, HSL
const ACCENT_S = 0.55;           // at least this saturated
const DEEP_L = 0.13;
const DEEP_S = 0.45;             // at most

export const COLOR_RE = /^#[0-9a-f]{6}$/;

function hsl(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), c = max - min, l = (max + min) / 2;
  let h = 0;
  if (c) {
    if (max === r) h = ((g - b) / c) % 6;
    else if (max === g) h = (b - r) / c + 2;
    else h = (r - g) / c + 4;
    h = (h * 60 + 360) % 360;
  }
  const s = c ? c / (1 - Math.abs(2 * l - 1)) : 0;
  return { h, s, l, c };
}

function hex(h, s, l) {
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return "#" + [0, 8, 4].map((n) => Math.round(f(n) * 255).toString(16).padStart(2, "0")).join("");
}

/**
 * The colours of a picture, from its RGBA pixels (as from a canvas's
 * getImageData). Returns `{ accent?, deep }`, or null for no usable pixels.
 */
export function colorsOf(rgba) {
  // Each hue's pixels: how many, and their colour summed, so the winner is an
  // average of real pixels rather than a bucket's centre.
  const vivid = Array.from({ length: HUES }, () => ({ score: 0, n: 0, r: 0, g: 0, b: 0 }));
  const main = Array.from({ length: HUES }, () => ({ n: 0, r: 0, g: 0, b: 0 }));
  let seen = 0, gr = 0, gg = 0, gb = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;                     // transparent
    const r = rgba[i] / 255, g = rgba[i + 1] / 255, b = rgba[i + 2] / 255;
    const p = hsl(r, g, b);
    seen++; gr += r; gg += g; gb += b;
    const bin = Math.floor(p.h / (360 / HUES)) % HUES;
    if (p.c >= GREY / 2) { const m = main[bin]; m.n++; m.r += r; m.g += g; m.b += b; }
    if (p.c < GREY || p.l < 0.08 || p.l > 0.95) continue;
    // Vivid counts for more than merely present: a small bright red beats a
    // wide dull brown.
    const v = vivid[bin];
    v.score += p.c * p.c; v.n++; v.r += r; v.g += g; v.b += b;
  }
  if (!seen) return null;

  const out = {};
  // Neighbouring hues belong together (a gradient shouldn't split its vote).
  const around = (arr, i, key) => arr[(i + HUES - 1) % HUES][key] * 0.5 + arr[i][key] + arr[(i + 1) % HUES][key] * 0.5;
  let best = -1;
  vivid.forEach((v, i) => { if (v.n && (best < 0 || around(vivid, i, "score") > around(vivid, best, "score"))) best = i; });
  // Worth calling the cover's colour only if it's more than a speck.
  if (best >= 0 && vivid[best].n >= seen * 0.01) {
    const v = vivid[best], p = hsl(v.r / v.n, v.g / v.n, v.b / v.n);
    out.accent = hex(p.h, Math.max(ACCENT_S, p.s), Math.min(ACCENT_L[1], Math.max(ACCENT_L[0], p.l)));
  }

  let lead = -1;
  main.forEach((m, i) => { if (m.n && (lead < 0 || around(main, i, "n") > around(main, lead, "n"))) lead = i; });
  const base = lead >= 0 && main[lead].n >= seen * 0.05
    ? hsl(main[lead].r / main[lead].n, main[lead].g / main[lead].n, main[lead].b / main[lead].n)
    : { ...hsl(gr / seen, gg / seen, gb / seen), s: 0 };   // a grey cover: a neutral dark
  out.deep = hex(base.h, Math.min(DEEP_S, base.s), DEEP_L);
  return out;
}
