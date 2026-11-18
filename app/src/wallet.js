/**
 * The listener's spending wallet.
 *
 * Money in a pocket, not money in a bank. The key is generated on this device,
 * stored on this device, and never sent anywhere: not to Amply, which has no
 * server to send it to, and not to any artist. Amply cannot spend it, freeze
 * it, see it or recover it, and that is the point. It also keeps this software
 * outside MiCA, which regulates holding or moving crypto *on behalf of* someone
 * else. Three rules this file keeps: the key never leaves the device, Amply
 * never sells crypto itself (top-ups open Coinbase, Cash App or Stripe, who
 * sell it under their own licences), and nothing is ever pooled.
 *
 * The consequence for the listener is the pocket, not the bank: lose the device
 * without the backup and the money is gone. So the app asks them to keep small
 * amounts here, and to write the backup down.
 */
import "./buffer-shim.js";
import { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { NETWORKS, networkName, network, useNetwork, networkFor, payableHere } from "./networks.js";

// Which chain the money is on lives in networks.js, so screens can ask without
// loading the Solana libraries. Re-exported for code that already has this module.
export { NETWORKS, networkName, network, useNetwork, networkFor, payableHere };

const KEY = "amply.wallet.v1";

let connection = null;
let connectedTo = null;
export function rpc() {
  const net = networkName();
  if (!connection || connectedTo !== net) {
    connection = new Connection(NETWORKS[net].rpc, "confirmed");
    connectedTo = net;
  }
  return connection;
}

// ── the key ─────────────────────────────────────────────────────────────────

/** Read the wallet on this device, or null if there isn't one yet. */
export function loadWallet() {
  let raw;
  try { raw = localStorage.getItem(KEY); } catch { return null; }
  if (!raw) return null;
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  } catch {
    // Corrupt rather than absent. Refusing is right: silently making a new one
    // would look like the money vanished.
    throw new Error("The wallet on this device could not be read. If you have your backup, restore it.");
  }
}

/** Make one. Refuses to overwrite an existing wallet, which would lose funds. */
export function createWallet() {
  if (loadWallet()) throw new Error("This device already has a wallet.");
  const pair = Keypair.generate();
  save(pair);
  return pair;
}

/** Make one without keeping it: kept (keepWallet) only once its key is saved,
 *  so a listener who backs out never leaves an unsaved wallet behind. */
export const generateWallet = () => Keypair.generate();

/** Keep one made by generateWallet. Never over another. */
export function keepWallet(pair) {
  const had = loadWallet();
  if (had && had.publicKey.toBase58() !== pair.publicKey.toBase58()) throw new Error("This device already has a wallet.");
  if (!had) save(pair);
  return pair;
}

function save(pair) {
  try {
    localStorage.setItem(KEY, JSON.stringify(Array.from(pair.secretKey)));
  } catch {
    throw new Error("This device wouldn't let the app save a wallet. Private browsing usually blocks it.");
  }
}

/**
 * The backup, and the only copy that exists anywhere else.
 *
 * A base58 secret key rather than a word list: twelve words need a wordlist and
 * a derivation scheme to mean anything, and a string that is obviously a secret
 * is harder to mistake for something safe to paste into a chat.
 */
export const backupOf = (pair) => bs58(pair.secretKey);

export function restoreWallet(secret) {
  const cleaned = String(secret || "").trim();
  if (!cleaned) throw new Error("Paste your backup first.");
  let bytes;
  try {
    bytes = unbs58(cleaned);
  } catch {
    throw new Error("That isn't a backup key.");
  }
  if (bytes.length !== 64) throw new Error("That isn't a backup key.");
  const pair = Keypair.fromSecretKey(bytes);
  save(pair);
  return pair;
}

/**
 * Keep a wallet that came from a passkey (spec/passkey-wallet.mjs). The
 * passkey can always make it again, on this device or another, so the copy
 * kept here is only for everyday use. If this device already has a different
 * wallet, it is never replaced: that would hide the money in it.
 */
export function adoptSeed(seed) {
  const pair = Keypair.fromSeed(seed);
  const existing = loadWallet();
  if (existing && existing.publicKey.toBase58() !== pair.publicKey.toBase58()) {
    throw new Error("This device already has a different wallet. Send its money to the new one first, or remove it.");
  }
  save(pair);
  try { localStorage.setItem(PASSKEY_KEY, pair.publicKey.toBase58()); } catch { /* shown as unprotected */ }
  return pair;
}

const PASSKEY_KEY = "amply.wallet.passkey";

/** Whether this wallet came from a passkey, so it can be made again anywhere. */
export function fromPasskey(pair) {
  try { return !!pair && localStorage.getItem(PASSKEY_KEY) === pair.publicKey.toBase58(); } catch { return false; }
}

/** Deliberately explicit, and never called without asking first. */
export function forgetWallet() {
  try { localStorage.removeItem(KEY); localStorage.removeItem(PASSKEY_KEY); } catch { /* nothing to do */ }
}

// ── what's in it ────────────────────────────────────────────────────────────

/**
 * The spendable balance, in dollars, and the fee balance, in SOL.
 *
 * Two balances because Solana charges its network fee in SOL while the money
 * itself is USDC: a wallet can hold plenty to pay artists with and still be
 * unable to send it. The app has to say so rather than let payments fail.
 */
export async function balances(pair) {
  const conn = rpc();
  const mint = new PublicKey(network().usdc);
  const owner = pair.publicKey;

  const [sol, dollars] = await Promise.all([
    // Not caught: a failed read has to reach the screen as a failure, not as
    // 0, or a wallet holding money looks empty.
    conn.getBalance(owner).then((l) => l / LAMPORTS_PER_SOL),
    (async () => {
      try {
        const ata = await getAssociatedTokenAddress(mint, owner, false, TOKEN_PROGRAM_ID);
        const account = await getAccount(conn, ata, "confirmed", TOKEN_PROGRAM_ID);
        return { usdc: Number(account.amount) / 1e6, account: true };   // six decimals
      } catch {
        return { usdc: 0, account: false };   // no token account yet is simply no dollars yet
      }
    })(),
  ]);

  // Whether the wallet exists on the network at all (it does once it holds
  // any SOL) and has an account for dollars. A Solana Pay request to a wallet
  // missing either is refused by the wallet paying it — Phantom calls it an
  // "invalid link" — so the first top-up has to be an ordinary send, which
  // creates both.
  return { sol, usdc: dollars.usdc, dollarAccount: dollars.account, exists: sol > 0 };
}

// ── base58, because a key has to be written down ────────────────────────────

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function bs58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = ALPHABET[0] + out; else break; }
  return out;
}

export function unbs58(text) {
  let n = 0n;
  for (const ch of text) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("not base58");
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const ch of text) { if (ch === ALPHABET[0]) bytes.unshift(0); else break; }
  return Uint8Array.from(bytes);
}
