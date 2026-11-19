/**
 * An artist is paid only once their fees account can pay fans' network fees.
 *
 * Until then their USDC price is served `paused` (spec/pricing.mjs): the
 * manifest says so, paid songs play without a wallet, and listening isn't
 * counted as owed. The artist's own copy is never changed. This drives the
 * real Worker, with only the database and the network stood in for.
 *
 *   npm run test:paused
 */
import { DatabaseSync } from "node:sqlite";
import worker from "./src/index.ts";
import { SCHEMA, putSetting, setting, listener } from "./src/store.ts";
import { feeAddress, OFFER_ABOVE_LAMPORTS } from "./src/settle.ts";
import { issueToken } from "./src/listen.ts";
import { base58 } from "./src/solana-tx.ts";
import { RULES } from "./src/limits.ts";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

const sqlite = new DatabaseSync(":memory:");
for (const s of SCHEMA) sqlite.exec(s);
const DB = {
  prepare(sql) {
    const stmt = sqlite.prepare(sql);
    let args = [];
    const api = {
      bind(...a) { args = a; return api; },
      async run() { stmt.run(...args); return { success: true }; },
      async first() { return stmt.get(...args) ?? null; },
      async all() { return { results: stmt.all(...args) }; },
    };
    return api;
  },
  async batch(list) { return Promise.all(list.map((s) => s.run())); },
};
const MEDIA_KV = {
  async get() { return null; },
  async getWithMetadata() { return { value: null, metadata: null }; },
  async put() {}, async delete() {}, async list() { return { keys: [], list_complete: true }; },
};
const env = { DB, MEDIA_KV };

// The network: only the fees account's balance is ever asked here.
let lamports = 0, rpcDown = false, rpcHangs = false, asked = 0;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init?.body || "{}");
  if (body.method !== "getBalance") throw new Error(`unexpected ${url} ${body.method}`);
  asked++;
  if (rpcDown) throw new TypeError("fetch failed");
  // An outage that doesn't refuse, just never answers: only the timeout ends it.
  if (rpcHangs) return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: lamports } }));
};
// The balance is remembered a few minutes; the clock moves past that.
let clock = Date.now();
Date.now = () => clock;
const later = (minutes) => { clock += minutes * 60_000; };

const ORIGIN = "https://artist.test";
const ADDRESS = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const manifest = {
  amply: 1, artist: { name: "A" },
  payment: [{ type: "solana-usdc", address: ADDRESS, ratePerMinute: 0.01 }],
  releases: [{ id: "r", title: "R", tracks: [{ id: "s", title: "S", url: `${ORIGIN}/audio/song.mp3` }] }],
};
const stored = JSON.stringify(manifest);
await putSetting(DB, "manifest", stored);
await feeAddress(DB);

const get = (path, headers = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, { headers }), env);
const served = async () => (await (await get("/manifest.json")).json()).payment[0];
const wallet = "9mPQ1111111111111111111111111111111111111111".slice(0, 44);
const played = async () => {
  const token = await issueToken(DB, wallet);
  await worker.fetch(new Request(`${ORIGIN}/listen/played`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ seconds: 120 }),
  }), env);
  return (await listener(DB, wallet))?.plays || 0;
};
// What a wallet owes here comes only from what this server sent it
// (test-meter.mjs); a report of a play is never money.
const owedNow = () => sqlite.prepare("SELECT micros FROM owed WHERE pubkey = ?").get(wallet)?.micros || 0;

// ── an empty fees account ──
lamports = 0;
ok("an empty fees account: the price is served paused", (await served()).paused === true);
ok("  the artist's own copy is untouched", (await setting(DB, "manifest")) === stored);
const audio = await get("/audio/song.mp3");
ok("  a paid song isn't kept behind a wallet", audio.status !== 401, `status ${audio.status}`);
await played();
ok("  a reported play owes nothing", owedNow() === 0);

// ── a funded one ──
later(6);
lamports = OFFER_ABOVE_LAMPORTS + 1_000_000;
ok("a funded fees account: the price is live", (await served()).paused === undefined);
ok("  a paid song needs a wallet again", (await get("/audio/song.mp3")).status === 401);
const playsBefore = (await listener(DB, wallet))?.plays || 0;
ok("  and a reported play is in the artist's record", (await played()) === playsBefore + 1);
ok("  as a play, never money: the app's word owes nothing", owedNow() === 0);

// ── what's owed, as this server counted it ──
const owed = () => sqlite.prepare("SELECT micros, seconds FROM owed WHERE pubkey = ?").get(wallet) || { micros: 0, seconds: 0 };
sqlite.prepare("INSERT INTO owed (pubkey, micros, seconds) VALUES (?, 20000, 120)").run(wallet);
const { forget, listeners: listed } = await import("./src/store.ts");
const row = (await listed(DB)).find((r) => r.pubkey === wallet);
ok("the editor sees what's owed beside the plays", row?.owed_micros === 20_000 && row?.plays >= 2, JSON.stringify(row));
await forget(DB, wallet);
const kept = sqlite.prepare("SELECT * FROM listeners WHERE pubkey = ?").get(wallet);
ok("forgotten while owing 2c: the listening goes, what's owed stays", owed().micros === 20_000 && kept?.plays === 0 && kept?.seconds === 0 && kept?.first_seen === 0, JSON.stringify([owed(), kept]));
sqlite.prepare("INSERT INTO paid (pubkey, micros) VALUES (?, 20000) ON CONFLICT(pubkey) DO UPDATE SET micros = 20000").run(wallet);
await forget(DB, wallet);
ok("  paid up and forgotten again: the cost goes with the rest", owed().micros === 0 && !sqlite.prepare("SELECT 1 FROM owed WHERE pubkey = ?").get(wallet) && !sqlite.prepare("SELECT 1 FROM listeners WHERE pubkey = ?").get(wallet));

// ── just below the line ──
later(6);
lamports = OFFER_ABOVE_LAMPORTS - 1;
ok("just under the line: paused again", (await served()).paused === true);

// ── the network not answering ──
later(6);
lamports = OFFER_ABOVE_LAMPORTS + 1_000_000;
await served();
later(6);
rpcDown = true;
ok("the network busy for a moment: what was true stands", (await served()).paused === undefined);
later(61);
ok("  but not for long: after an hour, nobody can say, so it's paused", (await served()).paused === true);
rpcDown = false;

// ── the website, on and off ──
{
  const { cleanSite, starterSite } = await import("../spec/site.mjs");
  const site = cleanSite(starterSite(manifest));
  await putSetting(DB, "site", JSON.stringify(site));
  later(1);   // past the brief cache
  ok("a website that's on is what visitors see", (await (await get("/")).text()).includes('class="s-hero'));
  await putSetting(DB, "site", JSON.stringify({ ...site, on: false }));
  later(1);
  const page = await (await get("/")).text();
  ok("  turned off: the plain music page instead, the site kept", !page.includes('class="s-hero') && /<html/.test(page));
}

// ── a play reported the way the app sends it: the pass in the address ──
{
  later(6);
  lamports = OFFER_ABOVE_LAMPORTS + 1_000_000;
  await served();
  later(2);
  const who = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
  const token = await issueToken(DB, who);
  const res = await worker.fetch(new Request(`${ORIGIN}/listen/played?t=${encodeURIComponent(token)}`, {
    method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.77" }, body: JSON.stringify({ seconds: 90 }),
  }), env);
  ok("a play reported with ?t= is counted", res.status === 204 && (await listener(DB, who))?.plays === 1, String((await listener(DB, who))?.plays));
  const allowed = String((await worker.fetch(new Request(`${ORIGIN}/listen/played`, { method: "OPTIONS" }), env)).headers.get("Access-Control-Allow-Headers") || "").toLowerCase();
  ok("  and the only header it sends (Content-Type) is one other sites may send", allowed.includes("content-type"), allowed);
}

// ── the favicon, served by the artist's own server ──
{
  const { readFileSync } = await import("node:fs");
  const res = await get("/favicon.svg");
  const body = await res.text();
  ok("the artist's server serves the favicon, as an SVG", res.status === 200 && res.headers.get("Content-Type") === "image/svg+xml");
  ok("  the same one as amply.stream's", body === readFileSync("site/favicon.svg", "utf8").trim());
}

// ── every JSON answer: never cached, readable from any origin ──
{
  const post = (path) => worker.fetch(new Request(`${ORIGIN}${path}`, { method: "POST" }), env);
  for (const [name, res] of [["/version", await get("/version")], ["/listen/challenge", await post("/listen/challenge")], ["/listen/fees", await get("/listen/fees")]]) {
    ok(`${name} is JSON, not cached, open to any origin`, res.status === 200 && /^application\/json/.test(res.headers.get("Content-Type"))
      && res.headers.get("Cache-Control") === "no-store" && res.headers.get("Access-Control-Allow-Origin") === "*" && (await res.json()) !== null);
  }
  for (const path of ["/", "/privacy"]) {
    const res = await get(path);
    const nonce = /'nonce-([^']+)'/.exec(res.headers.get("Content-Security-Policy") || "")?.[1];
    const html = await res.text();
    ok(`${path}: a fresh nonce in its CSP, on its scripts, not cached`, !!nonce && html.includes(`nonce="${nonce}"`) && res.headers.get("Cache-Control") === "no-store"
      && /^text\/html/.test(res.headers.get("Content-Type")));
  }
}

// ── the editor's MP3 encoder: a file of its own, kept by the browser ──
{
  const { readFileSync } = await import("node:fs");
  const { LAME_PATH, MANAGE_CSP } = await import("./src/constants.ts");
  const res = await get(LAME_PATH);
  const body = await res.text();
  ok("the encoder is served as a script, cached for good", res.status === 200
    && /^text\/javascript/.test(res.headers.get("Content-Type")) && /immutable/.test(res.headers.get("Cache-Control")));
  const lame = await import("data:text/javascript," + encodeURIComponent(body));
  const enc = new lame.Mp3Encoder(2, 44100, 128);
  const tone = new Int16Array(1152 * 4).map((_, i) => Math.round(Math.sin(i / 10) * 8000));
  ok("  and it encodes", enc.encodeBuffer(tone, tone).length + enc.flush().length > 0);
  const installed = JSON.parse(readFileSync("manage/node_modules/@breezystack/lamejs/package.json", "utf8")).version;
  ok("  at an address named for the version installed, so a new one isn't cached as the old", LAME_PATH.includes(`-${installed}.js`), `${LAME_PATH} vs ${installed}`);
  ok("  which the editor may load from its own node", /script-src[^;]*'self'/.test(MANAGE_CSP));
  const editor = readFileSync("site/node-manage.html", "utf8");
  ok("  and the editor no longer carries it", !editor.includes("extended fmt chunk not implemented") && editor.includes("Mp3Encoder"));
}

// ── the manifest is worked out once, not for every ranged piece of a song ──
{
  const parse = JSON.parse;
  let parses = 0;
  const pieces = async () => {
    await get("/audio/song.mp3", { Range: "bytes=0-1" });   // warms the cache
    parses = 0;
    JSON.parse = (...a) => { parses++; return parse(...a); };
    for (let i = 0; i < 5; i++) await get("/audio/song.mp3", { Range: `bytes=${i}-${i + 1}` });
    await get("/manifest.json");
    JSON.parse = parse;
    return parses;
  };
  later(6);
  lamports = OFFER_ABOVE_LAMPORTS + 1_000_000;
  ok("ranged audio and the manifest share one reading of it", (await pieces()) === 0, `${parses} parses`);
  later(6);
  lamports = 0;
  ok("  paused too", (await pieces()) === 0 && (await served()).paused === true, `${parses} parses`);
}

// ── the editor's fees status says what listeners see ──
{
  const { PREVIEW_KEY, hashKey } = await import("./src/preview-key.ts");
  const { countFee } = await import("./src/settle.ts");
  const KEY = "A".repeat(42) + "w";
  const fees = async () => (await get("/manage/fees", { Cookie: `amply_preview=${KEY}` })).json();
  lamports = OFFER_ABOVE_LAMPORTS + 1_000_000;
  later(24 * 60);   // another day, by the Worker's clock
  await putSetting(DB, PREVIEW_KEY, JSON.stringify({ hash: await hashKey(KEY), until: clock + 30 * 60_000 }));
  await countFee(DB, Date.now());
  const on = await fees();
  ok("the editor's fees status: on while listeners are offered it", on.offering === true && (await served()).paused === undefined, JSON.stringify(on));
  ok("  and today's count is the day the fees were counted under", on.paidToday === 1, JSON.stringify(on));
  // A payee that is the fees account itself: listeners aren't offered it.
  const feeWallet = await feeAddress(DB);
  await putSetting(DB, "manifest", JSON.stringify({ ...manifest, payment: [{ ...manifest.payment[0], address: feeWallet }] }));
  later(1);   // past the brief cache
  ok("  a payee that's the fees account: off in the editor, as for listeners", (await fees()).offering === false && (await served()).paused === true);
  await putSetting(DB, "manifest", stored);
  later(1);
}

// ── Solana not answering at all, with no balance known ──
{
  later(61);   // anything known is over an hour old: nobody can say
  rpcHangs = true;
  // Node doesn't stay up for AbortSignal.timeout's timer alone; a Worker would.
  const awake = setInterval(() => {}, 1_000);
  const before = asked;
  let t = performance.now();
  const first = await served();
  const firstMs = performance.now() - t;
  ok("Solana hanging, nothing known: paused, after a short wait rather than ten seconds", first.paused === true && firstMs < 9_000, `${Math.round(firstMs)} ms`);
  t = performance.now();
  const second = await served();
  const audio = await get("/audio/song.mp3");
  const secondMs = performance.now() - t;
  ok("  the next requests don't wait on it again", second.paused === true && audio.status !== 401 && secondMs < 1_000 && asked === before + 1,
    `${Math.round(secondMs)} ms, asked ${asked - before}`);
  clearInterval(awake);
  later(1);   // past the half minute a failure is remembered
  rpcHangs = false;
  lamports = OFFER_ABOVE_LAMPORTS + 1_000_000;
  ok("  half a minute on, it asks again", (await served()).paused === undefined && asked === before + 2);
}

// ── a balance a few minutes old: used at once, refreshed in the background ──
{
  later(6);
  lamports = 0;
  const waiting = [];
  const ctx = { waitUntil: (p) => waiting.push(p), passThroughOnException() {} };
  const res = await worker.fetch(new Request(`${ORIGIN}/manifest.json`), env, ctx);
  ok("a stale balance is used straight away", (await res.json()).payment[0].paused === undefined && waiting.length === 1);
  await Promise.all(waiting);
  ok("  and the background check is what the next request sees", (await served()).paused === true);
}

// ── the database's daily allowance: plays reported by anyone (A1) ──
{
  later(6);
  lamports = OFFER_ABOVE_LAMPORTS + 1_000_000;
  const withFree = { ...manifest, releases: [{ ...manifest.releases[0], tracks: [
    ...manifest.releases[0].tracks, { id: "f", title: "F", url: `${ORIGIN}/audio/free.mp3`, free: true },
  ] }] };
  await putSetting(DB, "manifest", JSON.stringify(withFree));
  later(1);
  ok("(payments are live for these)", (await served()).paused === undefined);
  const plays = (id) => sqlite.prepare("SELECT plays FROM track_plays WHERE track = ?").get(id)?.plays || 0;
  const rows = () => sqlite.prepare("SELECT (SELECT COUNT(*) FROM track_plays) + (SELECT COALESCE(SUM(plays), 0) FROM play_days) AS n").get().n;
  const heardAs = (track, { ip = "203.0.113.1", token } = {}) => worker.fetch(new Request(
    `${ORIGIN}/listen/heard${token ? `?t=${encodeURIComponent(token)}` : ""}`, {
      method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({ track, seconds: 120 }),
    }), env);

  const before = rows();
  for (let i = 0; i < 30; i++) await heardAs("s", { ip: "203.0.113.1" });
  ok("an anonymous flood of a paid song's plays writes nothing", rows() === before && plays("s") === 0, `${rows()} vs ${before}`);

  later(2);
  for (let i = 0; i < 10; i++) await heardAs("f", { ip: "203.0.113.2" });
  ok(`a free song's anonymous plays: only ${RULES.heard.limit} a minute from one address`, plays("f") === RULES.heard.limit, String(plays("f")));
  await heardAs("f", { ip: "203.0.113.3" });
  ok("  another address has its own count", plays("f") === RULES.heard.limit + 1);

  later(2);
  const token = await issueToken(DB, wallet);
  await heardAs("s", { ip: "203.0.113.4", token });
  ok("a paid song's play with a listener's pass is counted", plays("s") === 1);
  for (let i = 0; i < 20; i++) await heardAs("s", { ip: "203.0.113.4", token });
  ok(`  at most ${RULES.wallet.limit} a minute, as fast as songs can end`, plays("s") === RULES.wallet.limit, String(plays("s")));
  await heardAs("s", { ip: "203.0.113.5", token: "made.up.token" });
  ok("  a made-up pass counts for nothing", plays("s") === RULES.wallet.limit);

  // ── brand-new wallets, admitted only so fast at /listen/token (A1, A2) ──
  later(2);
  const askPass = async (keys, ip = "198.51.100.1") => {
    const address = base58(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
    const message = `amply:artist.test:${clock}:${crypto.randomUUID()}`;
    const signature = base58(new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(message))));
    return worker.fetch(new Request(`${ORIGIN}/listen/token`, {
      method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({ address, message, signature }),
    }), env);
  };
  const newKeys = () => crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const statuses = [];
  for (let i = 0; i < RULES.newListener.limit + 3; i++) statuses.push((await askPass(await newKeys(), `198.51.100.${10 + i}`)).status);
  ok(`new wallets get passes, ${RULES.newListener.limit} a minute`, statuses.slice(0, RULES.newListener.limit).every((s) => s === 200), statuses.join(","));
  ok("  and past that, /listen/token refuses them for now", statuses.slice(RULES.newListener.limit).every((s) => s === 429), statuses.join(","));
  ok("  writing nothing for them", sqlite.prepare("SELECT COUNT(*) AS n FROM listeners").get().n <= 1);
  const known = await newKeys();
  const knownAddress = base58(new Uint8Array(await crypto.subtle.exportKey("raw", known.publicKey)));
  sqlite.prepare("INSERT INTO listeners (pubkey, plays, seconds, first_seen, last_seen) VALUES (?, 1, 60, ?, ?)").run(knownAddress, clock, clock);
  ok("  a wallet already known here still gets one", (await askPass(known, "198.51.100.200")).status === 200);
  later(2);
  ok("  and a minute later, new ones again", (await askPass(await newKeys(), "198.51.100.201")).status === 200);
}

// ── paid audio isn't left in shared caches (A2) ──
{
  later(6);
  lamports = OFFER_ABOVE_LAMPORTS + 1_000_000;
  later(1);
  const bytes = new Uint8Array(1000);
  const MEDIA = {
    async get(_key, { range } = {}) {
      const wants = range?.get?.("Range");
      return {
        size: bytes.length, httpEtag: '"e1"', writeHttpMetadata() {},
        ...(wants ? { range: { offset: 0, length: 100 } } : {}),
        body: new Blob([wants ? bytes.slice(0, 100) : bytes]).stream(),
      };
    },
    async head() { return { size: bytes.length, httpEtag: '"e1"', writeHttpMetadata() {} }; },
  };
  const audioEnv = { ...env, MEDIA };
  const fetchAudio = (path, headers = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, { headers }), audioEnv);
  const token = await issueToken(DB, wallet);
  const paid = await fetchAudio(`/audio/song.mp3?t=${encodeURIComponent(token)}`);
  ok("a paid song is served to a listener with a pass, privately", paid.status === 200 && paid.headers.get("Cache-Control") === "private, max-age=31536000, immutable", `${paid.status} ${paid.headers.get("Cache-Control")}`);
  const ranged = await fetchAudio(`/audio/song.mp3?t=${encodeURIComponent(token)}`, { Range: "bytes=0-99" });
  ok("  ranges and ETags as before", ranged.status === 206 && ranged.headers.get("Content-Range") === "bytes 0-99/1000" && ranged.headers.get("ETag") === '"e1"' && /^private/.test(ranged.headers.get("Cache-Control")));
  const free = await fetchAudio("/audio/free.mp3");
  ok("a free song stays public", free.status === 200 && free.headers.get("Cache-Control") === "public, max-age=31536000, immutable", free.headers.get("Cache-Control"));
  // The artist's own editor plays a paid song without a listener's pass, through
  // the signed-in route: whole, ranged, and measured with a HEAD.
  {
    const { hashKey, PREVIEW_KEY } = await import("./src/preview-key.ts");
    const OWNER = "O".repeat(43);
    await putSetting(DB, PREVIEW_KEY, JSON.stringify({ hash: await hashKey(OWNER), until: clock + 30 * 60_000 }));
    const own = { Cookie: `amply_preview=${OWNER}` };
    ok("a paid song is refused at its public address with no pass", (await fetchAudio("/audio/song.mp3")).status === 401);
    const mine = await fetchAudio("/manage/audio/song.mp3", own);
    ok("  but the artist's own copy plays, and is never shared", mine.status === 200 && mine.headers.get("Cache-Control") === "private, no-store", `${mine.status} ${mine.headers.get("Cache-Control")}`);
    const mineRanged = await fetchAudio("/manage/audio/song.mp3", { ...own, Range: "bytes=0-99" });
    ok("  and can be seeked", mineRanged.status === 206 && mineRanged.headers.get("Content-Range") === "bytes 0-99/1000");
    const size = await worker.fetch(new Request(`${ORIGIN}/manage/audio/song.mp3`, { method: "HEAD", headers: own }), audioEnv);
    ok("  and measured with a HEAD", size.status === 200 && size.headers.get("Content-Length") === "1000", `${size.status} ${size.headers.get("Content-Length")}`);
    ok("  the signed-in route is closed to anyone else", (await fetchAudio("/manage/audio/song.mp3")).status !== 200);
  }
  later(6);
  lamports = 0;
  later(1);
  const pausedPaid = await fetchAudio("/audio/song.mp3");
  ok("  a paid song playing free while payments are paused is still private", pausedPaid.status === 200 && /^private/.test(pausedPaid.headers.get("Cache-Control")), `${pausedPaid.status} ${pausedPaid.headers.get("Cache-Control")}`);
}

// ── a Coinbase cash-out's status, asked through the artist's node (A4) ──
{
  const { hashKey, PREVIEW_KEY } = await import("./src/preview-key.ts");
  const KEY = "K".repeat(43);
  await putSetting(DB, PREVIEW_KEY, JSON.stringify({ hash: await hashKey(KEY), until: clock + 30 * 60_000 }));
  const realFetch = globalThis.fetch;
  let asked = null;
  globalThis.fetch = async (url) => { asked = new URL(String(url)); return new Response(JSON.stringify({ waiting: true })); };
  const nonce = "0123456789abcdef0123456789abcdef";
  const q = new URLSearchParams({ address: ADDRESS, signedAt: "123", signature: "sig", nonce, amount: "25" });
  const res = await worker.fetch(new Request(`${ORIGIN}/manage/cashout/coinbase?${q}`, { headers: { Cookie: `amply_preview=${KEY}` } }), env);
  globalThis.fetch = realFetch;
  ok("the editor's cash-out check reaches the relay", res.status === 200 && asked?.pathname === "/coinbase/sell/status", `${res.status} ${asked}`);
  ok("  with the cash-out's nonce and amount, so the relay finds that session alone",
    asked?.searchParams.get("nonce") === nonce && asked?.searchParams.get("amount") === "25" && asked?.searchParams.get("signature") === "sig");
}

// ── Stripe's own words stay with the artist (A5) ──
{
  await putSetting(DB, "stripe", JSON.stringify({
    key: "rk_test_x", live: false, product: "prod_1", portal: "bpc_1", plans: [],
    sales: [{ item: "r", price: 5, priceId: "price_1", linkId: "plink_1", url: "https://buy.stripe.com/x" }],
  }));
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const address = base58(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
  sqlite.prepare("INSERT INTO subscriptions (wallet, subscription, customer, until, updated) VALUES (?, 'sub_9', 'cus_9', ?, ?)").run(address, clock + 86400_000, clock);
  const signedBody = async (extra) => {
    const message = `amply:artist.test:${clock}:${crypto.randomUUID()}`;
    const signature = base58(new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(message))));
    return JSON.stringify({ address, message, signature, ...extra });
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "secret detail about the artist's account rak_checkout_session_read" } }), { status: 403 });
  for (const [path, extra] of [
    ["/listen/claim", { session: "cs_test_abcdefghijkl" }],
    ["/listen/buy/claim", { session: "cs_test_abcdefghijkl" }],
    ["/listen/subscription", { returnTo: "https://amply.stream/app/" }],
  ]) {
    const res = await worker.fetch(new Request(`${ORIGIN}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.50" }, body: await signedBody(extra),
    }), env);
    const said = (await res.json().catch(() => ({}))).error || "";
    ok(`${path}: Stripe's error isn't passed to the listener`, res.status === 502 && said === "Couldn't confirm that with Stripe; try again", `${res.status} ${said}`);
  }
  globalThis.fetch = realFetch;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
