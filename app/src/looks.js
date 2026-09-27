/**
 * Small things the screens share: artwork when an artist has none, what was
 * played recently, light or dark, the waveform style, and times and dates.
 */

// ── artwork ─────────────────────────────────────────────────────────────────

/** Warm gradients, picked by a stable hash so an artist keeps theirs. */
const GRADIENTS = [
  ["#f6711e", "#8f2f14", "#2a1108"],
  ["#e9c26c", "#8c5a20", "#2b1c09"],
  ["#7a76cf", "#3b2a57", "#120e1c"],
  ["#d4562a", "#4a1d2e", "#170a12"],
  ["#5fb887", "#1f4a36", "#0b1812"],
  ["#e07a9a", "#5e2440", "#1a0a12"],
];
function hash(text) {
  let h = 0;
  for (const c of String(text || "")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}
/**
 * The same gradient as a picture, for places that need an image rather than a
 * CSS background — the lock screen, when a release has no artwork of its own.
 */
const drawn = new Map();
export function gradientImage(seed, size = 512) {
  const key = `${seed}|${size}`;
  if (drawn.has(key)) return drawn.get(key);
  try {
    const [a, b, c] = GRADIENTS[hash(seed) % GRADIENTS.length];
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    const g = ctx.createLinearGradient(0, 0, size, size);
    g.addColorStop(0, a); g.addColorStop(0.52, b); g.addColorStop(1, c);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const url = canvas.toDataURL("image/png");
    drawn.set(key, url);
    return url;
  } catch {
    return null;   // no canvas here (tests, very old browsers)
  }
}

export function gradient(seed) {
  const [a, b, c] = GRADIENTS[hash(seed) % GRADIENTS.length];
  return `linear-gradient(150deg,${a} 0%,${b} 52%,${c} 100%)`;
}
/**
 * An address safe to put in a style: parsed, https (or a picture made on this
 * phone, data: or blob:), and written back out by the parser, which escapes
 * quotes and drops the line breaks a listing could hide in one. Given raw, a
 * line break ends the url() early and the rest becomes styling of the
 * artist's choosing: a picture stretched over the whole app, say, looking
 * like a prompt.
 */
export function styleUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(String(url));
    if (!["https:", "data:", "blob:"].includes(u.protocol)) return null;
    return u.href.replace(/["\\()\s]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
  } catch { return null; }
}

/** A background for an image slot: the picture if there is one, else a gradient. */
export const artStyle = (url, seed) => {
  const safe = styleUrl(url);
  return safe ? `background:${gradient(seed)} center/cover;background-image:url("${safe}")` : `background:${gradient(seed)}`;
};

// ── recently played ─────────────────────────────────────────────────────────

const RECENT = "amply.recent.v1";
const read = (key, fallback) => {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
};
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* fine */ } };

export const recent = () => read(RECENT, []);
/** Forget a song was played (it's gone). */
export const forgetRecent = (t) => write(RECENT, recent().filter((r) => !(r.id === t.id && r.from === t.from)));

/** Remember a song was played: newest first, each once, twenty at most. */
export function played(track) {
  if (!track?.id || !track?.from) return;
  const next = [{ id: track.id, from: track.from }, ...recent().filter((r) => !(r.id === track.id && r.from === track.from))];
  write(RECENT, next.slice(0, 20));
}

// ── light or dark ───────────────────────────────────────────────────────────

const THEME = "amply.theme";
export const theme = () => (read(THEME, "dark") === "light" ? "light" : "dark");
export function applyTheme(name = theme()) {
  try {
    document.documentElement.dataset.theme = name;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", name === "light" ? "#ffffff" : "#0f0d0c");
  } catch { /* not in a browser */ }
}
export function setTheme(name) { write(THEME, name); applyTheme(name); }

/** How Now playing draws the music: ribbons, boxes coloured by loudness, or hills. */
const WAVE = "amply.wave";
export const WAVE_STYLES = ["ribbons", "boxes", "hills"];
export const waveStyle = () => (WAVE_STYLES.includes(read(WAVE, "ribbons")) ? read(WAVE, "ribbons") : "ribbons");
export const setWaveStyle = (name) => write(WAVE, name);

// ── time and dates ──────────────────────────────────────────────────────────

export const mmss = (s) =>
  (Number.isFinite(s) && s >= 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s) % 60).padStart(2, "0")}` : "–");

/** New enough to call new: out in the last six weeks. */
export const isNew = (date, now = Date.now()) => {
  const t = Date.parse(date || "");
  return Number.isFinite(t) && now - t < 42 * 86400e3 && t <= now + 86400e3;
};
