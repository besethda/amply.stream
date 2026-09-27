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
import { rpc, network } from "./wallet.js";
import { toMicros, toUsd } from "./money.js";
import { SETTLE_WITHIN_DAYS as SETTLE_AFTER_DAYS } from "../../spec/pricing.mjs";

export { MICROS, toMicros, toUsd } from "./money.js";
export { SETTLE_AFTER_DAYS };

/**
 * Divide a payment between the people named in the manifest.
 *
 * Every micro is accounted for. Percentages rarely divide cleanly, so each
 * share takes its whole part and the micros left over go to whoever was cut
 * hardest by the rounding, largest shortfall first. Three people splitting a
 * penny get 34, 33 and 33 rather than 33, 33, 33 and a micro that belongs to
 * nobody.
 */
export function shareOut(micros, recipients) {
  const total = Math.max(0, Math.floor(micros));
  if (!recipients.length || total === 0) return [];

  const exact = recipients.map((r) => (total * (Number(r.split) || 0)) / 100);
  const parts = exact.map((e) => Math.floor(e));
  let left = total - parts.reduce((a, b) => a + b, 0);

  // Largest remainder first, and a stable order so the same payment always
  // divides the same way.
  const order = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  for (let k = 0; left > 0; k++, left--) parts[order[k % order.length].i] += 1;

  return recipients
    .map((r, i) => ({ ...r, micros: parts[i] }))
    .filter((r) => r.micros > 0);
}

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
    if (s?.err) throw new Error(`transaction failed: ${JSON.stringify(s.err)}`);
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
export async function sendDollarsOut(pair, destination, micros = "all") {
  const conn = rpc();
  const to = destinationOf(destination, pair);
  const mint = new PublicKey(network().usdc);
  const from = await getAssociatedTokenAddress(mint, pair.publicKey, false, TOKEN_PROGRAM_ID);

  let amount = micros;
  if (amount === "all") {
    const held = await conn.getTokenAccountBalance(from).catch(() => null);
    amount = Number(held?.value?.amount || 0);
  }
  if (!(amount > 0)) throw new PaymentError("nothing", "There are no dollars in this wallet to send.");

  const toAccount = await getAssociatedTokenAddress(mint, to, false, TOKEN_PROGRAM_ID);
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
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

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
export async function payArtist(pair, recipients, micros, { artistName = "This artist", mint: mintAddress, memo } = {}) {
  const shares = shareOut(micros, recipients);
  if (!shares.length) throw new PaymentError("nothing", "There was nothing to pay.");

  const conn = rpc();
  // The mint is overridable so the payment path can be proved end to end
  // against a throwaway token, rather than only ever being run for the first
  // time with somebody's real money in it.
  const mint = addressOf(mintAddress || network().usdc, "The network");
  const from = await getAssociatedTokenAddress(mint, pair.publicKey, false, TOKEN_PROGRAM_ID);

  const tx = new Transaction();
  for (const share of shares) {
    const owner = addressOf(share.address, share.name || artistName);
    const to = await getAssociatedTokenAddress(mint, owner, false, TOKEN_PROGRAM_ID);
    tx.add(createAssociatedTokenAccountIdempotentInstruction(pair.publicKey, to, owner, mint, TOKEN_PROGRAM_ID));
    tx.add(createTransferCheckedInstruction(from, mint, to, pair.publicKey, share.micros, 6, [], TOKEN_PROGRAM_ID));
  }
  if (memo) {
    tx.add(new TransactionInstruction({
      keys: [{ pubkey: pair.publicKey, isSigner: true, isWritable: false }],
      programId: new PublicKey(MEMO_PROGRAM),
      data: Buffer.from(String(memo), "utf8"),
    }));
  }

  try {
    const signature = await conn.sendTransaction(tx, [pair], { preflightCommitment: "confirmed" });
    await confirmed(conn, signature);
    return { signature, shares, micros };
  } catch (e) {
    const said = String(e?.message || e);
    if (/insufficient lamports|insufficient funds for rent|0x1\b/i.test(said)) {
      throw new PaymentError("fee", "There isn't enough SOL in your wallet to cover the network fee. Nothing was sent.");
    }
    if (/insufficient/i.test(said)) {
      throw new PaymentError("funds", "There isn't enough in your wallet to pay this. Nothing was sent.");
    }
    if (/blockhash|timed out|failed to fetch|network/i.test(said)) {
      throw new PaymentError("network", "Couldn't reach the network, so nothing was sent. What you owe is still owed.");
    }
    throw new PaymentError("unknown", `The payment didn't go through, so nothing was sent. ${said}`);
  }
}
