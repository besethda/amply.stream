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
  later(6);
  lamports = 0;
  later(1);
  const pausedPaid = await fetchAudio("/audio/song.mp3");
  ok("  a paid song playing free while payments are paused is still private", pausedPaid.status === 200 && /^private/.test(pausedPaid.headers.get("Cache-Control")), `${pausedPaid.status} ${pausedPaid.headers.get("Cache-Control")}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
