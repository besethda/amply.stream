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
  return (await listener(DB, wallet))?.seconds || 0;
};

// ── an empty fees account ──
lamports = 0;
ok("an empty fees account: the price is served paused", (await served()).paused === true);
ok("  the artist's own copy is untouched", (await setting(DB, "manifest")) === stored);
const audio = await get("/audio/song.mp3");
ok("  a paid song isn't kept behind a wallet", audio.status !== 401, `status ${audio.status}`);
ok("  listening isn't counted as owed", (await played()) === 0);

// ── a funded one ──
later(6);
lamports = OFFER_ABOVE_LAMPORTS + 1_000_000;
ok("a funded fees account: the price is live", (await served()).paused === undefined);
ok("  a paid song needs a wallet again", (await get("/audio/song.mp3")).status === 401);
ok("  and listening is counted", (await played()) === 120);

// ── what listening cost, priced when it was heard ──
const owed = () => sqlite.prepare("SELECT micros, seconds FROM owed WHERE pubkey = ?").get(wallet) || { micros: 0, seconds: 0 };
ok("  priced as heard: 2 minutes at a cent a minute is 2 cents", owed().micros === 20_000 && owed().seconds === 120, JSON.stringify(owed()));
sqlite.prepare("INSERT INTO subscriptions (wallet, subscription, customer, until, updated) VALUES (?, 'sub_1', 'cus_1', ?, ?)").run(wallet, clock + 86400_000, clock);
await played();
ok("a subscriber's listening costs nothing by the minute", owed().micros === 20_000 && owed().seconds === 240, JSON.stringify(owed()));
sqlite.prepare("DELETE FROM subscriptions").run();
const { forget, listeners: listed } = await import("./src/store.ts");
const row = (await listed(DB)).find((r) => r.pubkey === wallet);
ok("the editor sees the cost beside the listening", row?.owed_micros === 20_000 && row?.owed_seconds === 240, JSON.stringify(row));
await forget(DB, wallet);
ok("forgotten: the cost goes with the rest", owed().micros === 0 && !sqlite.prepare("SELECT 1 FROM owed WHERE pubkey = ?").get(wallet));

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

// ── the favicon, served by the artist's own server ──
{
  const { readFileSync } = await import("node:fs");
  const res = await get("/favicon.svg");
  const body = await res.text();
  ok("the artist's server serves the favicon, as an SVG", res.status === 200 && res.headers.get("Content-Type") === "image/svg+xml");
  ok("  the same one as amply.stream's", body === readFileSync("site/favicon.svg", "utf8").trim());
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
