#!/usr/bin/env node
// Preview + screenshot harness for the Amply listener app.
//   node app/preview/shoot.mjs --width 1440 --height 900 --theme dark --out /tmp/shots [--scenario all|home,library,...]
//   node app/preview/shoot.mjs --serve [--port 8123]
// Serves site/ on localhost, mocks artist nodes (https://*.example) from fixtures/, seeds localStorage.
import http from "node:http";
import { readFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { join, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, "..", "..", "site");
const FIX = join(HERE, "fixtures");

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt; };
const flag = (name) => argv.includes(`--${name}`);
const WIDTH = +opt("width", 1440), HEIGHT = +opt("height", 900);
const THEME = opt("theme", "dark") === "light" ? "light" : "dark";
const OUT = opt("out", join(HERE, "shots"));
const SCEN = opt("scenario", "all").split(",");
const TIMEOUT = +opt("timeout", 25000);

// ── static server ───────────────────────────────────────────────────────────
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ico": "image/x-icon", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".waves": "application/octet-stream", ".txt": "text/plain" };
function startServer(port = 0) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    let file = normalize(join(SITE, p));
    if (!file.startsWith(SITE)) { res.writeHead(403).end(); return; }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file) && !extname(file) && existsSync(file + ".html")) file += ".html";
    if (!existsSync(file)) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(readFileSync(file));
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r({ server, url: `http://localhost:${server.address().port}` })));
}

if (flag("serve")) {
  const { url } = await startServer(+opt("port", 8123));
  console.log(`Serving ${SITE}\n  ${url}/app/`);
  await new Promise(() => {});
}

// ── fixtures ────────────────────────────────────────────────────────────────
if (!existsSync(join(FIX, "hollowcoast.example", "manifest.json"))) {
  console.log("generating fixtures (one-off, ~2 min)...");
  for (const cmd of [["python3", ["-I", join(HERE, "make_fixtures.py")]], ["node", [join(HERE, "make_waves.mjs")]]]) {
    const r = spawnSync(cmd[0], cmd[1], { stdio: "inherit" });
    if (r.status) process.exit(1);
  }
}
const HOSTS = ["hollowcoast.example", "mira-vale.example", "the-quiet-hours.example", "ostra.example"];
const manifests = Object.fromEntries(HOSTS.map((h) => [h, JSON.parse(readFileSync(join(FIX, h, "manifest.json"), "utf8"))]));
const mUrl = (h) => `https://${h}/manifest.json`;
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,HEAD,OPTIONS", "access-control-expose-headers": "*", "accept-ranges": "bytes" };
const unknown = new Set();

async function mockHandler(route, localOrigin) {
  const req = route.request();
  const u = new URL(req.url());
  if (u.origin === localOrigin || u.protocol === "data:" || u.protocol === "blob:") return route.continue();
  // Solana RPC: the app asks the fees account's balance before it shows prices; say it is well funded.
  if (u.hostname === "solana-rpc.publicnode.com" && req.method() === "POST")
    return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: 50_000_000 } }) });
  if (!HOSTS.includes(u.hostname)) return route.abort("blockedbyclient");
  if (u.pathname === "/listen/fees" && manifests[u.hostname].payment)
    return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ feePayer: "FeeP4yer1111111111111111111111111111111111", network: "solana", minMicros: 10000, maxMicros: 2000000 }) });
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
  const file = normalize(join(FIX, u.hostname, u.pathname));
  if (file.startsWith(join(FIX, u.hostname)) && existsSync(file) && statSync(file).isFile()) {
    let body = readFileSync(file);
    const type = MIME[extname(file)] || "application/octet-stream";
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers()["range"] || "");
    if (range) {
      const start = range[1] ? +range[1] : 0, end = Math.min(body.length - 1, range[2] ? +range[2] : body.length - 1);
      return route.fulfill({ status: 206, body: body.subarray(start, end + 1), headers: { ...CORS, "content-type": type, "content-range": `bytes ${start}-${end}/${body.length}` } });
    }
    return route.fulfill({ status: 200, body, headers: { ...CORS, "content-type": type } });
  }
  const key = `${req.method()} ${u.hostname}${u.pathname}`.replace(/[0-9a-f]{20,}/g, ":id");
  if (!unknown.has(key)) { unknown.add(key); console.log(`[unknown path] ${key}`); }
  return route.fulfill({ status: 404, headers: { ...CORS, "content-type": "application/json" }, body: "{}" });
}

// ── seed data ───────────────────────────────────────────────────────────────
function seedData() {
  const now = Date.now(), day = 86400e3;
  const library = HOSTS.map((h, i) => ({ url: mUrl(h), manifest: manifests[h], added: now - i * day, followed: true, lastSeen: now }));
  const tr = (h, n) => { const all = manifests[h].releases.flatMap((r) => r.tracks); return { from: mUrl(h), id: all[n].id }; };
  const likes = [tr("hollowcoast.example", 0), tr("mira-vale.example", 1), tr("the-quiet-hours.example", 2), tr("ostra.example", 0), tr("hollowcoast.example", 7), tr("mira-vale.example", 5), tr("the-quiet-hours.example", 0)];
  const playlists = [
    { id: "pl_preview1", name: "Late night drive", created: now - 3 * day, tracks: [tr("mira-vale.example", 1), tr("ostra.example", 1), tr("hollowcoast.example", 1), tr("the-quiet-hours.example", 3), tr("mira-vale.example", 3)] },
    { id: "pl_preview2", name: "Rainy Sunday", created: now - 9 * day, tracks: [tr("the-quiet-hours.example", 0), tr("the-quiet-hours.example", 1), tr("hollowcoast.example", 4), tr("the-quiet-hours.example", 5)] },
  ];
  const recent = [tr("hollowcoast.example", 2), tr("mira-vale.example", 0), tr("ostra.example", 2), tr("the-quiet-hours.example", 4), tr("hollowcoast.example", 8)];
  return { library, likes, playlists, recent };
}

// ── scenarios ───────────────────────────────────────────────────────────────
// All UI steps live here. Prefer text-based clicks; `clickText` is forgiving.
const S = {
  async goHome(page) { await page.goto(BASE + "/app/", { waitUntil: "domcontentloaded" }); await ready(page); },
  async tab(page, name) { await page.locator(".d-menu-item, nav.tabs button, [role=tab]").filter({ hasText: new RegExp(`^\\s*${name}\\s*$`, "i") }).first().click({ timeout: 6000 }); await settle(page); },
  async playFirstTrack(page) {
    // Tap a track row in the current view (first "Hollow Coast" album page track), then wait for audio time to advance.
    await page.locator(".track-main").first().click({ timeout: 6000 });
    await page.waitForFunction(() => [...document.querySelectorAll("audio")].some((a) => a.currentTime > 1.5), null, { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(1500);
  },
};
let BASE = "";
async function ready(page) {
  await page.waitForFunction(() => /Home/.test(document.body.innerText) && /Library/.test(document.body.innerText) && document.querySelectorAll("img, [style*=background]").length > 0, null, { timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector("#splash") || document.querySelector("#splash").classList.contains("gone") || getComputedStyle(document.querySelector("#splash")).opacity === "0", null, { timeout: 8000 }).catch(() => {});
  await settle(page);
}
const settle = (page, ms = 900) => page.waitForLoadState("networkidle", { timeout: 1500 }).catch(() => {}).then(() => page.waitForTimeout(ms));
async function clickText(page, text, { nth = 0, exact = false } = {}) {
  const loc = page.getByText(text, { exact }).filter({ visible: true });
  await loc.nth(nth).click({ timeout: 6000 });
  await settle(page);
}
const back = async (page) => { await page.locator('button[aria-label="Back"], .back, button:has-text("Back")').first().click({ timeout: 3000 }).catch(() => page.goBack().catch(() => {})); await settle(page); };

// name → async (page) steps; screenshot is taken after the steps run.
const toAlbum = async (page, title = "Longwave") => { await S.goHome(page); await clickText(page, title, { exact: true }); };   // Home > Latest card
const toArtist = async (page, name = "Hollow Coast") => { await S.goHome(page); await S.tab(page, "Library"); await clickText(page, "Artists", { exact: true }); await clickText(page, name, { exact: true }); };
const SCENARIOS = {
  // debug helper: prints clickable elements (tag.class "text") so selectors can be fixed after UI changes
  dom: async (page) => {
    await S.goHome(page);
    console.log(await page.evaluate(() => [...document.querySelectorAll("a,button,[role=button],[role=tab],nav,audio")].filter((e) => e.offsetParent !== null || e.tagName === "AUDIO")
      .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).replace(/\s+/g, ".")} ${e.getAttribute("aria-label") || ""} "${(e.textContent || "").trim().slice(0, 30)}"`).join("\n")));
  },
  home: async (page) => { await S.goHome(page); },
  library: async (page) => { await S.goHome(page); await S.tab(page, "Library"); },
  "library-songs": async (page) => { await S.goHome(page); await S.tab(page, "Library"); await page.locator(".seg", { hasText: "Songs" }).first().click(); await page.waitForTimeout(400); },
  "library-albums": async (page) => { await S.goHome(page); await S.tab(page, "Library"); await page.locator(".seg", { hasText: "Albums" }).first().click(); await page.waitForTimeout(400); },
  "library-artists": async (page) => { await S.goHome(page); await S.tab(page, "Library"); await page.locator(".seg", { hasText: "Artists" }).first().click(); await page.waitForTimeout(400); },
  you: async (page) => { await S.goHome(page); await S.tab(page, "You"); await clickText(page, "Wallet", { exact: true }).catch(() => {}); },
  general: async (page) => { await S.goHome(page); await S.tab(page, "You"); await clickText(page, "General", { exact: true }); await clickText(page, "Bass boost", { exact: true }); await page.waitForTimeout(300); },
  artist: async (page) => { await toArtist(page); },
  album: async (page) => { await toAlbum(page); },
  playlist: async (page) => { await S.goHome(page); await S.tab(page, "Library"); await clickText(page, "Late night drive"); },
  "home-playing": async (page) => { await toAlbum(page); await S.playFirstTrack(page); await S.tab(page, "Home"); },
  // Mobile: tapping .mini opens the full-screen player. Desktop: the right-hand "Now playing" panel is already open once a song plays.
  nowplaying: async (page) => {
    await toAlbum(page); await S.playFirstTrack(page);
    if (await page.locator(".mini").count()) await page.locator(".mini").first().click({ timeout: 6000 });
    await page.waitForTimeout(2500);
  },
  // Desktop only: the expanded full-window player ("Open now playing" button in the player bar); on mobile same as nowplaying.
  "nowplaying-full": async (page) => {
    await toAlbum(page); await S.playFirstTrack(page);
    const open = page.locator('.mini, button[aria-label="Open now playing"]').first();
    await open.click({ timeout: 6000 });
    await page.waitForTimeout(2500);
  },
};

// ── run ─────────────────────────────────────────────────────────────────────
const { server, url } = await startServer(0);
BASE = url;
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio=false"] });
const names = SCEN.includes("all") ? Object.keys(SCENARIOS).filter((n) => n !== "dom") : SCEN;
let failures = 0;
for (const name of names) {
  if (!SCENARIOS[name]) { console.log(`unknown scenario ${name}; have: ${Object.keys(SCENARIOS).join(", ")}`); failures++; continue; }
  const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1, serviceWorkers: "block", colorScheme: THEME });
  const seed = seedData();
  await ctx.addInitScript(([seed, theme]) => {
    try {
      if (localStorage.getItem("__preview_seeded")) return;
      localStorage.setItem("amply.library.v1", JSON.stringify(seed.library));
      localStorage.setItem("amply.likes.v1", JSON.stringify(seed.likes));
      localStorage.setItem("amply.playlists.v1", JSON.stringify(seed.playlists));
      localStorage.setItem("amply.recent.v1", JSON.stringify(seed.recent));
      localStorage.setItem("amply.theme", JSON.stringify(theme));
      localStorage.setItem("__preview_seeded", "1");
    } catch {}
  }, [seed, THEME]);
  await ctx.route("**/*", (route) => mockHandler(route, BASE).catch(() => route.abort().catch(() => {})));
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) console.log(`[console.error ${name}] ${m.text().slice(0, 300)}`); });
  page.on("response", (r) => { if (r.status() >= 400) console.log(`[http ${r.status()} ${name}] ${r.url().slice(0, 140)}`); });
  page.on("requestfailed", (r) => console.log(`[req failed ${name}] ${r.url().slice(0, 140)}`));
  page.on("pageerror", (e) => console.log(`[pageerror ${name}] ${String(e).slice(0, 300)}`));
  const file = join(OUT, `${name}-${THEME}-${WIDTH}.png`);
  try {
    await Promise.race([SCENARIOS[name](page), new Promise((_, rej) => setTimeout(() => rej(new Error(`scenario timed out after ${TIMEOUT}ms`)), TIMEOUT))]);
    console.log(`ok   ${name} -> ${file}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${String(e.message).split("\n")[0]} (screenshotting anyway)`);
  }
  await page.screenshot({ path: file }).catch((e) => console.log(`screenshot failed: ${e.message}`));
  await ctx.close();
}
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
