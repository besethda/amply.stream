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
let lamports = 0, rpcDown = false;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init?.body || "{}");
  if (body.method !== "getBalance") throw new Error(`unexpected ${url} ${body.method}`);
  if (rpcDown) throw new TypeError("fetch failed");
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
