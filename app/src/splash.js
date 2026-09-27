/**
 * The logo that covers the app while it starts (index.html), and again when
 * it's come back to after a long while: long enough to check it's the latest
 * version, and for the fonts to arrive so nothing jumps. Never longer than a
 * moment, whatever the connection.
 */
export const START_MS = 2000;     // on opening: at most this long
export const RESUME_MS = 1500;    // on coming back: at most this long

const el = () => document.getElementById("splash");

export function hideSplash() {
  const s = el();
  if (!s || s.classList.contains("gone")) return;
  s.classList.add("gone");
}

export function showSplash() {
  el()?.classList.remove("gone");
}

/**
 * The app's fonts, loaded: their stylesheet (added by main.jsx), then the
 * font files it names. Resolves either way, never rejects.
 */
export function fontsLoaded() {
  const link = document.querySelector('link[href*="fonts.googleapis.com/css2"]');
  const sheet = !link || link.sheet ? Promise.resolve()
    : new Promise((resolve) => { link.addEventListener("load", resolve); link.addEventListener("error", resolve); });
  return sheet.then(() => document.fonts?.ready).catch(() => {});
}

/**
 * The pictures on the screen the app opens to — cover art, artists' photos —
 * loaded and decoded, so the page is complete the moment the logo lifts.
 * Only what's in view: anything further down can load as it's scrolled to.
 * Resolves either way, never rejects.
 */
export function imagesInView(root = document.getElementById("app")) {
  const urls = new Set();
  const h = innerHeight, w = innerWidth;
  for (const el of root?.querySelectorAll("*") || []) {
    const r = el.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= h || r.right <= 0 || r.left >= w || !r.width || !r.height) continue;
    if (el.tagName === "IMG" && el.currentSrc) urls.add(el.currentSrc);
    const bg = getComputedStyle(el).backgroundImage;
    if (bg && bg !== "none") for (const m of bg.matchAll(/url\(["']?(.*?)["']?\)/g)) urls.add(m[1]);
  }
  return Promise.all([...urls].filter((u) => !u.startsWith("data:")).map((src) => {
    const img = new Image();
    img.src = src;
    return (img.decode ? img.decode() : new Promise((resolve) => { img.onload = img.onerror = resolve; })).catch(() => {});
  }));
}

/** The next frame, once the page has been laid out. */
export const laidOut = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

/**
 * Keep the logo up while `work` runs, for at most `ms`; then take it away,
 * unless the work says the app is reloading (so the old one never flashes).
 */
export async function behindSplash(work, ms) {
  const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
  const result = await Promise.race([Promise.resolve().then(work).catch(() => "failed"), timeout]);
  if (result !== "reloaded") hideSplash();
  return result;
}
