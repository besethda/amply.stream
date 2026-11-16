/**
 * The app paying through an artist's node, against the node's own code.
 *
 * The app's real payArtist builds and signs the payment; the node's real
 * settle checks, signs and "sends" it. Only the network is a stand-in. So the
 * two halves are proved to agree on exactly what a payment looks like, and
 * the app is proved to fall back, or stop, at the right moments: never paying
 * twice, never trusting a signature that isn't over its own payment.
 *
 * Bundled, because it reaches into the node's TypeScript (see package.json).
 */
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import { DatabaseSync } from "node:sqlite";
import { payArtist } from "./src/pay.js";
import { networkName, network } from "./src/networks.js";
import { SCHEMA } from "../node/src/store.ts";
import { settle, feeAddress } from "../node/src/settle.ts";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

// ── the artist's node, with its real settle ─────────────────────────────────
const sqlite = new DatabaseSync(":memory:");
for (const s of SCHEMA) sqlite.exec(s);
const DB = {
  prepare(sql) {
    const stmt = sqlite.prepare(sql);
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
const feePayer = await feeAddress(DB);
const ORIGIN = "https://artist.example.workers.dev";
const artist = Keypair.generate().publicKey.toBase58(), friend = Keypair.generate().publicKey.toBase58();
const payees = [{ address: artist, split: 70 }, { address: friend, split: 30 }];

let node;   // how the node behaves, per test
const sentByNode = [];
const nodeRpc = async (method, params) => {
  if (method === "simulateTransaction") return { value: { err: null, logs: [] } };
  if (method === "sendTransaction") { sentByNode.push(params[0]); return "ok"; }
  if (method === "getSignatureStatuses") return { value: [{ confirmationStatus: "confirmed", err: null }] };
  throw new Error(method);
};
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.origin !== ORIGIN) throw new Error(`unexpected fetch ${url}`);
  if (u.pathname === "/listen/fees") return json(node.offer);
  if (u.pathname === "/listen/settle") {
    node.asked = (node.asked || 0) + 1;
    if (node.unreachable) throw new TypeError("Failed to fetch");
    const body = JSON.parse(init.body);
    node.body = body;
    if (node.answer) return node.answer(body);
    const item = body.item;
    const r = await settle(DB, nodeRpc, body.tx, {
      mint: network().usdc, payees,
      ...(item === undefined ? { minMicros: 10_000, maxMicros: 2_000_000 }
        : { minMicros: 8_000_000, maxMicros: 8_000_000, memo: `amply:buy:${u.host}:${item}` }),
    }, { wait: async () => {}, confirmWithinMs: 20 });
    return r.ok ? json({ signature: r.signature, confirmed: r.confirmed }) : json({ error: r.why }, r.status);
  }
  throw new Error(`unexpected path ${u.pathname}`);
};

// ── the listener's network ──────────────────────────────────────────────────
const selfSent = [];
Connection.prototype.getLatestBlockhash = async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 });
Connection.prototype.getSignatureStatuses = async () => ({ value: [{ confirmationStatus: "confirmed", err: null }] });
Connection.prototype.sendTransaction = async (tx) => { selfSent.push(tx); return "self-paid-signature"; };

const offering = () => ({ offer: { feePayer, network: networkName(), minMicros: 10_000, maxMicros: 2_000_000 } });
const listener = Keypair.generate();
const reset = (n) => { node = n; selfSent.length = 0; sentByNode.length = 0; };

{
  reset(offering());
  const r = await payArtist(listener, payees, 100_000, { node: { origin: ORIGIN } });
  ok("a listening payment goes through the artist's node", r.feePaidBy === "artist", JSON.stringify(r));
  ok("  the node accepted exactly what the app built", sentByNode.length === 1);
  ok("  the listener's wallet sent nothing itself", selfSent.length === 0);
  const t = Transaction.from(Buffer.from(sentByNode[0], "base64"));
  ok("  the fee payer is the artist's fee wallet", t.feePayer.toBase58() === feePayer);
  ok("  and the signature the app got back is that transaction's", r.signature === (await import("bs58")).default.encode(t.signature));
  ok("  split 70 / 30", r.shares[0].micros === 70_000 && r.shares[1].micros === 30_000);
  ok("  nothing about the listener but the payment was sent", Object.keys(node.body).join() === "tx");
}

{
  reset(offering());
  const r = await payArtist(listener, payees, 8_000_000, { memo: `amply:buy:${new URL(ORIGIN).host}:tides`, node: { origin: ORIGIN, item: "tides" } });
  ok("a purchase, with its note, goes through the node too", r.feePaidBy === "artist" && sentByNode.length === 1 && node.body.item === "tides");
}

{
  reset({ offer: { feePayer: null } });
  const r = await payArtist(listener, payees, 100_000, { node: { origin: ORIGIN } });
  ok("a node that isn't paying fees: the listener pays the fee, as before", r.feePaidBy === "listener" && selfSent.length === 1 && !node.asked);
}

{
  reset({ offer: { feePayer, network: networkName() === "solana" ? "devnet" : "solana", minMicros: 10_000, maxMicros: 2_000_000 } });
  const r = await payArtist(listener, payees, 100_000, { node: { origin: ORIGIN } });
  ok("an offer on another network is ignored", r.feePaidBy === "listener" && !node.asked);
}

{
  reset({ offer: { feePayer: artist, network: networkName(), minMicros: 10_000, maxMicros: 2_000_000 } });
  const r = await payArtist(listener, payees, 100_000, { node: { origin: ORIGIN } });
  ok("an offer naming a payee as fee payer is ignored", r.feePaidBy === "listener" && !node.asked);
}

{
  reset(offering());
  const r = await payArtist(listener, payees, 3_000_000, { node: { origin: ORIGIN } });
  ok("a payment above what the node offers for is paid the old way", r.feePaidBy === "listener" && !node.asked);
}

{
  reset({ ...offering(), answer: () => json({ error: "this artist's node has paid all the fees it will today" }, 503) });
  const r = await payArtist(listener, payees, 100_000, { node: { origin: ORIGIN } });
  ok("a node that refuses before sending: the listener pays the fee instead", r.feePaidBy === "listener" && selfSent.length === 1 && node.asked === 1);
}

{
  reset({ ...offering(), answer: () => json({ signature: (Keypair.generate().publicKey.toBase58() + Keypair.generate().publicKey.toBase58()).slice(0, 87) }) });
  let threw = null;
  try { await payArtist(listener, payees, 100_000, { node: { origin: ORIGIN } }); } catch (e) { threw = e; }
  ok("a signature that isn't over this payment is not believed", !!threw);
  ok("  and nothing is sent again", selfSent.length === 0);
}

{
  reset({ ...offering(), unreachable: true });
  let threw = null;
  try { await payArtist(listener, payees, 100_000, { node: { origin: ORIGIN } }); } catch (e) { threw = e; }
  ok("no answer from the node: stop, since it may have been sent", threw?.kind === "unconfirmed", threw?.message);
  ok("  and the listener's wallet doesn't pay it a second time", selfSent.length === 0);
}

{
  reset({ ...offering(), answer: () => json({ error: "there isn't enough in your wallet to pay this; nothing was sent" }, 422) });
  let threw = null;
  try { await payArtist(listener, payees, 100_000, { node: { origin: ORIGIN } }); } catch (e) { threw = e; }
  ok("not enough money is said plainly, without trying again", threw?.kind === "funds" && selfSent.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
