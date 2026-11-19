/**
 * Metering: the node counts the paid audio it sends to each wallet, per track
 * and day (src/meter.ts). What's billed is what the listener's app reports.
 * What was sent is billed (less SLACK) only for a wallet that reported
 * nothing at all that day, a day after it ended (store.ts billUnreported), so
 * an app that never reports still pays for most of what it took, and an
 * honest one is never billed for what its browser read ahead.
 *
 * Wrong one way, an honest listener pays twice or for what they skipped; the
 * other, a copier takes the catalogue for nothing; and either way it mustn't
 * spend the artist's database allowance on every ranged request. This drives
 * the real Worker, on SQLite with the node's own schema, with storage and the
 * network stood in for.
 *
 *   npm run test:paused   (runs this too)
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import worker, { meterHooks } from "./src/index.ts";
import { SCHEMA, putSetting, recordPaid, pruneStale, pruneHourly, setAutoBlock, servedDay, SERVED_KEEP_DAYS, UNREPORTED_GRACE_MS, billUnreported } from "./src/store.ts";
import { feeAddress, feeBalance, OFFER_ABOVE_LAMPORTS } from "./src/settle.ts";
import { issueToken } from "./src/listen.ts";
import { parseRange } from "./src/media.ts";
import { SLACK, slackFor, DELIVERED_CAP, FLUSH, FALLBACK_BYTES_PER_SECOND, resetTallies } from "./src/meter.ts";
import { renderPrivacy } from "./src/page.ts";
import { base58 } from "./src/solana-tx.ts";

const require = createRequire(resolve("app/package.json"));
const { Keypair } = require("@solana/web3.js");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

// ── the clock: noon UTC today, moved by hand ──
const DAY = 86_400_000;
let clock = Math.floor(Date.now() / DAY) * DAY + DAY / 2;
const realNow = Date.now;
Date.now = () => clock;
const tick = (ms) => { clock += ms; };

// ── the artist's database, counting what's written ──
let batches = 0;
function d1(sqlite) {
  const prepare = (sql) => {
    const stmt = sqlite.prepare(sql);
    let args = [];
    const api = {
      bind(...a) { args = a; return api; },
      async run() { stmt.run(...args); return { success: true }; },
      async first() { return stmt.get(...args) ?? null; },
      async all() { return { results: stmt.all(...args) }; },
      _run() { stmt.run(...args); },
    };
    return api;
  };
  return {
    prepare,
    // D1's batch: one transaction, all or nothing.
    async batch(statements) {
      batches++;
      sqlite.exec("BEGIN");
      try { for (const s of statements) s._run(); sqlite.exec("COMMIT"); }
      catch (e) { sqlite.exec("ROLLBACK"); throw e; }
      return [];
    },
  };
}
const sqlite = new DatabaseSync(":memory:");
for (const s of SCHEMA) sqlite.exec(s);
const DB = d1(sqlite);

// ── storage, R2-like: ranges, conditional requests, bodies in 16 KB pieces ──
const files = new Map();
const PIECE = 16 * 1024;
const chunked = (bytes) => {
  let at = 0;
  return new ReadableStream({
    pull(c) {
      if (at >= bytes.length) { c.close(); return; }
      c.enqueue(bytes.slice(at, at + PIECE));
      at += PIECE;
    },
  });
};
const MEDIA = {
  async get(key, { range, onlyIf } = {}) {
    const bytes = files.get(key);
    if (!bytes) return null;
    const meta = { size: bytes.length, httpEtag: '"e1"', writeHttpMetadata() {} };
    if (onlyIf?.get?.("If-None-Match") === '"e1"') return meta;
    const r = parseRange(range?.get?.("Range") ?? null, bytes.length);
    const slice = r ? bytes.slice(r.offset, r.offset + r.length) : bytes;
    return { ...meta, ...(r ? { range: r } : {}), body: chunked(slice) };
  },
  async head(key) {
    const bytes = files.get(key);
    return bytes ? { size: bytes.length, httpEtag: '"e1"', writeHttpMetadata() {} } : null;
  },
};
// 1,000 bytes a second, so bytes read as milliseconds of audio.
const LEN = 240;
files.set("audio/song.mp3", new Uint8Array(LEN * 1000));
files.set("audio/two.mp3", new Uint8Array(LEN * 1000));
files.set("audio/three.mp3", new Uint8Array(LEN * 1000));
files.set("audio/free.mp3", new Uint8Array(LEN * 1000));
// No duration in the manifest: counted at the editor's streaming bitrate.
files.set("audio/nolength.mp3", new Uint8Array(100 * FALLBACK_BYTES_PER_SECOND));

const env = { DB, MEDIA };

// Work that outlives a response (ctx.waitUntil), awaited by the test.
const waiting = [];
const ctx = { waitUntil(p) { waiting.push(p); }, passThroughOnException() {} };
const settled = async () => { while (waiting.length) await Promise.all(waiting.splice(0)); };
let flushes = 0;
meterHooks.onFlush = () => { flushes++; };

const ORIGIN = "https://artist.test";
const HOST = "artist.test";
// 6 cents a minute: a micro-dollar per millisecond, 1,000 micros a second.
const RATE = 0.06, POINT = 0.1;
const ARTIST = Keypair.generate().publicKey.toBase58();
const track = (id, file, extra = {}) => ({ id, title: id, duration: LEN, url: `${ORIGIN}/audio/${file}`, ...extra });
const manifest = {
  amply: 1, artist: { name: "A" },
  payment: [{ type: "solana-usdc", address: ARTIST, ratePerMinute: RATE, settleAt: POINT }],
  releases: [{ id: "r", title: "R", tracks: [
    track("s", "song.mp3"), track("two", "two.mp3"), track("three", "three.mp3"),
    track("f", "free.mp3", { free: true }),
    { id: "nl", title: "No length", url: `${ORIGIN}/audio/nolength.mp3` },
  ] }],
};
await putSetting(DB, "manifest", JSON.stringify(manifest));

// The network: the fees account has enough, so payments aren't paused.
let lamports = OFFER_ABOVE_LAMPORTS + 1_000_000;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init?.body || "{}");
  if (body.method === "getBalance") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: lamports } }));
  throw new Error(`unexpected ${url} ${body.method}`);
};
const FEES = await feeAddress(DB);

// ── listeners ──
const PKCS8 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
async function makeWallet() {
  const kp = Keypair.generate();
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from([...PKCS8, ...kp.secretKey.slice(0, 32)]), "Ed25519", false, ["sign"]);
  const w = { kp, address: kp.publicKey.toBase58(), key };
  w.token = await issueToken(DB, w.address);
  return w;
}
let ipN = 0;
const nextIp = () => `198.51.${Math.floor(++ipN / 250) % 250}.${ipN % 250}`;
async function signed(w, extra = {}) {
  const message = `amply:${HOST}:${Date.now()}:${crypto.randomUUID()}`;
  const signature = base58(new Uint8Array(await crypto.subtle.sign("Ed25519", w.key, new TextEncoder().encode(message))));
  return JSON.stringify({ address: w.address, message, signature, ...extra });
}
const call = (path, init = {}, e = env) => worker.fetch(new Request(`${ORIGIN}${path}`, {
  ...init, headers: { "CF-Connecting-IP": nextIp(), ...(init.headers || {}) },
}), e, ctx);
const listen = (path, body, e = env) => call(`/listen${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body }, e);
/** Fetch audio as a listener and take all of it (a player that plays it through). */
async function audio(w, file, headers = {}, { method = "GET", e = env, settle = true } = {}) {
  const res = await call(`/audio/${file}${w ? `?t=${encodeURIComponent(w.token)}` : ""}`, { method, headers }, e);
  const body = res.body ? new Uint8Array(await res.arrayBuffer()) : null;
  if (settle) await settled();
  return { res, bytes: body?.length ?? 0 };
}
const played = async (w, seconds, trackId, e = env) => {
  const r = await call(`/listen/played?t=${encodeURIComponent(w.token)}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(trackId === undefined ? { seconds } : { seconds, track: trackId }),
  }, e);
  await settled();
  return r;
};
const row = (w, file = "song.mp3") => sqlite.prepare("SELECT * FROM served WHERE pubkey = ? AND track = ?").get(w.address, file);
const rows = (w) => sqlite.prepare("SELECT * FROM served WHERE pubkey = ?").all(w.address);
const owed = (w) => sqlite.prepare("SELECT micros, seconds FROM owed WHERE pubkey = ?").get(w.address) ?? { micros: 0, seconds: 0 };
const tally = (w) => sqlite.prepare("SELECT plays, seconds FROM listeners WHERE pubkey = ?").get(w.address);
const near = (a, b, within = 1) => Math.abs(a - b) <= within;
const SLACK_S = slackFor(LEN);   // 84 s for a four-minute song
/** A day on (past the end of the day plus UNREPORTED_GRACE_MS), and the
 *  wallet asks for a pass: what it took and never reported is billed then,
 *  if it's due. */
const later = async (w, ms = DAY) => {
  tick(ms);
  w.token = await issueToken(DB, w.address);
  const r = await listen("/token", await signed(w));
  return { status: r.status, body: await r.json() };
};

ok("the slack is 60 s or 35% of the track, whichever is more", SLACK.seconds === 60 && SLACK.share === 0.35 && SLACK_S === 84 && slackFor(100) === 60);

// ── a full listen, reported and sent: billed once ───────────────────────────
{
  const w = await makeWallet();
  const before = { flushes, batches };
  const got = await audio(w, "song.mp3");
  ok("a paid song is served whole to a listener with a pass", got.res.status === 200 && got.bytes === LEN * 1000 && got.res.headers.get("Content-Length") === String(LEN * 1000));
  ok("  a whole-file request is exactly one write", flushes - before.flushes === 1 && batches - before.batches === 1, `${flushes - before.flushes} flushes, ${batches - before.batches} batches`);
  ok("  counted as the song's 240 s sent", near(row(w).delivered, LEN), JSON.stringify(row(w)));
  ok("  and nothing billed for it: bytes sent aren't listening", row(w).billed === 0 && owed(w).micros === 0, JSON.stringify([row(w), owed(w)]));
  const r = await played(w, LEN, "s");
  ok("the app reports the play, by song id", r.status === 204);
  ok("  billed what it reports: 240 s, 24 cents, once", owed(w).micros === LEN * 1000 && owed(w).seconds === LEN && row(w).billed === LEN, JSON.stringify([row(w), owed(w)]));
  ok("  one play in the wallet's totals, 240 s", tally(w)?.plays === 1 && tally(w)?.seconds === LEN, JSON.stringify(tally(w)));
  ok("  a typical play (the audio, then the report) is two writes", batches - before.batches === 2, `${batches - before.batches}`);

  // The other order: the report first (the audio came from the browser's
  // cache, say), then the audio.
  const v = await makeWallet();
  await played(v, LEN, "two");
  await audio(v, "two.mp3");
  ok("reported first, sent after: still billed once", owed(v).micros === LEN * 1000 && row(v, "two.mp3").billed === LEN, JSON.stringify([row(v, "two.mp3"), owed(v)]));
  await played(v, LEN, "two");
  ok("  a replay from the cache (nothing sent) is billed by its report", owed(v).micros === 2 * LEN * 1000, JSON.stringify(owed(v)));
}

// ── taken whole, never reported: about two thirds, a day later ─────────────
{
  const w = await makeWallet();
  await audio(w, "song.mp3");
  ok("a copy taken whole with no report: nothing billed on the day", owed(w).micros === 0, JSON.stringify(owed(w)));
  // Noon now: 5 am tomorrow is under the grace past midnight; 7 am is past it.
  tick(DAY / 2 + UNREPORTED_GRACE_MS - 3_600_000);
  w.token = await issueToken(DB, w.address);
  await listen("/token", await signed(w));
  ok("  nor just after midnight: a late report can still come", owed(w).micros === 0, JSON.stringify(owed(w)));
  const r = await later(w, 2 * 3_600_000);
  ok("  six hours after that day ends, billed at what was sent less the slack (156 of 240 s)", owed(w).micros === 156_000 && owed(w).seconds === 156, JSON.stringify(owed(w)));
  ok("  and the pass says so", r.body.owes === 156_000, JSON.stringify(r.body));
  ok("  and the wallet is in the listeners table, so Auto-block can see it", tally(w)?.seconds === 156 && tally(w)?.plays === 0, JSON.stringify(tally(w)));
  await listen("/token", await signed(w));
  ok("  billed once, however often it asks", owed(w).micros === 156_000, JSON.stringify(owed(w)));

  const skip = await makeWallet();
  await audio(skip, "two.mp3", { Range: "bytes=0-59999" });
  ok("a song skipped after a minute's download: nothing billed", owed(skip).micros === 0 && !tally(skip), JSON.stringify(owed(skip)));
  await played(skip, 20, "two");
  ok("  its 20 s report is what's billed", owed(skip).micros === 20_000, JSON.stringify(owed(skip)));
}

// ── honest listeners: billed what they heard, whatever the browser read ahead ─
{
  // The browser read the whole song ahead; the listener skipped at 10 s.
  const a = await makeWallet();
  await audio(a, "song.mp3");
  await played(a, 10, "s");
  ok("a song read ahead whole and skipped at 10 s: 10 s billed", owed(a).micros === 10_000, JSON.stringify(owed(a)));
  await later(a);
  ok("  and still 10 s a day on, not what was sent", owed(a).micros === 10_000, JSON.stringify(owed(a)));

  // Skipped before a second played: the app reports 0 s.
  const b = await makeWallet();
  await audio(b, "song.mp3");
  await played(b, 0, "s");
  ok("a song fetched and skipped at 0 s: nothing billed", owed(b).micros === 0, JSON.stringify(owed(b)));
  await later(b);
  ok("  then, or a day on", owed(b).micros === 0, JSON.stringify(owed(b)));

  // One song's report lost (the app closed, a rate limit, no signal), but
  // the app reported another that day: its app reports, so nothing sent is billed.
  const c = await makeWallet();
  await audio(c, "song.mp3");
  await played(c, LEN, "s");
  await audio(c, "two.mp3");
  await later(c);
  ok("a song whose report was lost, from an app that reported others that day: not billed", owed(c).micros === LEN * 1000 && row(c, "two.mp3").billed === 0, JSON.stringify([rows(c), owed(c)]));

  // An app that reported yesterday, and today was killed mid-song before it
  // could report anything at all: it's a reporting app, so nothing is billed.
  const e = await makeWallet();
  await audio(e, "song.mp3");
  await played(e, LEN, "s");
  tick(DAY);
  e.token = await issueToken(DB, e.address);
  await audio(e, "two.mp3");
  await later(e);
  ok("a day with no report at all, from an app that has reported before: not billed", owed(e).micros === LEN * 1000, JSON.stringify([rows(e), owed(e)]));

  // Seeking around one song all evening, reported honestly.
  const d = await makeWallet();
  for (let i = 0; i < 4; i++) { tick(FLUSH.gapMs); await audio(d, "song.mp3"); }
  await played(d, 300, "s");
  await later(d);
  ok("a listener seeking around one song (720 s sent) is billed the 300 s heard", owed(d).micros === 300_000, JSON.stringify(owed(d)));
}

// ── what's due is looked at before it's pruned ──────────────────────────────
{
  const today = servedDay(clock);
  const w = await makeWallet();
  sqlite.prepare("INSERT INTO served (pubkey, track, day, delivered, reported, billed) VALUES (?, 'song.mp3', ?, ?, 0, 0)").run(w.address, today - SERVED_KEEP_DAYS, LEN);
  let seen = null;
  await pruneStale(DB, clock, async () => { seen = rows(w).length; await billUnreported(DB, { slackOf: () => SLACK_S, perMinute: async () => RATE, now: clock }); });
  ok("a wallet's unreported day is billed before its rows are pruned", seen === 1 && owed(w).micros === 156_000 && rows(w).length === 0, JSON.stringify([seen, owed(w), rows(w)]));
  const gone = await makeWallet();
  sqlite.prepare("INSERT INTO served (pubkey, track, day, delivered, reported, billed) VALUES (?, 'removed.mp3', ?, ?, 0, 0)").run(gone.address, today - 2, LEN);
  await billUnreported(DB, { slackOf: () => Infinity, perMinute: async () => RATE, now: clock });
  ok("a track no longer published isn't billed (its length can't be known)", owed(gone).micros === 0, JSON.stringify(owed(gone)));

  // Two runs at once (a pass asked for while the hourly prune runs): billed once.
  const twice = await makeWallet();
  sqlite.prepare("INSERT INTO served (pubkey, track, day, delivered, reported, billed) VALUES (?, 'song.mp3', ?, ?, 0, 0)").run(twice.address, today - 2, LEN);
  sqlite.prepare("INSERT INTO served (pubkey, track, day, delivered, reported, billed) VALUES (?, 'two.mp3', ?, ?, 0, 0)").run(twice.address, today - 2, LEN);
  const opts = { slackOf: () => SLACK_S, perMinute: async () => RATE, now: clock };
  await Promise.all([billUnreported(DB, opts), billUnreported(DB, opts), billUnreported(DB, { ...opts, pubkey: twice.address })]);
  ok("billing run three times at once bills each song once (2 x 156 s)", owed(twice).micros === 312_000 && tally(twice)?.seconds === 312, JSON.stringify([owed(twice), tally(twice)]));

  // Free to this wallet at billing time (a subscriber now, payments paused): waits.
  const free = await makeWallet();
  sqlite.prepare("INSERT INTO served (pubkey, track, day, delivered, reported, billed) VALUES (?, 'song.mp3', ?, ?, 0, 0)").run(free.address, today - 2, LEN);
  await billUnreported(DB, { ...opts, perMinute: async () => 0 });
  ok("nothing billed while the wallet's price is 0, and it isn't marked billed either", owed(free).micros === 0 && row(free).billed === 0, JSON.stringify([owed(free), row(free)]));

  // The page couldn't be read: nothing is billed, and the rows aren't pruned unlooked-at.
  const kept = await makeWallet();
  sqlite.prepare("INSERT INTO served (pubkey, track, day, delivered, reported, billed) VALUES (?, 'song.mp3', ?, ?, 0, 0)").run(kept.address, today - SERVED_KEEP_DAYS, LEN);
  await pruneStale(DB, clock, async () => { throw new Error("no page"); });
  ok("a prune that couldn't bill first keeps the rows for next time", rows(kept).length === 1, JSON.stringify(rows(kept)));
  ok("the grace is far inside the days kept", UNREPORTED_GRACE_MS < (SERVED_KEEP_DAYS - 1) * DAY);
}

// ── ranges that add up to the whole file ────────────────────────────────────
{
  const w = await makeWallet();
  const before = flushes;
  // As a player asks for them: one after another, faster than the gap.
  for (let at = 0; at < LEN * 1000; at += 24_000) await audio(w, "song.mp3", { Range: `bytes=${at}-${at + 23_999}` }, { settle: false });
  await settled();
  ok("ten ranges of 24 s: all 240 s counted", near(row(w)?.delivered ?? 0, LEN), JSON.stringify(row(w)));
  ok("  in a couple of writes, not ten", flushes - before <= 3, `${flushes - before}`);
  await later(w);
  ok("  never reported: billed like a whole file (156 s), a day later", owed(w).micros === 156_000, JSON.stringify(owed(w)));

  // A response abandoned early counts what was sent, not what was asked for.
  const a = await makeWallet();
  const res = await call(`/audio/song.mp3?t=${encodeURIComponent(a.token)}`, { headers: { Range: "bytes=0-" } });
  ok("  (a ranged request is a 206)", res.status === 206 && res.headers.get("Content-Range") === `bytes 0-${LEN * 1000 - 1}/${LEN * 1000}`);
  const reader = res.body.getReader();
  await reader.read(); await reader.read();
  await reader.cancel();
  await settled();
  await played(a, 30, "s");
  const got = row(a);
  ok("a request abandoned after a few pieces counts those, not the whole range", got && got.delivered > 0 && got.delivered < 60, JSON.stringify(got));
  ok("  and the report, carrying them, bills the 30 s heard", owed(a).micros === 30_000, JSON.stringify(owed(a)));
}

// ── seeking back: sent again is counted again, up to three plays' worth ─────
{
  const w = await makeWallet();
  await audio(w, "song.mp3", { Range: "bytes=0-119999" });
  tick(FLUSH.gapMs);
  await audio(w, "song.mp3", { Range: "bytes=0-119999" });
  ok("the same first half fetched twice counts twice (240 s sent)", near(row(w).delivered, LEN), JSON.stringify(row(w)));
  for (let i = 0; i < 5; i++) { tick(FLUSH.gapMs); await audio(w, "song.mp3"); }
  ok(`  but never more than ${DELIVERED_CAP}x the song a day (720 s)`, row(w).delivered === DELIVERED_CAP * LEN, JSON.stringify(row(w)));
  const writes = flushes;
  for (let i = 0; i < 3; i++) { tick(FLUSH.gapMs); await audio(w, "song.mp3"); }
  ok("  and past the cap, nothing more is written", flushes === writes, `${flushes - writes}`);
  await later(w);
  ok("  never reported, it's billed at most 3x less the slack", owed(w).micros === (DELIVERED_CAP * LEN - SLACK_S) * 1000, JSON.stringify(owed(w)));
}

// ── what's never metered ────────────────────────────────────────────────────
{
  const w = await makeWallet();
  const before = { flushes, batches };
  const head = await audio(w, "song.mp3", {}, { method: "HEAD" });
  ok("a HEAD: answered, nothing counted", head.res.status === 200 && !rows(w).length);
  const notModified = await audio(w, "song.mp3", { "If-None-Match": '"e1"' });
  ok("a 304: nothing counted", notModified.res.status === 304 && !rows(w).length, `${notModified.res.status}`);
  const free = await audio(w, "free.mp3");
  ok("a free song, even with a pass: nothing counted", free.res.status === 200 && free.bytes === LEN * 1000 && !rows(w).length);
  const nobody = await audio(null, "song.mp3");
  ok("no wallet: refused, nothing counted", nobody.res.status === 401 && sqlite.prepare("SELECT COUNT(*) AS n FROM served WHERE pubkey = ''").get().n === 0);
  const sub = await makeWallet();
  sqlite.prepare("INSERT INTO subscriptions (wallet, subscription, customer, until, updated) VALUES (?, 'sub_x', 'cus_x', ?, ?)").run(sub.address, clock + 30 * DAY, clock);
  await audio(sub, "song.mp3");
  ok("a subscriber's paid songs: nothing counted, so never billed later at a price", !rows(sub).length, JSON.stringify(rows(sub)));
  const unsatisfiable = await audio(w, "song.mp3", { Range: `bytes=${LEN * 1000 + 5}-` });
  ok("an unsatisfiable range (416): nothing counted", unsatisfiable.res.status === 416 && !rows(w).length, `${unsatisfiable.res.status}`);

  // The artist's own route, signed in.
  const { PREVIEW_KEY, hashKey } = await import("./src/preview-key.ts");
  const KEY = "Q".repeat(43);
  await putSetting(DB, PREVIEW_KEY, JSON.stringify({ hash: await hashKey(KEY), until: clock + 3_600_000 }));
  const servedBefore = sqlite.prepare("SELECT COUNT(*) AS n FROM served").get().n;
  const own = await call("/manage/audio/song.mp3", { headers: { Cookie: `amply_preview=${KEY}` } });
  const ownBytes = (await own.arrayBuffer()).byteLength;
  await settled();
  ok("the artist's own copy (/manage/audio): played, nothing counted", own.status === 200 && ownBytes === LEN * 1000
    && sqlite.prepare("SELECT COUNT(*) AS n FROM served").get().n === servedBefore);
  ok("  and none of that wrote anything", flushes === before.flushes && batches === before.batches, `${flushes - before.flushes} / ${batches - before.batches}`);
}

// ── no duration published: counted at the streaming bitrate ─────────────────
{
  const w = await makeWallet();
  await audio(w, "nolength.mp3");
  // 100 s at 256 kbps; slack 60 s; 40 s billed.
  await later(w);
  ok("a song with no published length is counted at 256 kbps", near(row(w, "nolength.mp3")?.delivered ?? 0, 100) && owed(w).micros === 40_000, JSON.stringify([row(w, "nolength.mp3"), owed(w)]));
}

// ── the write budget ────────────────────────────────────────────────────────
{
  const w = await makeWallet();
  const before = flushes;
  // 200 tiny requests, 4 s each, as fast as they come: 800 s asked for.
  for (let i = 0; i < 200; i++) {
    const at = (i * 4000) % (LEN * 1000);
    await call(`/audio/song.mp3?t=${encodeURIComponent(w.token)}`, { headers: { Range: `bytes=${at}-${at + 3999}` } }).then((r) => r.arrayBuffer());
    if (i % 20 === 0) tick(1_000);
  }
  await settled();
  const n = flushes - before;
  const bound = Math.ceil((DELIVERED_CAP * LEN) / Math.max(FLUSH.seconds, FLUSH.share * LEN)) + 2;
  ok(`200 tiny ranges: a bounded number of writes (${n}, at most ${bound})`, n > 0 && n <= bound, `${n}`);
  ok("  and what they add up to, to the cap, is counted", row(w).delivered === DELIVERED_CAP * LEN, JSON.stringify(row(w)));
  const more = flushes;
  for (let i = 0; i < 200; i++) {
    await call(`/audio/song.mp3?t=${encodeURIComponent(w.token)}`, { headers: { Range: "bytes=0-3999" } }).then((r) => r.arrayBuffer());
  }
  await settled();
  ok("  200 more past the cap: no more writes at all", flushes === more, `${flushes - more}`);

  // Ranges coming faster than the gap allows are written once the gap is up,
  // not dropped.
  const q = await makeWallet();
  const b2 = flushes;
  await audio(q, "two.mp3", { Range: "bytes=0-49999" });
  await audio(q, "two.mp3", { Range: "bytes=50000-99999" });
  ok("two big ranges inside the gap: the second waits, then is written", near(row(q, "two.mp3").delivered, 100) && flushes - b2 === 2, JSON.stringify(row(q, "two.mp3")));
}

// ── the pass says what's owed; Auto-block sees what was metered ─────────────
{
  const w = await makeWallet();
  await audio(w, "three.mp3");
  const first = await (await listen("/token", await signed(w))).json();
  ok("a pass carries what's still owed, in micros (nothing yet: the day's not over)", first.token && first.owes === 0, JSON.stringify(first));
  const pass = (await later(w)).body;
  ok("  a day on, the metered 156 s of a wallet that never reported", pass.token && pass.owes === 156_000, JSON.stringify(pass));
  await recordPaid(DB, w.address, 100_000, "sig-paid-1");
  ok("  less what's been paid", (await (await listen("/token", await signed(w))).json()).owes === 56_000);
  const stranger = await makeWallet();
  ok("  and 0 for a wallet with nothing owed", (await (await listen("/token", await signed(stranger))).json()).owes === 0);

  // A copier with no reports, with Auto-block on: refused once what it took,
  // less the slack, is billed (a day after) and past the line (1.5 x 10c).
  await setAutoBlock(DB, true);
  const ripper = await makeWallet();
  ok("(Auto-block on: a new wallet gets a pass)", (await listen("/token", await signed(ripper))).status === 200);
  await audio(ripper, "song.mp3");
  tick(FLUSH.gapMs);
  await audio(ripper, "two.mp3");
  ok("  songs taken: still served that day", (await listen("/token", await signed(ripper))).status === 200);
  const billed = await later(ripper);
  ok("  a day on: billed for them (2 x 156 s), told so with its pass", billed.status === 200 && billed.body.owes === 312_000, JSON.stringify(billed));
  const refused = await listen("/token", await signed(ripper));
  const body = await refused.json();
  ok("  and auto-blocked at its next pass", refused.status === 403 && body.code === "unpaid" && body.owes === 312_000, JSON.stringify(body));
  await recordPaid(DB, ripper.address, body.owes, "sig-ripper");
  ok("  paying it lifts it, as for any listener", (await listen("/token", await signed(ripper))).status === 200);

  // An honest listener with Auto-block on: skips read ahead whole never block them.
  const fan = await makeWallet();
  await listen("/token", await signed(fan));
  for (const f of ["song.mp3", "two.mp3", "three.mp3"]) { tick(FLUSH.gapMs); await audio(fan, f); await played(fan, 5, f === "song.mp3" ? "s" : f.split(".")[0]); }
  const fine = await later(fan);
  ok("an honest listener who skipped three songs read ahead whole: owes 15 s, still served", fine.status === 200 && fine.body.owes === 15_000, JSON.stringify(fine));
  await setAutoBlock(DB, false);
}

// ── paused: free to hear, nothing metered ───────────────────────────────────
{
  const w = await makeWallet();
  lamports = 0;
  await feeBalance(async () => ({ value: 0 }), FEES, { fresh: true });
  tick(6_000);   // past the isolate's copy of the manifest
  const got = await audio(w, "song.mp3");
  ok("payments paused: a paid song plays free, and nothing is counted", got.res.status === 200 && !rows(w).length, JSON.stringify(rows(w)));
  lamports = OFFER_ABOVE_LAMPORTS + 1_000_000;
  await feeBalance(async () => ({ value: lamports }), FEES, { fresh: true });
  tick(6_000);
}

// ── a report that doesn't say which song (an app from before) ───────────────
{
  const w = await makeWallet();
  await audio(w, "two.mp3");
  await played(w, LEN);
  ok("an old app's report goes with the song just sent: billed once", owed(w).micros === LEN * 1000 && Math.floor(row(w, "two.mp3").reported) === LEN, JSON.stringify([rows(w), owed(w)]));
  const x = await makeWallet();
  await played(x, 90);
  ok("  with nothing sent, it stands on its own and is billed as reported", owed(x).micros === 90_000 && rows(x).length === 1 && rows(x)[0].track === "", JSON.stringify(rows(x)));
}

// ── a play that runs past midnight ──────────────────────────────────────────
{
  const w = await makeWallet();
  await audio(w, "three.mp3");
  tick(DAY);
  w.token = await issueToken(DB, w.address);
  await played(w, LEN, "three");
  ok("reported the next day: goes with yesterday's row, billed once", owed(w).micros === LEN * 1000 && rows(w).length === 1, JSON.stringify(rows(w)));
}

// ── kept three days; erased on request; shown to the listener ───────────────
{
  const w = await makeWallet();
  await audio(w, "song.mp3");
  await audio(w, "two.mp3");
  const mine = await (await listen("/mine", await signed(w))).json();
  ok("/listen/mine counts the songs sent in the last three days", mine.held?.servedTracks === 2, JSON.stringify(mine.held));
  ok("  and says what's kept, and for how long", /three days/.test(mine.notHeld) && /three days/.test(mine.keptFor), `${mine.notHeld} | ${mine.keptFor}`);
  const quiet = await makeWallet();
  await audio(quiet, "song.mp3", { Range: "bytes=0-29999" });
  await played(quiet, 1, "s");   // carries the 30 s this copy hadn't written
  sqlite.prepare("DELETE FROM listeners WHERE pubkey = ?").run(quiet.address);
  sqlite.prepare("DELETE FROM owed WHERE pubkey = ?").run(quiet.address);
  const theirs = await (await listen("/mine", await signed(quiet))).json();
  ok("  even for a wallet with no totals yet", theirs.held?.servedTracks === 1, JSON.stringify(theirs.held));

  const r = await listen("/forget", await signed(w));
  ok("erasing deletes what was sent too", r.status === 204 && rows(w).length === 0, JSON.stringify(rows(w)));

  const today = servedDay(clock);
  const old = await makeWallet();
  for (const d of [today - SERVED_KEEP_DAYS - 1, today - SERVED_KEEP_DAYS, today - SERVED_KEEP_DAYS + 1, today]) {
    sqlite.prepare("INSERT INTO served (pubkey, track, day, delivered, reported, billed) VALUES (?, 'song.mp3', ?, 10, 0, 0)").run(old.address, d);
  }
  await pruneStale(DB, clock);
  ok("rows past three days are pruned; the last three days kept", JSON.stringify(rows(old).map((x) => x.day)) === JSON.stringify([today - 2, today]), JSON.stringify(rows(old).map((x) => today - x.day)));
  sqlite.prepare("INSERT INTO served (pubkey, track, day, delivered, reported, billed) VALUES (?, 'x', ?, 1, 0, 0)").run(old.address, today - 10);
  tick(2 * 3_600_000);
  ok("  by the hourly prune", (await pruneHourly(DB, clock)) && !rows(old).some((x) => x.day === today - 10));

  const notice = renderPrivacy(manifest, ORIGIN, "n");
  ok("the privacy notice says what's sent is kept, and for three days", /how many seconds of each paid track it sent/.test(notice) && /deleted automatically after three days/.test(notice));
}

// ── a database without the table: metering is off, the audio still plays ───
{
  resetTallies();
  const bare = new DatabaseSync(":memory:");
  for (const s of SCHEMA) if (!/CREATE TABLE IF NOT EXISTS served/.test(s)) bare.exec(s);
  const BARE = d1(bare);
  await putSetting(BARE, "manifest", JSON.stringify(manifest));
  const bareEnv = { DB: BARE, MEDIA };
  tick(6_000);
  const w = await makeWallet();
  w.token = await issueToken(BARE, w.address);
  const got = await audio(w, "song.mp3", {}, { e: bareEnv });
  ok("no served table: the paid song is served whole all the same", got.res.status === 200 && got.bytes === LEN * 1000);
  const r = await played(w, 200, "s", bareEnv);
  const o = bare.prepare("SELECT micros, seconds FROM owed WHERE pubkey = ?").get(w.address);
  ok("  and a report is billed as it always was", r.status === 204 && o?.micros === 200_000 && o?.seconds === 200, JSON.stringify(o));
  const mine = await (await listen("/mine", await signed(w), bareEnv)).json();
  ok("  /listen/mine still answers", mine.held?.plays === 1 && mine.held?.servedTracks === 0, JSON.stringify(mine.held));
  tick(6_000);
}

Date.now = realNow;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
