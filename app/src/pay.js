/**
 * Paying an artist.
 *
 * The whole transfer happens between the listener's wallet and the artists',
 * in one transaction, with nothing in between. Amply is not a recipient, not a
 * router and not a party: there is no account for the money to rest in, which
 * is the same reason it cannot take a cut.
 *
 * USDC has six decimals, so everything here counts in **micros**: whole
 * millionths of a dollar. Money is never held as a float for longer than it
 * takes to convert it, because a float cannot be divided three ways without
 * losing something, and what it loses is somebody's.
 */
import "./buffer-shim.js";
import { PublicKey, Transaction, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  createTransferCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";
import { rpc, network, networkName } from "./wallet.js";
import { networkFor } from "./networks.js";
import { MEMO_PROGRAM } from "../../spec/chains.mjs";
import { toMicros, toUsd } from "./money.js";
import { recordReceipt } from "./receipts.js";
import { SETTLE_WITHIN_DAYS as SETTLE_AFTER_DAYS, shareOut, LISTEN_MIN_MICROS, LISTEN_MAX_MICROS } from "../../spec/pricing.mjs";

export { MICROS, toMicros, toUsd } from "./money.js";
export { SETTLE_AFTER_DAYS };

/** Dividing a payment between the people named in the manifest: shared with
 *  the artist's node, which checks a split it pays the fee for divides the
 *  same way (spec/pricing.mjs). */
export { shareOut };

/**
 * Whether there is a payment to make, and for how much.
 *
 * The artist sets a threshold so a listener is not asked to approve something
 * every three minutes. Below it the debt waits — for at most seven days from the
 * oldest unpaid listen, so someone who stops early still pays for what they
 * heard. `ending` is for a deliberate end, like removing the artist, when the
 * rest is sent at once.
 */
export function dueNow(owedSeconds, rate, { since = null, ending = false, now = Date.now() } = {}) {
  if (!rate || !(rate.perMinute > 0) || !(owedSeconds > 0)) return null;

  const micros = toMicros((owedSeconds / 60) * rate.perMinute);
  if (micros <= 0) return null;

  const threshold = toMicros(rate.settleAt ?? 1);
  const old = since != null && now - since >= SETTLE_AFTER_DAYS * 86400e3;

  if (micros < threshold && !ending && !old) return null;
  return { micros, usd: toUsd(micros), why: micros >= threshold ? "threshold" : old ? "age" : "session" };
}

// ── sending money back out ──────────────────────────────────────────────────

/**
 * Wait for a transaction to be confirmed, by asking.
 *
 * web3.js's confirmTransaction listens on a websocket. If the server doesn't
 * offer one, or drops it, a payment that went through is reported as failed —
 * and a payment reported as failed leaves the debt in place, to be paid
 * again. Asking for the status every second works against any server, and
 * a transaction that genuinely failed says so in the status.
 */
async function confirmed(conn, signature, { tries = 60 } = {}) {
  for (let i = 0; i < tries; i++) {
    const { value } = await conn.getSignatureStatuses([signature]);
    const s = value?.[0];
    // Failed on the network: it took nothing, so it's safe to send again.
    if (s?.err) throw new PaymentError("failed", `The payment failed on the network, so nothing was taken. ${JSON.stringify(s.err)}`);
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new PaymentError("unconfirmed",
    "The network hasn't confirmed this yet. It may still go through — check Phantom before trying again.");
}

/** What one plain transfer costs the network, in lamports. */
const BASE_FEE = 5000;

function destinationOf(value, pair) {
  let to;
  try { to = new PublicKey(String(value || "").trim()); } catch {
    throw new PaymentError("address", "That isn't a Solana address. Copy it from Phantom's Receive screen, choosing Solana.");
  }
  if (to.equals(pair.publicKey)) throw new PaymentError("address", "That's this wallet's own address.");
  return to;
}

/**
 * Send dollars out of this wallet — all of them, or an amount in micros.
 *
 * The listener's money is theirs, and getting it back should be a button
 * rather than a lesson in importing private keys. Opens the destination's
 * USDC account if it has none, which costs this wallet a little SOL.
 */
export async function sendDollarsOut(pair, destination, micros = "all", { nodes = [] } = {}) {
  const conn = rpc();
  const to = destinationOf(destination, pair);
  const mint = new PublicKey(network().usdc);
  const from = await getAssociatedTokenAddress(mint, pair.publicKey, false, TOKEN_PROGRAM_ID);

  let amount = micros;
  if (amount === "all") {
    // Read directly: free endpoints refuse getTokenAccountBalance from a browser.
    const held = await conn.getParsedAccountInfo(from, "confirmed").catch(() => null);
    amount = Number(held?.value?.data?.parsed?.info?.tokenAmount?.amount || 0);
  }
  if (!(amount > 0)) throw new PaymentError("nothing", "There are no dollars in this wallet to send.");

  const toAccount = await getAssociatedTokenAddress(mint, to, false, TOKEN_PROGRAM_ID);

  // No SOL for the network fee? An artist's node that pays fees can pay it,
  // and is paid back a few cents in the same transfer (node/src/index.ts,
  // /listen/withdraw). With SOL of its own, the wallet just pays.
  const sol = await conn.getBalance(pair.publicKey).catch(() => 0);
  if (sol < 3 * BASE_FEE + 2_100_000 && nodes.length) {
    const exists = !!(await conn.getAccountInfo(toAccount).catch(() => null));
    for (const origin of nodes) {
      const w = await withdrawOffer(origin);
      if (!w) continue;
      const fee = w.fee + (exists ? 0 : w.newAccountFee);
      if (amount <= fee + 10_000) {
        throw new PaymentError("nothing", `That's too little to send: sending costs $${toUsd(fee).toFixed(2)} here.`);
      }
      const artistKey = addressOf(w.to, "This artist");
      const artistAccount = await getAssociatedTokenAddress(mint, artistKey, false, TOKEN_PROGRAM_ID);
      const tx = new Transaction();
      // The destination's account is opened only when it's missing, and paid
      // for in the fee: the node refuses to open one that already exists.
      if (!exists) tx.add(createAssociatedTokenAccountIdempotentInstruction(w.feePayer, toAccount, to, mint, TOKEN_PROGRAM_ID));
      tx.add(createTransferCheckedInstruction(from, mint, toAccount, pair.publicKey, amount - fee, 6, [], TOKEN_PROGRAM_ID));
      tx.add(createAssociatedTokenAccountIdempotentInstruction(w.feePayer, artistAccount, artistKey, mint, TOKEN_PROGRAM_ID));
      tx.add(createTransferCheckedInstruction(from, mint, artistAccount, pair.publicKey, fee, 6, [], TOKEN_PROGRAM_ID));
      tx.feePayer = w.feePayer;
      const sent = (await sendThroughNode(conn, { origin, route: "/listen/withdraw", extra: { to: to.toBase58() } }, tx, pair))?.signature;
      if (sent) {
        await confirmed(conn, sent);
        return { signature: sent, micros: amount - fee, fee };
      }
    }
  }
  const tx = new Transaction();
  tx.add(createAssociatedTokenAccountIdempotentInstruction(pair.publicKey, toAccount, to, mint, TOKEN_PROGRAM_ID));
  tx.add(createTransferCheckedInstruction(from, mint, toAccount, pair.publicKey, amount, 6, [], TOKEN_PROGRAM_ID));
  return send(conn, tx, pair, { micros: amount });
}

/**
 * Send whatever SOL is left, less the fee for sending it.
 *
 * Last, deliberately: SOL is what pays the network for everything else, so a
 * wallet emptied of it can no longer send its dollars — or pay an artist.
 */
export async function sendSolOut(pair, destination) {
  const conn = rpc();
  const to = destinationOf(destination, pair);
  const lamports = (await conn.getBalance(pair.publicKey)) - BASE_FEE;
  if (!(lamports > 0)) throw new PaymentError("nothing", "There's no SOL left to send.");
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: pair.publicKey, toPubkey: to, lamports }));
  return send(conn, tx, pair, { lamports });
}

async function send(conn, tx, pair, detail) {
  try {
    const signature = await conn.sendTransaction(tx, [pair], { preflightCommitment: "confirmed" });
    await confirmed(conn, signature);
    return { signature, ...detail };
  } catch (e) {
    const said = String(e?.message || e);
    if (/insufficient lamports|insufficient funds for rent|0x1\b/i.test(said)) {
      throw new PaymentError("fee", "There isn't enough SOL in this wallet for the network fee. Nothing was sent.");
    }
    if (/blockhash|timed out|failed to fetch|network/i.test(said)) {
      throw new PaymentError("network", "Couldn't reach the network, so nothing was sent.");
    }
    throw new PaymentError("unknown", `That didn't go through, so nothing was sent. ${said}`);
  }
}

// ── sending it ──────────────────────────────────────────────────────────────

export class PaymentError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

function addressOf(value, whose) {
  try {
    return new PublicKey(value);
  } catch {
    throw new PaymentError("address", `${whose} has published a payment address that isn't valid, so nothing was sent.`);
  }
}

/** Solana's memo program: a note on a transaction, which a purchase uses to
 *  say what it paid for, so it can't be mistaken for any other payment. */
export { MEMO_PROGRAM };

/**
 * Send one payment, splits and all, as a single transaction.
 *
 * One transaction because a split must not be able to half-happen: either
 * everyone named is paid or nobody is, and the listener's tally stays owed.
 *
 * An artist who has never held USDC has no account for it, and someone has to
 * open it. That falls to the payer, costs a fraction of a cent in rent, and is
 * done idempotently so two listeners paying at once cannot collide.
 */
export async function payArtist(pair, recipients, micros, { artistName = "This artist", mint: mintAddress, memo, node, kind } = {}) {
  /** A receipt on this device, for the listener's own record (receipts.js). */
  const keep = (signature) => recordReceipt({
    micros, signature, origin: node?.origin || null, artist: artistName, network: networkName(),
    kind: kind || (node?.item !== undefined ? "purchase" : node?.tip ? "tip" : "listen"),
  });
  const shares = shareOut(micros, recipients);
  if (!shares.length) throw new PaymentError("nothing", "There was nothing to pay.");

  const conn = rpc();
  // The mint is overridable so the payment path can be proved end to end
  // against a throwaway token, rather than only ever being run for the first
  // time with somebody's real money in it.
  const mint = addressOf(mintAddress || network().usdc, "The network");
  const from = await getAssociatedTokenAddress(mint, pair.publicKey, false, TOKEN_PROGRAM_ID);
  const owners = shares.map((share) => addressOf(share.address, share.name || artistName));

  /** The payment, with `payer` paying the network fee and any new account. */
  const build = async (payer) => {
    const tx = new Transaction();
    for (const [i, share] of shares.entries()) {
      const owner = owners[i];
      const to = await getAssociatedTokenAddress(mint, owner, false, TOKEN_PROGRAM_ID);
      tx.add(createAssociatedTokenAccountIdempotentInstruction(payer, to, owner, mint, TOKEN_PROGRAM_ID));
      tx.add(createTransferCheckedInstruction(from, mint, to, pair.publicKey, share.micros, 6, [], TOKEN_PROGRAM_ID));
    }
    if (memo) {
      tx.add(new TransactionInstruction({
        keys: [{ pubkey: pair.publicKey, isSigner: true, isWritable: false }],
        programId: new PublicKey(MEMO_PROGRAM),
        data: Buffer.from(String(memo), "utf8"),
      }));
    }
    return tx;
  };

  // The artist's node pays the network fee, always: a listener never pays
  // one, whatever SOL their wallet holds. An artist whose fees account can't
  // pay can't be paid, and nothing is sent. Only a test token, proving this
  // path end to end (prove-payment.mjs), pays its own fee.
  if (!mintAddress) {
    const paused = () => new PaymentError("paused", `${artistName} can't take payments right now. Nothing was sent.`);
    if (node?.item === undefined && !node?.tip) {
      if (micros < LISTEN_MIN_MICROS) throw new PaymentError("small", "Less than a cent is owed. It waits until there's more.");
      if (micros > LISTEN_MAX_MICROS) throw new PaymentError("payment", "That's more than one payment can be. Nothing was sent.");
    }
    const offer = node?.origin ? await feeOffer(node.origin, { micros, owners, pair, item: node.item, tip: node.tip }) : null;
    if (!offer) throw paused();
    const tx = await build(offer.feePayer);
    tx.feePayer = offer.feePayer;
    const answer = await sendThroughNode(conn, node, tx, pair);
    // The node didn't send it, and said so: nothing went out.
    if (!answer) throw paused();
    const sent = answer.signature;
    try {
      await confirmed(conn, sent);
    } catch (e) {
      // Failed on the network: nothing was taken, and nothing is unsure.
      if (e instanceof PaymentError && e.kind === "failed") throw e;
      // Anything else — not seen landing in time, or the network not
      // answering while we asked — may still land. The signature lets the app
      // look it up later rather than guess (paying.js, before paying again).
      // Thrown as anything but "unconfirmed", it would be sent a second time.
      const unsure = e instanceof PaymentError && e.kind === "unconfirmed" ? e
        : new PaymentError("unconfirmed", "The network hasn't confirmed this yet. It may still go through, so it won't be sent again for now.");
      unsure.signature = sent;
      throw unsure;
    }
    keep(sent);
    // `nodeConfirmed`: whether the artist's server saw it land before it
    // answered. If not, it may not have counted it yet (paying.js tells it).
    return { signature: sent, shares, micros, feePaidBy: "artist", nodeConfirmed: answer.confirmed };
  }

  try {
    const signature = await conn.sendTransaction(await build(pair.publicKey), [pair], { preflightCommitment: "confirmed" });
    await confirmed(conn, signature);
    keep(signature);
    return { signature, shares, micros, feePaidBy: "listener" };
  } catch (e) {
    throw paymentProblem(e);
  }
}

/**
 * Did a payment that may have gone out actually land? For a debt whose last
 * payment wasn't seen landing, before anything is sent again.
 *
 * With its signature, the network says. Without (the artist's server never
 * answered), the listener's own recent transactions are read for a transfer
 * to these payees since then. A payment the network hasn't seen two minutes
 * on never will: its blockhash has expired. Returns the micros that landed
 * (0 when nothing did), or null when it can't tell yet: then nothing is sent.
 */
export async function landedSince(pair, recipients, { since, signature, now = Date.now() } = {}) {
  const conn = rpc();
  try {
    if (signature) {
      const s = (await conn.getSignatureStatuses([signature], { searchTransactionHistory: true })).value?.[0];
      if (s && !s.err && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) {
        const tx = await conn.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
        return paidIn(tx, pair, recipients);
      }
      if (s?.err) return 0;
      return now - since > EXPIRED_MS ? 0 : null;
    }
    if (now - since <= EXPIRED_MS) return null;
    const sigs = await conn.getSignaturesForAddress(pair.publicKey, { limit: 25 }, "confirmed");
    let micros = 0;
    for (const s of sigs) {
      if (s.err || !s.blockTime || s.blockTime * 1000 < since - 60_000) continue;
      const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      micros += await paidIn(tx, pair, recipients);
    }
    return micros;
  } catch {
    return null;
  }
}
const EXPIRED_MS = 2 * 60_000;

/** What one transaction paid these payees for listening, from this wallet. */
async function paidIn(tx, pair, recipients) {
  if (!tx || tx.meta?.err) return 0;
  const ixs = tx.transaction?.message?.instructions || [];
  // A purchase or a tip carries a note; listening never does.
  if (ixs.some((ix) => ix.programId?.toBase58?.() === MEMO_PROGRAM || ix.program === "spl-memo")) return 0;
  const mint = addressOf(network().usdc, "The network");
  const accounts = new Set(await Promise.all(recipients.filter((r) => r.address).map(async (r) =>
    (await getAssociatedTokenAddress(mint, new PublicKey(r.address), false, TOKEN_PROGRAM_ID)).toBase58())));
  const me = pair.publicKey.toBase58();
  let micros = 0;
  for (const ix of ixs) {
    const p = ix.parsed;
    if (p?.type !== "transferChecked" || p.info?.authority !== me || !accounts.has(p.info?.destination)) continue;
    micros += Number(p.info.tokenAmount?.amount || 0);
  }
  return micros;
}

/** A failed send, in words a listener can act on. */
function paymentProblem(e) {
  if (e instanceof PaymentError) return e;
  const said = String(e?.message || e);
  if (/insufficient lamports|insufficient funds for rent|0x1\b/i.test(said)) {
    return new PaymentError("fee", "There isn't enough SOL in your wallet to cover the network fee. Nothing was sent.");
  }
  if (/insufficient/i.test(said)) {
    return new PaymentError("funds", "There isn't enough in your wallet to pay this. Nothing was sent.");
  }
  if (/blockhash|timed out|failed to fetch|network/i.test(said)) {
    return new PaymentError("network", "Couldn't reach the network, so nothing was sent. What you owe is still owed.");
  }
  return new PaymentError("unknown", `The payment didn't go through, so nothing was sent. ${said}`);
}

// ── the artist's node paying the network fee ────────────────────────────────

const NODE_TIMEOUT_MS = 8_000;

/**
 * Whether this artist's node will pay the fee for this payment: who would,
 * or null. Anything odd about the answer is a no, and the listener pays the
 * fee themselves as before. Nothing about the listener is sent to ask.
 */
export async function feeOffer(origin, { micros, owners = [], pair, item, tip = false } = {}) {
  let o;
  try {
    const res = await fetch(`${origin}/listen/fees`, { signal: AbortSignal.timeout(NODE_TIMEOUT_MS) });
    if (!res.ok) return null;
    o = await res.json();
  } catch {
    return null;
  }
  if (!o?.feePayer || networkFor(o.network) !== networkName()) return null;
  let feePayer;
  try { feePayer = new PublicKey(o.feePayer); } catch { return null; }
  // Never a wallet that's also being paid, or the listener's own.
  if (owners.some((k) => k.equals(feePayer)) || pair?.publicKey.equals(feePayer)) return null;
  // A purchase's price is the node's to check; a listening payment must fit.
  if (item === undefined && !tip && !(micros >= Number(o.minMicros) && micros <= Number(o.maxMicros))) return null;
  return { feePayer };
}

/**
 * Hand the signed payment to the artist's node to add its fee signature and
 * send. The signature that comes back must be the node's own over exactly
 * this payment, so a confirmed signature means this payment landed.
 *
 * Returns `{ signature, confirmed }` (whether the node saw it land before
 * answering), or null when the node said it isn't paying fees just
 * now (409): then nothing went out. Any other refusal throws, with the node's
 * reason; so does anything where the payment may have gone out, so the same
 * debt is never paid twice.
 */
/** What an artist's node charges to pay the fee on a withdrawal, or null. */
async function withdrawOffer(origin) {
  let o;
  try {
    const res = await fetch(`${origin}/listen/fees`, { signal: AbortSignal.timeout(NODE_TIMEOUT_MS) });
    if (!res.ok) return null;
    o = await res.json();
  } catch { return null; }
  if (!o?.feePayer || networkFor(o.network) !== networkName() || !o.withdraw?.to) return null;
  const fee = Number(o.withdraw.fee), newAccountFee = Number(o.withdraw.newAccountFee);
  // A node can't ask more than this, whatever it says.
  // (Their own figures are 5¢, and 50¢ more to open an account; up to 10¢ and 70¢ is allowed.)
  if (!(fee >= 0 && fee <= 100_000 && newAccountFee >= 0 && newAccountFee <= 700_000)) return null;
  let feePayer;
  try { feePayer = new PublicKey(o.feePayer); } catch { return null; }
  return { feePayer, to: String(o.withdraw.to), fee, newAccountFee };
}

async function sendThroughNode(conn, node, tx, pair) {
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.partialSign(pair);
  const wire = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");

  let res;
  try {
    res = await fetch(`${node.origin}${node.route || "/listen/settle"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tx: wire, ...(node.item === undefined ? {} : { item: node.item }), ...(node.extra || {}) }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    // Unknown whether it reached the node, so unknown whether it was sent.
    throw new PaymentError("unconfirmed",
      "Couldn't hear back from the artist's server. The payment may still go through, so it won't be sent again for now.");
  }
  const body = await res.json().catch(() => ({}));
  if (res.ok) {
    const signature = String(body?.signature || "");
    let raw;
    try { raw = bs58.decode(signature); } catch { raw = null; }
    // A nonsense answer to a 200 is no proof that nothing went out: the node
    // may have sent it all the same. "unconfirmed", so the app reads its own
    // wallet's history before sending anything more (paying.js), rather than
    // paying the same debt again a minute later.
    if (!raw || raw.length !== 64) throw new PaymentError("unconfirmed", "The artist's server gave an answer that doesn't make sense. Nothing more will be sent for now.");
    tx.addSignature(tx.feePayer, Buffer.from(raw));
    if (!tx.verifySignatures()) throw new PaymentError("unconfirmed", "The artist's server gave an answer that doesn't match this payment. Nothing more will be sent for now.");
    return { signature, confirmed: body?.confirmed === true };
  }
  // Only the node's own refusals are safe to work around. Each is a JSON
  // error, and each comes before anything is sent, or after a payment failed
  // on the network having taken nothing (see node/src/settle.ts). Anything
  // else (a crash page, a bare 5xx) may have come after sending, so it's
  // treated as "may have gone": paying again could pay twice.
  const refused = typeof body?.error === "string" && res.status >= 400 && res.status < 600 && res.status !== 500;
  if (!refused) {
    throw new PaymentError("unconfirmed",
      "The artist's server had a problem part-way through. The payment may still go through, so it won't be sent again for now.");
  }
  if (res.status === 422 && /enough in your wallet/.test(body.error)) {
    throw new PaymentError("funds", "There isn't enough in your wallet to pay this. Nothing was sent.");
  }
  // Only this means their fees account can't pay: the node isn't offering.
  if (res.status === 409) return null;
  // Anything else the node turned away (busy, a limit, the network) is said
  // as it is. Nothing was sent, and what's owed is tried again later.
  throw new PaymentError("refused", `The artist's server didn't take this payment: ${String(body.error).slice(0, 200)}. Nothing was sent.`);
}
