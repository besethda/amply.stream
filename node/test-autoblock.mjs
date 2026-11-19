/**
 * Auto-block: with it on, the artist's server stops serving listeners who are
 * behind on paying (spec/standing.mjs), until they pay.
 *
 * Getting this wrong in one direction refuses honest listeners — someone who
 * paid, a subscriber, someone who can't pay because the artist's fees account
 * is empty — and in the other lets a payment be counted twice, or someone
 * else's payment, or a tip, as paying for listening. This drives the real
 * Worker, on SQLite with the node's own schema, with only the network stood
 * in for.
 *
 *   npm run test:paused   (runs this too)
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import worker from "./src/index.ts";
import { SCHEMA, putSetting, listener, paidOf, recordPaid, mergePaid, forget, remove, pruneStale } from "./src/store.ts";
import { feeAddress, OFFER_ABOVE_LAMPORTS, DAILY_PAYMENTS, dayKey } from "./src/settle.ts";
import { base58 } from "./src/solana-tx.ts";
import { TOKEN_PROGRAM, MEMO_PROGRAM } from "../spec/chains.mjs";
import { RULES } from "./src/limits.ts";

const require = createRequire(resolve("app/package.json"));
const web3 = require("@solana/web3.js");
const spl = require("@solana/spl-token");
const { Keypair, Transaction, PublicKey } = web3;

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

function d1(sqlite) {
  return {
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
  };
}
const MEDIA_KV = {
  async get() { return null; }, async getWithMetadata() { return { value: null, metadata: null }; },
  async put() {}, async delete() {}, async list() { return { keys: [], list_complete: true }; },
};
const sqlite = new DatabaseSync(":memory:");
for (const s of SCHEMA) sqlite.exec(s);
const DB = d1(sqlite);
const env = { DB, MEDIA_KV };

const ORIGIN = "https://artist.test";
const HOST = "artist.test";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const artist = Keypair.generate();
const ARTIST = artist.publicKey.toBase58();
const ata = (owner, mint = USDC) => spl.getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true).toBase58();
const ARTIST_ATA = ata(ARTIST);

// 1 cent a minute; the app pays every 50 cents, so "behind" is over 75 cents unpaid.
const RATE = 0.01, POINT = 0.5;
const manifest = (payment = { type: "solana-usdc", address: ARTIST, ratePerMinute: RATE, settleAt: POINT }) => ({
  amply: 1, artist: { name: "A" }, payment: payment ? [payment] : [],
  releases: [{ id: "r", title: "R", tracks: [{ id: "s", title: "S", url: `${ORIGIN}/audio/song.mp3` }] }],
});
const publish = async (m) => { await putSetting(DB, "manifest", JSON.stringify(m)); await new Promise((r) => setTimeout(r, 5_100)); };
await putSetting(DB, "manifest", JSON.stringify(manifest()));
const FEES = await feeAddress(DB);

// ── the network ──
let lamports = OFFER_ABOVE_LAMPORTS + 1_000_000;
const txs = new Map();          // signature → what getTransaction answers
let gets = 0, sendFails = false;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init?.body || "{}");
  const answer = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  switch (body.method) {
    case "getBalance": return answer({ value: lamports });
    case "getTransaction": gets++; return answer(txs.get(body.params[0]) ?? null);
    case "getMultipleAccounts": return answer({ value: body.params[0].map(() => ({ lamports: 2039280 })) });
    case "simulateTransaction": return answer({ value: { err: null, logs: [] } });
    case "sendTransaction": if (sendFails) throw new TypeError("fetch failed"); return answer("sent");
    case "getSignatureStatuses": return answer({ value: [{ confirmationStatus: "confirmed", err: null }] });
    default: throw new Error(`unexpected ${url} ${body.method}`);
  }
};

// ── listeners, as the app would be ──
const PKCS8 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
async function makeWallet() {
  const kp = Keypair.generate();
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from([...PKCS8, ...kp.secretKey.slice(0, 32)]), "Ed25519", false, ["sign"]);
  return { kp, address: kp.publicKey.toBase58(), key };
}
let ipN = 0;
const nextIp = () => `198.51.${Math.floor(++ipN / 250)}.${ipN % 250}`;
async function signed(w, extra = {}) {
  const message = `amply:${HOST}:${Date.now()}:${crypto.randomUUID()}`;
  const signature = base58(new Uint8Array(await crypto.subtle.sign("Ed25519", w.key, new TextEncoder().encode(message))));
  return JSON.stringify({ address: w.address, message, signature, ...extra });
}
const listen = async (path, body, ip = nextIp()) => worker.fetch(new Request(`${ORIGIN}/listen${path}`, {
  method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip }, body,
}), env);
const askPass = async (w) => listen("/token", await signed(w));
const passFor = async (w) => { const r = await askPass(w); return { status: r.status, body: await r.json() }; };

const DAY = 86_400_000;
function known(w, { owed = 0, seconds = 600, lastSeen = Date.now(), blocked = 0 } = {}) {
  sqlite.prepare("INSERT OR REPLACE INTO listeners (pubkey, plays, seconds, first_seen, last_seen, blocked) VALUES (?, 3, ?, ?, ?, ?)")
    .run(w.address, seconds, lastSeen - DAY, lastSeen, blocked);
  sqlite.prepare("INSERT OR REPLACE INTO owed (pubkey, micros, seconds) VALUES (?, ?, ?)").run(w.address, owed, seconds);
}
const lastSeenOf = (w) => sqlite.prepare("SELECT last_seen FROM listeners WHERE pubkey = ?").get(w.address)?.last_seen;

// ── the editor, signed in with the key from setup ──
const { PREVIEW_KEY, hashKey } = await import("./src/preview-key.ts");
const KEY = "Q".repeat(43);
await putSetting(DB, PREVIEW_KEY, JSON.stringify({ hash: await hashKey(KEY), until: Date.now() + 3 * 3_600_000 }));
const manage = (path, { method = "GET", body, origin = ORIGIN } = {}) => worker.fetch(new Request(`${ORIGIN}/manage${path}`, {
  method, body: body === undefined ? undefined : JSON.stringify(body),
  headers: { Cookie: `amply_preview=${KEY}`, "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
}), env);
const setAuto = async (enabled, paid) => manage("/autoblock", { method: "POST", body: paid === undefined ? { enabled } : { enabled, paid } });
const rowsNow = async () => (await (await manage("/listeners")).json());
const rowOf = async (w) => (await rowsNow()).find((r) => r.pubkey === w.address);

// ── off by default, and how it's turned on ──────────────────────────────────
{
  const got = await (await manage("/autoblock")).json();
  ok("Auto-block is off until the artist turns it on", got.enabled === false && got.since === null, JSON.stringify(got));
  const behind = await makeWallet();
  known(behind, { owed: 5_000_000 });
  ok("  off: a wallet that's far behind still gets a pass", (await passFor(behind)).status === 200);

  ok("turning it on without saying who has paid is refused", (await setAuto(true)).status === 409);
  ok("  as is a malformed list of who paid", (await setAuto(true, { "not-a-wallet": 5 })).status === 400
    && (await setAuto(true, { [ARTIST]: 1.5 })).status === 400 && (await setAuto(true, { [ARTIST]: -1 })).status === 400
    && (await setAuto(true, [1, 2])).status === 400);
  const tooMany = Object.fromEntries(Array.from({ length: 1001 }, () => [Keypair.generate().publicKey.toBase58(), 1]));
  ok("  and more than a thousand wallets at once", (await setAuto(true, tooMany)).status === 400);
  ok("  and a request from another site", (await manage("/autoblock", { method: "POST", body: { enabled: true, paid: {} }, origin: "https://evil.test" })).status === 403);
  ok("  and still off after all that", (await (await manage("/autoblock")).json()).enabled === false);
  const on = await setAuto(true, {});
  const onBody = await on.json();
  ok("with what the chain says (here: nobody has paid), it goes on, noting since when", on.status === 200 && onBody.enabled === true && onBody.since > 0, JSON.stringify(onBody));
  ok("  and asking again says so", (await (await manage("/autoblock")).json()).enabled === true);
  ok("  once on, saying on again needs no list", (await setAuto(true)).status === 200);

  // ── refused, told what's owed ──
  const before = lastSeenOf(behind);
  const r = await passFor(behind);
  ok("on: a wallet $5 behind is refused a pass, 403", r.status === 403, JSON.stringify(r));
  ok("  with code \"unpaid\" and what it owes, in micros", r.body.code === "unpaid" && r.body.owes === 5_000_000, JSON.stringify(r.body));
  ok("  and plain words for a person", /owe this artist \$5\.00/.test(r.body.error || ""), r.body.error);
  ok("  without noting the visit (which would make it look recently heard)", lastSeenOf(behind) === before);
  const row = await rowOf(behind);
  ok("the editor sees it auto-blocked, and what it owes", row?.auto_blocked === true && row?.owes_micros === 5_000_000, JSON.stringify(row));
  ok("  and auto-blocking never writes the manual block", row?.blocked === 0);

  // ── turning it off lifts it ──
  await setAuto(false);
  ok("turned off: served again at once", (await passFor(behind)).status === 200);
  ok("  and not shown as auto-blocked", (await rowOf(behind))?.auto_blocked === false);
  await setAuto(true, {});
}

// ── who is never refused ────────────────────────────────────────────────────
{
  const stranger = await makeWallet();
  ok("a wallet this server has never seen is never auto-blocked", (await passFor(stranger)).status === 200);

  const light = await makeWallet();
  known(light, { owed: 600_000 });
  ok("owing less than one and a half payments (60c of a 50c point): served", (await passFor(light)).status === 200);

  const paidUp = await makeWallet();
  known(paidUp, { owed: 5_000_000 });
  await mergePaid(DB, { [paidUp.address]: 5_000_000 });
  ok("paid up in full: served", (await passFor(paidUp)).status === 200);
  const over = await makeWallet();
  known(over, { owed: 1_000_000 });
  await mergePaid(DB, { [over.address]: 9_000_000 });
  ok("paid more than it owes: served, owing nothing", (await passFor(over)).status === 200 && (await rowOf(over))?.owes_micros === 0);

  const sub = await makeWallet();
  known(sub, { owed: 5_000_000 });
  sqlite.prepare("INSERT INTO subscriptions (wallet, subscription, customer, until, updated) VALUES (?, 'sub_a', 'cus_a', ?, ?)").run(sub.address, Date.now() + 30 * DAY, Date.now());
  ok("a subscriber owing from before they subscribed: served", (await passFor(sub)).status === 200);
  ok("  and not shown as auto-blocked", (await rowOf(sub))?.auto_blocked === false);
  sqlite.prepare("UPDATE subscriptions SET until = ? WHERE wallet = ?").run(Date.now() - DAY, sub.address);
  ok("  once the subscription has ended, the debt counts again", (await passFor(sub)).status === 403);

  // Manual blocks are the artist's, and separate.
  const barred = await makeWallet();
  known(barred, { owed: 5_000_000, blocked: 1 });
  const b = await passFor(barred);
  ok("a wallet blocked by hand gets the manual refusal, not \"unpaid\"", b.status === 403 && b.body.code === undefined && /stopped serving/.test(b.body.error), JSON.stringify(b.body));
  await mergePaid(DB, { [barred.address]: 50_000_000 });
  ok("  and paying never lifts a manual block", (await passFor(barred)).status === 403);
  ok("  nor is it shown as auto-blocked", (await rowOf(barred))?.auto_blocked === false);
}

// ── overdue ─────────────────────────────────────────────────────────────────
{
  const late = await makeWallet();
  known(late, { owed: 300_000, lastSeen: Date.now() - 10 * DAY });
  const r = await passFor(late);
  ok("30c owed, last heard ten days ago: overdue, refused", r.status === 403 && r.body.code === "unpaid" && r.body.owes === 300_000, JSON.stringify(r.body));
  const recent = await makeWallet();
  known(recent, { owed: 300_000, lastSeen: Date.now() - 3 * DAY });
  ok("  the same, three days ago: the week isn't up, served", (await passFor(recent)).status === 200);
  const crumbs = await makeWallet();
  known(crumbs, { owed: 9_000, lastSeen: Date.now() - 30 * DAY });
  ok("  under a cent, a month old: can't be paid on its own, served", (await passFor(crumbs)).status === 200);
  // A record whose listening was erased: when it was here isn't known.
  const erased = await makeWallet();
  known(erased, { owed: 300_000, lastSeen: 0 });
  ok("  last seen 0 (an erased record): not overdue, served", (await passFor(erased)).status === 200);
  const erasedBlocked = await makeWallet();
  known(erasedBlocked, { owed: 0, seconds: 0, lastSeen: 0, blocked: 1 });
  const eb = await passFor(erasedBlocked);
  ok("  an erased-but-blocked record: the manual block, nothing owed", eb.status === 403 && eb.body.code === undefined);
}

// ── when nobody can pay, nobody is refused for not paying ──────────────────
{
  const w = await makeWallet();
  known(w, { owed: 5_000_000 });
  ok("(this wallet is refused while payments are possible)", (await passFor(w)).status === 403);

  await publish(manifest({ type: "solana-usdc", address: ARTIST, ratePerMinute: 0, settleAt: POINT }));
  ok("a price of 0: nothing is owed, served", (await passFor(w)).status === 200);
  await publish(manifest(null));
  ok("no USDC price at all: served", (await passFor(w)).status === 200);
  await publish(manifest());
  ok("(priced again: refused)", (await passFor(w)).status === 403);

  // The fees account empty: the price is served paused, and nobody can pay.
  lamports = 0;
  const { feeBalance } = await import("./src/settle.ts");
  await feeBalance(async () => ({ value: 0 }), FEES, { fresh: true });
  ok("the fees account can't pay network fees (paused): served", (await passFor(w)).status === 200);
  ok("  and not shown as auto-blocked", (await rowOf(w))?.auto_blocked === false);
  lamports = OFFER_ABOVE_LAMPORTS + 1_000_000;
  await feeBalance(async () => ({ value: lamports }), FEES, { fresh: true });
  ok("(fees back: refused)", (await passFor(w)).status === 403);

  // Today's network fees used up: nobody can pay until tomorrow.
  sqlite.prepare("INSERT OR REPLACE INTO fee_days (day, count) VALUES (?, ?)").run(dayKey("pay", Date.now()), DAILY_PAYMENTS);
  ok("today's fees all paid: nobody can pay until tomorrow, served", (await passFor(w)).status === 200);
  sqlite.prepare("DELETE FROM fee_days WHERE day = ?").run(dayKey("pay", Date.now()));
}

// ── a historic payer the server never saw ───────────────────────────────────
{
  await setAuto(false);
  const old = await makeWallet();
  known(old, { owed: 3_000_000 });
  const res = await setAuto(true, { [old.address]: 3_000_000 });
  ok("turned on with what the chain says: someone who paid another way isn't refused",
    res.status === 200 && (await passFor(old)).status === 200);
  ok("  the total is kept against their wallet", (await paidOf(DB, old.address)) === 3_000_000);
  await manage("/paid", { method: "POST", body: { paid: { [old.address]: 1_000_000 } } });
  ok("  a later, smaller reading never lowers it (paid only grows)", (await paidOf(DB, old.address)) === 3_000_000);
  await manage("/paid", { method: "POST", body: { paid: { [old.address]: 3_500_000 } } });
  ok("  a larger one raises it", (await paidOf(DB, old.address)) === 3_500_000);
  const nobody = Keypair.generate().publicKey.toBase58();
  const merged = await manage("/paid", { method: "POST", body: { paid: { [nobody]: 1_000_000 } } });
  ok("  nothing is kept about a wallet that has never listened here", merged.status === 200 && !sqlite.prepare("SELECT 1 FROM paid WHERE pubkey = ?").get(nobody));
  ok("  and a malformed one is refused", (await manage("/paid", { method: "POST", body: { paid: { [nobody]: "lots" } } })).status === 400);
}

// ── paying through the node (/listen/settle) ───────────────────────────────
const feePayer = new PublicKey(FEES);
function payment(w, micros, { memo } = {}) {
  const t = new Transaction({ feePayer, recentBlockhash: Keypair.generate().publicKey.toBase58() });
  t.add(spl.createAssociatedTokenAccountIdempotentInstruction(feePayer, new PublicKey(ARTIST_ATA), artist.publicKey, new PublicKey(USDC)));
  t.add(spl.createTransferCheckedInstruction(new PublicKey(ata(w.address)), new PublicKey(USDC), new PublicKey(ARTIST_ATA), w.kp.publicKey, micros, 6));
  if (memo) t.add(new web3.TransactionInstruction({ keys: [{ pubkey: w.kp.publicKey, isSigner: true, isWritable: false }], programId: new PublicKey(MEMO_PROGRAM), data: Buffer.from(memo) }));
  t.partialSign(w.kp);
  return Buffer.from(t.serialize({ requireAllSignatures: false })).toString("base64");
}
const settleAs = async (w, micros, extra = {}, opts = {}) => {
  const r = await listen("/settle", JSON.stringify({ tx: payment(w, micros, opts), ...extra }));
  return { status: r.status, body: await r.json() };
};
let unconfirmedSig = null, payerOfUnconfirmed = null;
{
  const w = await makeWallet();
  known(w, { owed: 3_000_000 });
  const first = await passFor(w);
  ok("a listener $3 behind is refused", first.status === 403 && first.body.owes === 3_000_000);
  const one = await settleAs(w, 2_000_000);
  ok("  their app pays $2 through the node: settled, confirmed", one.status === 200 && one.body.confirmed === true, JSON.stringify(one));
  ok("  and the node counts it", (await paidOf(DB, w.address)) === 2_000_000);
  const still = await passFor(w);
  ok("  $1 still owed is more than the app may hold back (75c): refused, owing $1", still.status === 403 && still.body.owes === 1_000_000, JSON.stringify(still.body));
  await settleAs(w, 1_000_000);
  ok("  paid in a second payment: served again", (await passFor(w)).status === 200 && (await paidOf(DB, w.address)) === 3_000_000);

  // A tip and a purchase are paid through the same route; neither is paying for listening.
  const tipper = await makeWallet();
  known(tipper, { owed: 2_500_000 });
  const tipped = await settleAs(tipper, 1_000_000, { tip: true }, { memo: `amply:tip:${HOST}` });
  ok("a tip goes through", tipped.status === 200, JSON.stringify(tipped));
  ok("  but isn't counted as paying for listening", (await paidOf(DB, tipper.address)) === 0);
  ok("  so they're still refused", (await passFor(tipper)).status === 403);

  // Sent, but not seen to land: not counted until it's reported.
  sendFails = true;
  const lost = await settleAs(tipper, 2_000_000);
  sendFails = false;
  ok("a payment whose send wasn't seen to land comes back unconfirmed", lost.status === 200 && lost.body.confirmed === false, JSON.stringify(lost));
  ok("  and isn't counted yet", (await paidOf(DB, tipper.address)) === 0);
  unconfirmedSig = lost.body.signature;
  payerOfUnconfirmed = tipper;
}

// ── a payment reported by the app (/listen/paid) ───────────────────────────
const parsedTx = ({ payer, transfers = [[ARTIST_ATA, 2_000_000]], mint = USDC, memo, ageMs = 60_000, err = null, signer = true, program = "spl-token" }) => ({
  blockTime: Math.floor((Date.now() - ageMs) / 1000),
  meta: { err, innerInstructions: [], postTokenBalances: [] },
  transaction: { message: {
    accountKeys: [{ pubkey: FEES, signer: true }, { pubkey: payer, signer }],
    instructions: [
      { program: "spl-associated-token-account", parsed: { type: "createIdempotent", info: {} } },
      ...transfers.map(([destination, amount]) => ({
        program, programId: program === "spl-token" ? TOKEN_PROGRAM : "11111111111111111111111111111111",
        parsed: { type: "transferChecked", info: { authority: payer, destination, source: "Src1111", mint, tokenAmount: { amount: String(amount) } } },
      })),
      ...(memo ? [{ program: "spl-memo", programId: MEMO_PROGRAM, parsed: memo }] : []),
    ],
  } },
});
const newSig = () => base58(crypto.getRandomValues(new Uint8Array(64)));
const report = async (signature, ip = nextIp()) => {
  const r = await listen("/paid", JSON.stringify({ signature }), ip);
  return { status: r.status, body: await r.json() };
};
{
  const w = payerOfUnconfirmed;
  txs.set(unconfirmedSig, parsedTx({ payer: w.address }));
  const before = gets;
  const r = await report(unconfirmedSig);
  ok("the app reports the unconfirmed payment once it lands: counted", r.status === 200 && r.body.recorded === true && r.body.wallet === w.address
    && r.body.micros === 2_000_000 && !("paidMicros" in r.body) && (await paidOf(DB, r.body.wallet)) === 2_000_000, JSON.stringify(r));
  ok("  having asked the network exactly once", gets === before + 1, `${gets - before}`);
  ok("  and now they're served", (await passFor(w)).status === 200);
  const again = await report(unconfirmedSig);
  ok("reported again: not counted twice", again.status === 200 && again.body.recorded === false && (await paidOf(DB, w.address)) === 2_000_000, JSON.stringify(again));
  ok("  and without asking the network again", gets === before + 1);

  // A payment the node settled and counted, reported too: once.
  const s = await makeWallet();
  known(s, { owed: 3_000_000 });
  const settled = await settleAs(s, 2_000_000);
  txs.set(settled.body.signature, parsedTx({ payer: s.address }));
  const dup = await report(settled.body.signature);
  ok("a settled payment the app also reports: counted once", dup.body.recorded === false && (await paidOf(DB, s.address)) === 2_000_000, JSON.stringify(dup));

  // Someone else reporting your payment only ever credits you.
  const payer = await makeWallet(), other = await makeWallet();
  known(payer, { owed: 3_000_000 });
  known(other, { owed: 3_000_000 });
  const sig = newSig();
  txs.set(sig, parsedTx({ payer: payer.address }));
  const theirs = await report(sig, "203.0.113.99");
  ok("someone else's payment, reported from anywhere: credited to who paid it", theirs.body.wallet === payer.address
    && (await paidOf(DB, payer.address)) === 2_000_000 && (await paidOf(DB, other.address)) === 0, JSON.stringify(theirs));
  ok("  so it can't be replayed to lift another wallet", (await passFor(other)).status === 403);

  // Not paying for listening, or not paying this artist.
  const tries = [
    ["in another token", parsedTx({ payer: payer.address, mint: "So11111111111111111111111111111111111111112" })],
    ["to someone else", parsedTx({ payer: payer.address, transfers: [[ata(Keypair.generate().publicKey.toBase58()), 2_000_000]] })],
    ["to the artist and someone else (a withdrawal's fee)", parsedTx({ payer: payer.address, transfers: [[ata(Keypair.generate().publicKey.toBase58()), 2_000_000], [ARTIST_ATA, 50_000]] })],
    ["with a note (a tip)", parsedTx({ payer: payer.address, memo: `amply:tip:${HOST}` })],
    ["with a note (a purchase)", parsedTx({ payer: payer.address, memo: `amply:buy:${HOST}:r` })],
    ["that failed on the network", parsedTx({ payer: payer.address, err: { InstructionError: [1, "x"] } })],
    ["from long ago", parsedTx({ payer: payer.address, ageMs: 30 * DAY })],
    ["not signed by the wallet it's from", parsedTx({ payer: payer.address, signer: false })],
    ["the artist's own money moving", parsedTx({ payer: ARTIST })],
    ["only a SOL transfer", parsedTx({ payer: payer.address, program: "system" })],
  ];
  for (const [name, tx] of tries) {
    const s2 = newSig();
    txs.set(s2, tx);
    const r = await report(s2);
    ok(`a payment ${name} isn't counted (422)`, r.status === 422 && (await paidOf(DB, payer.address)) === 2_000_000, JSON.stringify(r));
  }
  const stranger = await makeWallet();
  const s3 = newSig();
  txs.set(s3, parsedTx({ payer: stranger.address }));
  const unknown = await report(s3);
  ok("a payment from a wallet that has never listened here: refused, nothing kept", unknown.status === 403 && !sqlite.prepare("SELECT 1 FROM paid WHERE pubkey = ?").get(stranger.address));
  const missing = await report(newSig());
  ok("a payment not on the network yet: 202, try again later", missing.status === 202 && missing.body.pending === true, JSON.stringify(missing));
  ok("a signature that isn't one: 400", (await report("not-a-signature")).status === 400);

  // Each report asks the network, so they're limited per address.
  const ip = "192.0.2.200";
  const statuses = [];
  for (let i = 0; i < RULES.wallet.limit + 2; i++) statuses.push((await report(newSig(), ip)).status);
  ok(`at most ${RULES.wallet.limit} reports a minute from one address`, statuses.slice(0, RULES.wallet.limit).every((s) => s !== 429)
    && statuses.slice(RULES.wallet.limit).every((s) => s === 429), statuses.join(","));
}

// ── paying at the same moment ───────────────────────────────────────────────
{
  const w = await makeWallet();
  known(w, { owed: 9_000_000 });
  const sigs = [newSig(), newSig(), newSig()];
  await Promise.all(sigs.map((s) => recordPaid(DB, w.address, 1_000_000, s)));
  ok("three payments landing at once all count", (await paidOf(DB, w.address)) === 3_000_000);
  const same = await Promise.all([recordPaid(DB, w.address, 1_000_000, sigs[0]), recordPaid(DB, w.address, 1_000_000, sigs[0])]);
  ok("  the same one twice at once counts once", (await paidOf(DB, w.address)) === 3_000_000 && same.every((x) => x === false));
}

// ── what a listener can see and erase ───────────────────────────────────────
{
  const w = await makeWallet();
  known(w, { owed: 3_000_000 });
  await recordPaid(DB, w.address, 1_000_000, newSig());
  const mine = await (await listen("/mine", await signed(w))).json();
  ok("a listener's own record shows what they've paid", mine.held?.paidMicros === 1_000_000, JSON.stringify(mine.held));
  ok("  an auto-blocked wallet can still see it", (await passFor(w)).status === 403 && mine.wallet === w.address);
  const erased = await listen("/forget", await signed(w));
  const left = await listener(DB, w.address);
  ok("  and erase it: the listening goes", erased.status === 204 && left?.plays === 0 && left?.seconds === 0 && left?.first_seen === 0, JSON.stringify(left));
  ok("  but owing $2, what it owes and what it paid stay, until it's settled",
    sqlite.prepare("SELECT micros FROM owed WHERE pubkey = ?").get(w.address)?.micros === 3_000_000 && (await paidOf(DB, w.address)) === 1_000_000
    && !!sqlite.prepare("SELECT 1 FROM paid_sigs WHERE pubkey = ?").get(w.address));
  ok("  so erasing isn't a way not to pay: still auto-blocked, told what it owes", (await passFor(w)).status === 403);
  await recordPaid(DB, w.address, 2_000_000, newSig());
  const again = await listen("/forget", await signed(w));
  ok("  paid up and erased again: the listening goes, and the payments' references lose the wallet", again.status === 204 && (await listener(DB, w.address)) === null
    && !sqlite.prepare("SELECT 1 FROM paid_sigs WHERE pubkey = ?").get(w.address));
  ok("  but the two money totals stay, so old payments can't be set against new listening",
    (await paidOf(DB, w.address)) === 3_000_000 && sqlite.prepare("SELECT micros, seconds FROM owed WHERE pubkey = ?").get(w.address)?.micros === 3_000_000);
  // The editor merges the chain's all-time total: back, listening $1, it's still owed.
  known(w, { owed: 0 });
  sqlite.prepare("UPDATE owed SET micros = 4_000_000 WHERE pubkey = ?").run(w.address);
  await mergePaid(DB, { [w.address]: 3_000_000 });
  ok("  back after erasing, with the chain's all-time total merged in: new listening is still owed ($1)",
    sqlite.prepare("SELECT micros FROM owed WHERE pubkey = ?").get(w.address).micros - (await paidOf(DB, w.address)) === 1_000_000);

  const kept = await makeWallet();
  known(kept, { owed: 3_000_000, blocked: 1 });
  await recordPaid(DB, kept.address, 3_000_000, newSig());
  await forget(DB, kept.address);
  ok("a blocked wallet, paid up, erased keeps its block and its money totals, nothing else", (await listener(DB, kept.address))?.blocked === 1 && (await listener(DB, kept.address))?.seconds === 0 && (await paidOf(DB, kept.address)) === 3_000_000);

  // One payment, counted by the server and by the editor's read of the chain:
  // counted once, in whichever order.
  {
    const d = await makeWallet();
    known(d, { owed: 5_000_000 });
    const sig = newSig();
    await mergePaid(DB, { [d.address]: 2_000_000 });          // the editor read it on the chain
    await recordPaid(DB, d.address, 2_000_000, sig);           // then the app reported it
    ok("a payment the editor merged, then reported: counted once ($2, not $4)", (await paidOf(DB, d.address)) === 2_000_000, String(await paidOf(DB, d.address)));
    await recordPaid(DB, d.address, 1_000_000, newSig());      // a new one, reported first
    ok("  a new payment reported adds to what the server counted ($3)", (await paidOf(DB, d.address)) === 3_000_000, String(await paidOf(DB, d.address)));
    await mergePaid(DB, { [d.address]: 3_000_000 });          // the chain says the same
    ok("  and the chain saying the same total doesn't add it again ($3)", (await paidOf(DB, d.address)) === 3_000_000);
    const rows = await (await manage("/listeners")).json();
    ok("  the editor's list says the same", rows.find((r) => r.pubkey === d.address)?.paid_micros === 3_000_000, JSON.stringify(rows.find((r) => r.pubkey === d.address)));
  }

  // Erased, keeping only the money totals: "see my data" still shows them.
  {
    const e = await makeWallet();
    known(e, { owed: 1_000_000 });
    await recordPaid(DB, e.address, 1_000_000, newSig());
    await listen("/forget", await signed(e));
    const mine = await (await listen("/mine", await signed(e))).json();
    ok("erased, paid up: 'see my data' shows the totals still kept, not nothing", mine.held?.paidMicros === 1_000_000 && mine.held?.costMicros === 1_000_000, JSON.stringify(mine.held));
  }

  // A signed request, seen in passing, can't be sent again.
  {
    const r = await makeWallet();
    known(r, { owed: 0 });
    const body = await signed(r);
    const first = await listen("/mine", body);
    const again = await listen("/mine", body);
    ok("a signed request to see a record works once, and not again if replayed", first.status === 200 && again.status === 403, `${first.status} ${again.status}`);
  }

  // A payment counted, the wallet erased (paid up), listening again: the same
  // payment reported again isn't counted a second time.
  const replay = await makeWallet();
  known(replay, { owed: 1_000_000 });
  const sig = newSig();
  await recordPaid(DB, replay.address, 1_000_000, sig);
  await forget(DB, replay.address);
  ok("erased, paid up: the payment's reference stays, with no wallet or amount on it",
    sqlite.prepare("SELECT pubkey, micros FROM paid_sigs WHERE sig = ?").get(sig)?.pubkey === "" && (await listener(DB, replay.address)) === null);
  known(replay, { owed: 2_000_000 });
  ok("  listening again, the same payment reported again isn't counted twice",
    !(await recordPaid(DB, replay.address, 1_000_000, sig)) && (await paidOf(DB, replay.address)) === 1_000_000);
  await pruneStale(DB, Date.now() + 9 * DAY);
  ok("  and after a week and a day, the reference goes too", !sqlite.prepare("SELECT 1 FROM paid_sigs WHERE sig = ?").get(sig));

  // Owing from before the server priced listening as heard: still owed.
  const older = await makeWallet();
  known(older, { owed: 0, seconds: 0, lastSeen: Date.now() - 3 * DAY });
  sqlite.prepare("UPDATE listeners SET seconds = 3000 WHERE pubkey = ?").run(older.address);   // 50 minutes, unpriced
  await forget(DB, older.address, 0.06);
  ok("erasing a wallet whose bill is from before prices were kept: it's priced and kept ($3.00)",
    sqlite.prepare("SELECT micros, seconds FROM owed WHERE pubkey = ?").get(older.address)?.micros === 3_000_000
    && (await listener(DB, older.address))?.seconds === 0);
  ok("  and when it was last here stays, so the bill still ages", Math.abs(lastSeenOf(older) - (Date.now() - 3 * DAY)) < 5_000, String(lastSeenOf(older)));

  const gone = await makeWallet();
  known(gone, { owed: 3_000_000 });
  await recordPaid(DB, gone.address, 1_000_000, newSig());
  await remove(DB, gone.address);
  ok("the artist deleting a record deletes what it paid", (await paidOf(DB, gone.address)) === 0);

  const stale = await makeWallet();
  known(stale, { owed: 3_000_000, lastSeen: Date.now() - 400 * DAY });
  await recordPaid(DB, stale.address, 1_000_000, newSig());
  sqlite.prepare("UPDATE paid SET last = ? WHERE pubkey = ?").run(Date.now() - 400 * DAY, stale.address);   // paid then too
  await pruneStale(DB);
  ok("a year unheard: what it paid is deleted with the rest", (await listener(DB, stale.address)) === null && (await paidOf(DB, stale.address)) === 0
    && !sqlite.prepare("SELECT 1 FROM paid_sigs WHERE pubkey = ?").get(stale.address));
}

// ── the privacy notice says what's kept, and that Auto-block is on ──────────
{
  const on = await (await worker.fetch(new Request(`${ORIGIN}/privacy`), env)).text();
  ok("the privacy notice says what you've paid is kept", /what you have paid for listening/.test(on));
  ok("  and, with Auto-block on, that wallets behind are refused until they pay", /Auto-block/.test(on) && !/Nobody is refused automatically/.test(on));
  await setAuto(false);
  const off = await (await worker.fetch(new Request(`${ORIGIN}/privacy`), env)).text();
  ok("  and with it off, that nobody is refused automatically", /Nobody is refused automatically/.test(off) && !/<strong>Auto-block<\/strong>/.test(off));
}

// ── a database from before these tables ─────────────────────────────────────
{
  const old = new DatabaseSync(":memory:");
  for (const s of SCHEMA.filter((s) => !/paid/.test(s))) old.exec(s);
  const oldDB = d1(old);
  for (const row of sqlite.prepare("SELECT key, value FROM settings").all()) old.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(row.key, row.value);
  await putSetting(oldDB, "auto-block", JSON.stringify({ enabled: true, since: Date.now() }));
  const oldEnv = { DB: oldDB, MEDIA_KV };
  const w = await makeWallet();
  // Ten hours, $6 at today's price, and no record of anything paid.
  old.prepare("INSERT INTO listeners (pubkey, plays, seconds, first_seen, last_seen) VALUES (?, 1, 36000, ?, ?)").run(w.address, Date.now(), Date.now());
  const pass = await worker.fetch(new Request(`${ORIGIN}/listen/token`, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": nextIp() }, body: await signed(w) }), oldEnv);
  ok("no paid table yet (a rebuild that stopped halfway): nobody can say who paid, so passes are still given", pass.status === 200, String(pass.status));
  const listed = await worker.fetch(new Request(`${ORIGIN}/manage/listeners`, { headers: { Cookie: `amply_preview=${KEY}` } }), oldEnv);
  const oldRows = listed.status === 200 ? await listed.json() : [];
  ok("  and the editor's list of listeners still loads, nobody shown as auto-blocked", oldRows.length === 1 && oldRows[0].auto_blocked === false, JSON.stringify(oldRows));
  ok("  and recording a payment does nothing rather than fail", (await recordPaid(oldDB, w.address, 1_000_000, newSig())) === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
