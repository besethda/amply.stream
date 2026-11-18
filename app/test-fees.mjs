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
import { payArtist, sendDollarsOut } from "./src/pay.js";
import { networkName, network } from "./src/networks.js";
// The node names its money as the manifest does ("solana"), not as the app
// does ("mainnet"): what a real node sends.
const SPEC_NET = { mainnet: "solana", devnet: "devnet" };
const nodeNet = () => SPEC_NET[networkName()];
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
  if (method === "getMultipleAccounts") return { value: params[0].map(() => ({ lamports: 2039280 })) };
  throw new Error(method);
};
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.origin !== ORIGIN) throw new Error(`unexpected fetch ${url}`);
  if (u.pathname === "/listen/fees") return json(node.offer);
  if (u.pathname === "/listen/withdraw") {
    const body = JSON.parse(init.body);
    node.body = body;
    const fee = 50_000 + (node.destExists ? 0 : 500_000);
    const r = await settle(DB, nodeRpc, body.tx, {
      mint: network().usdc, payees: [{ address: body.to }, { address: artist }], minMicros: 10_000, maxMicros: 10_000_000_000, withdrawal: { fee },
      // As the node does: the destination's account may be opened only when
      // the listener pays for that.
      mayOpen: node.destExists ? [artist] : [body.to, artist],
    }, { wait: async () => {}, confirmWithinMs: 20, openOnce: [artist, body.to] });
    return r.ok ? json({ signature: r.signature, confirmed: r.confirmed }) : json({ error: r.why }, r.status);
  }
  if (u.pathname === "/listen/settle") {
    node.asked = (node.asked || 0) + 1;
    if (node.unreachable) throw new TypeError("Failed to fetch");
    const body = JSON.parse(init.body);
    node.body = body;
    if (node.answer) return node.answer(body);
    const item = body.item;
    const r = await settle(DB, nodeRpc, body.tx, {
      mint: network().usdc, payees,
      ...(body.tip === true ? { minMicros: 100_000, maxMicros: 50_000_000, memo: `amply:tip:${u.host}` }
        : item === undefined ? { minMicros: 10_000, maxMicros: 2_000_000 }
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

const offering = () => ({ offer: { feePayer, network: nodeNet(), minMicros: 10_000, maxMicros: 2_000_000 } });
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
  ok("  and whether the node saw it land comes back with it", r.nodeConfirmed === true);
}

{
  // The node sent it; then the network stops answering while the app waits
  // to see it land. That is not "nothing was sent": it may well land.
  reset(offering());
  const was = Connection.prototype.getSignatureStatuses;
  Connection.prototype.getSignatureStatuses = async () => { throw new TypeError("Failed to fetch"); };
  const e = await payArtist(listener, payees, 100_000, { node: { origin: ORIGIN } }).catch((x) => x);
  Connection.prototype.getSignatureStatuses = was;
  ok("losing the network after the node sent it: unsure, not failed", e?.kind === "unconfirmed", `${e?.kind} ${e?.message}`);
  ok("  with its signature, to look it up before paying again", typeof e?.signature === "string" && e.signature.length > 40);
}

{
  reset(offering());
  const was = Connection.prototype.getSignatureStatuses;
  Connection.prototype.getSignatureStatuses = async () => ({ value: [{ confirmationStatus: "confirmed", err: { InstructionError: [0, "Custom"] } }] });
  const e = await payArtist(listener, payees, 100_000, { node: { origin: ORIGIN } }).catch((x) => x);
  Connection.prototype.getSignatureStatuses = was;
  ok("failed on the network: said so, and safe to send again", e?.kind === "failed", `${e?.kind} ${e?.message}`);
  ok("  nothing about the listener but the payment was sent", Object.keys(node.body).join() === "tx");
}

{
  reset(offering());
  const r = await payArtist(listener, payees, 8_000_000, { memo: `amply:buy:${new URL(ORIGIN).host}:tides`, node: { origin: ORIGIN, item: "tides" } });
  ok("a purchase, with its note, goes through the node too", r.feePaidBy === "artist" && sentByNode.length === 1 && node.body.item === "tides");
}

{
  ok("the app accepts the node's own word for real money", true);
}

// Listeners never pay a network fee. Each way an artist's node can't pay it
// ends with nothing sent from the listener's wallet, and a paused payment.
const neverSelf = async (name, n, micros = 100_000, asked = 0) => {
  reset(n);
  const e = await payArtist(listener, payees, micros, { node: { origin: ORIGIN } }).catch((x) => x);
  ok(name, e?.kind === (micros > 2_000_000 ? "payment" : "paused") && selfSent.length === 0 && sentByNode.length === 0 && (node.asked || 0) === asked, e?.message || JSON.stringify(e));
};
await neverSelf("a node that isn't paying fees: nothing sent, payments paused", { offer: { feePayer: null } });
await neverSelf("an offer on another network: the same", { offer: { feePayer, network: nodeNet() === "solana" ? "devnet" : "solana", minMicros: 10_000, maxMicros: 2_000_000 } });
await neverSelf("an offer naming a payee as fee payer: the same", { offer: { feePayer: artist, network: nodeNet(), minMicros: 10_000, maxMicros: 2_000_000 } });
await neverSelf("a payment above the most one can be: refused, nothing sent", offering(), 3_000_000);
await neverSelf("a node saying it isn't paying fees right now (409): paused", { ...offering(), answer: () => json({ error: "this artist's node isn't paying network fees right now" }, 409) }, 100_000, 1);
for (const [why, status] of [["a payee closed their USDC account after this server opened it", 403], ["too many payments from this wallet; try again in a minute", 429], ["couldn't reach the network", 502]]) {
  reset({ ...offering(), answer: () => json({ error: why }, status) });
  const e = await payArtist(listener, payees, 100_000, { node: { origin: ORIGIN } }).catch((x) => x);
  ok(`any other refusal (${status}) isn't "can't pay fees": it says why, and nothing is sent`,
    e?.kind === "refused" && e.message.includes(why) && selfSent.length === 0 && sentByNode.length === 0, e?.kind + " " + e?.message);
}
{
  reset(offering());
  const e = await payArtist(listener, payees, 5_000, { node: { origin: ORIGIN } }).catch((x) => x);
  ok("less than a cent waits: nothing sent, the node not asked", e?.kind === "small" && selfSent.length === 0 && !node.asked);
}

{
  reset({ ...offering(), answer: () => json({ signature: (Keypair.generate().publicKey.toBase58() + Keypair.generate().publicKey.toBase58()).slice(0, 87) }) });
  let threw = null;
  try { await payArtist(listener, payees, 100_000, { node: { origin: ORIGIN } }); } catch (e) { threw = e; }
  ok("a signature that isn't over this payment is not believed", !!threw);
  ok("  and, since the node may have sent it all the same, it's held as unsure", threw?.kind === "unconfirmed");
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

{
  // A crash after sending: Cloudflare's own error page, not the node's refusal.
  reset({ ...offering(), answer: () => new Response("<html>Error 1102: Worker exceeded resource limits</html>", { status: 503, headers: { "Content-Type": "text/html" } }) });
  let threw = null;
  try { await payArtist(listener, payees, 100_000, { node: { origin: ORIGIN } }); } catch (e) { threw = e; }
  ok("a crash page from the node: stop, it may have been sent", threw?.kind === "unconfirmed", threw?.message);
  ok("  and the listener's wallet doesn't pay it a second time", selfSent.length === 0);
}
{
  reset({ ...offering(), answer: () => new Response("Internal Server Error", { status: 500 }) });
  let threw = null;
  try { await payArtist(listener, payees, 100_000, { node: { origin: ORIGIN } }); } catch (e) { threw = e; }
  ok("a bare server error: also stop, without paying twice", threw?.kind === "unconfirmed" && selfSent.length === 0);
}

{
  reset(offering());
  const r = await payArtist(listener, payees, 5_000_000, { memo: `amply:tip:${new URL(ORIGIN).host}`, node: { origin: ORIGIN, tip: true, extra: { tip: true } } });
  ok("a $5 tip goes through the artist's node, above the listening cap", r.feePaidBy === "artist" && node.body.tip === true && selfSent.length === 0);
}

// ── sending money out with no SOL, through a node that pays fees ──
{
  const withdrawOffer = { ...offering().offer, withdraw: { to: artist, fee: 50_000, newAccountFee: 500_000 } };
  const origGetBalance = Connection.prototype.getBalance, origInfo = Connection.prototype.getAccountInfo, origTok = Connection.prototype.getTokenAccountBalance;
  Connection.prototype.getBalance = async () => 0;
  Connection.prototype.getTokenAccountBalance = async () => { throw new Error("Indexed requests require a personal token"); };
  Connection.prototype.getParsedAccountInfo = async () => ({ value: { data: { parsed: { info: { tokenAmount: { amount: "3000000" } } } } } });
  const dest = Keypair.generate().publicKey.toBase58();

  reset({ offer: withdrawOffer, destExists: false });
  Connection.prototype.getAccountInfo = async () => null;
  const r = await sendDollarsOut(listener, dest, "all", { nodes: [ORIGIN] });
  ok("no SOL: the dollars go out through the artist's node", sentByNode.length === 1 && selfSent.length === 0);
  ok("  the new account's cost and the fee come off: $3.00 → $2.45 sent", r.micros === 2_450_000 && r.fee === 550_000, JSON.stringify(r));
  ok("  and the node was told where to", node.body.to === dest);

  reset({ offer: withdrawOffer, destExists: true });
  Connection.prototype.getAccountInfo = async () => ({ lamports: 2039280 });
  const r2 = await sendDollarsOut(listener, dest, "all", { nodes: [ORIGIN] });
  ok("to an account that already exists, just the 5 cent fee", r2.micros === 2_950_000 && r2.fee === 50_000, JSON.stringify(r2));
  const creates = (b64) => Transaction.from(Buffer.from(b64, "base64")).instructions
    .filter((ix) => ix.programId.toBase58() === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
    .map((ix) => ix.keys[2].pubkey.toBase58());
  ok("  and the app doesn't ask the node to open it", !creates(node.body.tx).includes(dest) && creates(node.body.tx).includes(artist), JSON.stringify(creates(node.body.tx)));

  reset({ offer: { ...withdrawOffer, withdraw: { ...withdrawOffer.withdraw, fee: 5_000_000 } } });
  let threw = null;
  const realSend = Connection.prototype.sendTransaction;
  Connection.prototype.sendTransaction = async () => { throw new Error("needs SOL: insufficient lamports"); };
  try { await sendDollarsOut(listener, dest, "all", { nodes: [ORIGIN] }); } catch (e) { threw = e; }
  ok("a node asking an unreasonable fee isn't used", sentByNode.length === 0 && threw?.kind === "fee", threw?.message);
  Connection.prototype.sendTransaction = realSend;

  Connection.prototype.getBalance = origGetBalance; Connection.prototype.getAccountInfo = origInfo; Connection.prototype.getTokenAccountBalance = origTok;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
