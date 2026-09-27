/**
 * Colours from cover art: the vivid colour wins over the big dull one, greys
 * give no accent, and what comes out is usable on both themes.
 *
 * Run via `npm run test:pricing` (with the other spec tests).
 */
import { colorsOf, COLOR_RE } from "./colors.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

/** A 40×40 picture from [share, [r,g,b,a?]] parts. */
function picture(parts) {
  const px = [];
  for (const [share, [r, g, b, a = 255]] of parts) for (let i = 0; i < Math.round(share * 1600); i++) px.push(r, g, b, a);
  return new Uint8ClampedArray(px);
}
const hueOf = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), c = max - min;
  if (!c) return null;
  const h = max === r ? ((g - b) / c) % 6 : max === g ? (b - r) / c + 2 : (r - g) / c + 4;
  return (h * 60 + 360) % 360;
};
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const DARK = "#131110", LIGHT = "#f7f3ef";   // the listener app's grounds

// Mostly dull brown and black, with a patch of bright red.
const moody = colorsOf(picture([[0.55, [90, 70, 55]], [0.3, [10, 10, 12]], [0.15, [230, 30, 40]]]));
ok("the vivid red wins over the big dull brown", Math.abs(hueOf(moody.accent) - 356) < 12 || hueOf(moody.accent) < 8, moody.accent);
ok("  and the background tone comes from the brown", hueOf(moody.deep) > 15 && hueOf(moody.deep) < 45, moody.deep);
ok("  both are #rrggbb", COLOR_RE.test(moody.accent) && COLOR_RE.test(moody.deep));

// A cool blue cover.
const blue = colorsOf(picture([[0.7, [30, 60, 140]], [0.3, [200, 220, 240]]]));
ok("a blue cover gets a blue accent", hueOf(blue.accent) > 205 && hueOf(blue.accent) < 235, blue.accent);

// A very dark, barely-coloured cover still gets an accent bright enough to see.
const dim = colorsOf(picture([[0.9, [8, 8, 8]], [0.1, [60, 20, 90]]]));
ok("a dark cover's accent is lifted to be seen", dim.accent && contrast(dim.accent, DARK) >= 3, `${dim.accent}, ${dim.accent && contrast(dim.accent, DARK).toFixed(1)}:1`);

// Pale pastel: lowered to be seen on the light theme too.
const pale = colorsOf(picture([[1, [250, 210, 225]]]));
ok("a pale cover's accent is deepened", pale.accent && contrast(pale.accent, LIGHT) >= 2, `${pale.accent}, ${pale.accent && contrast(pale.accent, LIGHT).toFixed(1)}:1`);

for (const [name, c] of [["moody", moody], ["blue", blue], ["dim", dim], ["pale", pale]]) {
  ok(`${name}: accent readable on the dark theme`, contrast(c.accent, DARK) >= 3, contrast(c.accent, DARK).toFixed(1));
  ok(`${name}: background tone is dark`, lum(c.deep) < 0.03, c.deep);
}

// Black and white: no accent — the app keeps its own.
const mono = colorsOf(picture([[0.5, [0, 0, 0]], [0.3, [255, 255, 255]], [0.2, [128, 128, 128]]]));
ok("black and white: no accent", mono && !("accent" in mono), JSON.stringify(mono));
ok("  and a neutral background tone", mono.deep && hueOf(mono.deep) === null, mono.deep);

// A speck of colour isn't the cover's colour.
const speck = colorsOf(picture([[0.995, [20, 20, 20]], [0.005, [255, 0, 0]]]));
ok("a speck of colour doesn't count", !("accent" in speck), speck.accent);

ok("transparent pixels are ignored", colorsOf(picture([[1, [255, 0, 0, 0]]])) === null);

// The manifest rules: colours are optional, and a malformed one is refused.
const { validate } = await import("./manifest-rules.mjs");
const { readFile } = await import("node:fs/promises");
const example = JSON.parse(await readFile(new URL("./example.json", import.meta.url), "utf8"));
ok("an example with colours is valid", validate(example).errors.length === 0, JSON.stringify(validate(example).errors));
example.releases[0].colors = { accent: "red", deep: "#2A1A12" };
const errs = validate(example).errors.map((e) => e.path || JSON.stringify(e)).join(" ");
ok("a malformed colour is refused", /colors\.accent/.test(errs) && /colors\.deep/.test(errs), errs);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
