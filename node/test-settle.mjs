/**
 * The node's fee wallet: made once, kept, never handed out; and a payment
 * checked, signed, simulated, sent and confirmed, in that order, with nothing
 * sent that the checks or the simulation refused.
 *
 * The network is a stand-in that records what it was asked; the database is
 * SQLite with the node's real schema.
 *
 *   npm run test:feepay
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA } from "./src/store.ts";
import { feeKey, feeAddress, forgetFeeKey, settle, countFee, feeBalance, DAILY_PAYMENTS } from "./src/settle.ts";
import { readTransaction, verifySignature, base58 } from "./src/solana-tx.ts";

const require = createRequire(resolve("app/package.json"));
const web3 = require("@solana/web3.js");
const spl = require("@solana/spl-token");
const { Keypair, Transaction, PublicKey } = web3;

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

function d1(db) {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        async run() { stmt.run(...args); },
        async first() { return stmt.get(...args) ?? null; },
        async all() { return { results: stmt.all(...args) }; },
      };
      return api;
    },
  };
}
const fresh = (schema = SCHEMA) => {
  const sqlite = new DatabaseSync(":memory:");
  for (const s of schema) sqlite.exec(s);
  return { sqlite, DB: d1(sqlite) };
};

// ── the key ─────────────────────────────────────────────────────────────────
const { sqlite, DB } = fresh();
{
  forgetFeeKey();
  const [a, b] = await Promise.all([feeKey(DB), feeKey(DB)]);
  ok("the fee wallet is made once, even when asked twice at once", a.address === b.address);
  ok("  and it's a Solana address", (() => { try { return new PublicKey(a.address).toBase58() === a.address; } catch { return false; } })());
  forgetFeeKey();
  ok("  kept: the same wallet after the Worker restarts", (await feeAddress(DB)) === a.address);
  const rows = sqlite.prepare("SELECT key FROM settings").all().map((r) => r.key);
  ok("  stored in the artist's own settings, in one row", rows.filter((k) => k === "fee-wallet").length === 1);
  const sig = await a.sign(new TextEncoder().encode("hello"));
  ok("  and what it signs checks out against its address", await verifySignature(a.address, sig, new TextEncoder().encode("hello")));
  const loaded = await feeKey(DB);
  ok("  the loaded key offers signing and its address, nothing else", Object.keys(loaded).sort().join() === "address,sign");
}

// ── a payment ───────────────────────────────────────────────────────────────
const feePayer = new PublicKey(await feeAddress(DB));
const listener = Keypair.generate(), artist = Keypair.generate();
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const expect = { mint: USDC.toBase58(), payees: [{ address: artist.publicKey.toBase58(), split: 100 }], minMicros: 10_000, maxMicros: 2_000_000 };

function payment(micros = 100_000, { to = artist.publicKey } = {}) {
  const t = new Transaction({ feePayer, recentBlockhash: Keypair.generate().publicKey.toBase58() });
  const ata = (o) => spl.getAssociatedTokenAddressSync(USDC, o, true);
  t.add(spl.createAssociatedTokenAccountIdempotentInstruction(feePayer, ata(to), to, USDC));
  t.add(spl.createTransferCheckedInstruction(ata(listener.publicKey), USDC, ata(to), listener.publicKey, micros, 6));
  t.partialSign(listener);
  return Buffer.from(t.serialize({ requireAllSignatures: false })).toString("base64");
}

/** A network that answers as told and remembers what it was asked. */
function network({ simulate = { value: { err: null, logs: [] } }, status = { confirmationStatus: "confirmed", err: null }, down = [] } = {}) {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (down.includes(method)) { const { RpcError } = await import("./src/settle.ts"); throw new RpcError("couldn't reach the network"); }
    if (method === "simulateTransaction") return simulate;
    if (method === "sendTransaction") return "sent";
    if (method === "getSignatureStatuses") return { value: [status] };
    if (method === "getBalance") return { value: 50_000_000 };
    throw new Error(`unexpected ${method}`);
  };
  return { rpc, calls, methods: () => calls.map((c) => c.method) };
}
const quick = { wait: async () => {}, confirmWithinMs: 50 };
const today = (db = sqlite) => db.prepare("SELECT count FROM fee_days").get()?.count ?? 0;

{
  const net = network();
  const tx = payment();
  const r = await settle(DB, net.rpc, tx, expect, quick);
  ok("an honest payment is settled", r.ok && r.confirmed, r.why);
  ok("  simulated, then sent, then confirmed, in that order",
    net.methods().join() === "simulateTransaction,sendTransaction,getSignatureStatuses", net.methods().join());
  const sent = readTransaction(Buffer.from(net.calls[1].params[0], "base64"));
  ok("  what was sent carries the fee wallet's valid signature", await verifySignature(feePayer.toBase58(), sent.signatures[0], sent.message));
  ok("  and the listener's, untouched", await verifySignature(listener.publicKey.toBase58(), sent.signatures[1], sent.message));
  ok("  the message is exactly what the listener signed", Buffer.from(sent.message).equals(Buffer.from(readTransaction(Buffer.from(tx, "base64")).message)));
  ok("  the simulation checked signatures", net.calls[0].params[1].sigVerify === true);
  ok("  the answer is the signature, not the signed transaction", r.signature === base58(sent.signatures[0]) && !JSON.stringify(r).includes(net.calls[1].params[0].slice(0, 40)));
  ok("  and the day's count went up by one", today() === 1);
}

{
  const net = network();
  const before = today();
  const r = await settle(DB, net.rpc, payment(100_000, { to: Keypair.generate().publicKey }), expect, quick);
  ok("a payment to someone else is refused", !r.ok && r.status === 403);
  ok("  before anything is signed or sent", net.calls.length === 0);
  ok("  and it doesn't count against the day", today() === before);
}

{
  const net = network({ simulate: { value: { err: { InstructionError: [1, { Custom: 1 }] }, logs: ["Program log: Error: insufficient funds", "Transfer"] } } });
  const r = await settle(DB, net.rpc, payment(), expect, quick);
  ok("a payment that would fail is not sent", !r.ok && r.status === 422 && !net.methods().includes("sendTransaction"), JSON.stringify(r));
  ok("  and the listener is told why, plainly", /isn't enough in your wallet/.test(r.why || ""));
}

{
  const net = network();
  const r = await settle(DB, net.rpc, payment(), expect, { ...quick, allowed: async () => false });
  ok("too many from one wallet is refused, before signing", !r.ok && r.status === 429 && net.calls.length === 0);
}

{
  const { sqlite: s2, DB: db2 } = fresh();
  forgetFeeKey();
  // The same fee wallet in this database, so the payment is otherwise fine.
  s2.prepare("INSERT INTO settings (key, value) VALUES ('fee-wallet', ?)").run(sqlite.prepare("SELECT value FROM settings WHERE key = 'fee-wallet'").get().value);
  s2.prepare("INSERT INTO fee_days (day, count) VALUES (?, ?)").run(new Date().toISOString().slice(0, 10), DAILY_PAYMENTS);
  const net = network();
  const r = await settle(db2, net.rpc, payment(), expect, quick);
  ok("once the day's fees are used up, no more are paid", !r.ok && r.status === 503 && net.calls.length === 0);
  forgetFeeKey();
}

{
  const { sqlite: s3, DB: db3 } = fresh(SCHEMA.filter((s) => !s.includes("fee_days")));
  ok("without the day's count (a database from before), nothing is paid", !(await countFee(db3)));
  s3.close();
}

{
  const net = network({ down: ["simulateTransaction"] });
  const r = await settle(DB, net.rpc, payment(), expect, quick);
  ok("a network that can't be reached is reported, with nothing sent", !r.ok && r.status === 502 && !net.methods().includes("sendTransaction"));
}

{
  const net = network({ down: ["sendTransaction"] });
  const r = await settle(DB, net.rpc, payment(), expect, quick);
  ok("a send whose answer is lost returns the signature, unconfirmed, never \"try again\"", r.ok && r.confirmed === false && !!r.signature);
}

{
  const net = network({ status: null });
  const r = await settle(DB, net.rpc, payment(), expect, quick);
  ok("sent but not yet confirmed still answers, saying so", r.ok && r.confirmed === false);
}

{
  const net = network({ status: { err: { InstructionError: [1, "x"] } } });
  const r = await settle(DB, net.rpc, payment(), expect, quick);
  ok("a payment that failed on the network says so", !r.ok && r.status === 422);
}

for (const [name, junk] of [["nothing", undefined], ["not base64", "%%%"], ["too long", "A".repeat(5000)], ["random bytes", Buffer.from("hello there").toString("base64")]]) {
  const net = network();
  const r = await settle(DB, net.rpc, junk, expect, quick);
  ok(`junk (${name}) is refused without asking the network`, !r.ok && r.status === 400 && net.calls.length === 0);
}

{
  let asked = 0;
  const rpc = async () => { asked++; return { value: 7 }; };
  const a = Keypair.generate().publicKey.toBase58();
  await feeBalance(rpc, a); await feeBalance(rpc, a);
  ok("the balance isn't asked for on every payment", asked === 1);
  await feeBalance(rpc, a, { fresh: true });
  ok("  but is when the artist looks", asked === 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
