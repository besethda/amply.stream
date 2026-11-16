/**
 * The node paying its listeners' network fees (see feepay.ts for what it
 * will sign, and why that is the whole of the security).
 *
 * The fee wallet is a key this node makes for itself, kept in the artist's
 * own database beside the key it signs listening tokens with. It holds a
 * little SOL and nothing else. No route returns it; it signs only
 * transactions checkFeePayment has accepted, and only after the network has
 * simulated them, so a payment that would fail (and still cost the fee) is
 * never sent. Even so, it is treated as a key that could one day be lost:
 * it holds only what fees need, the artist can see and empty it, and a
 * daily cap bounds what it can spend however it is asked.
 *
 * The signed transaction goes from here to the network and nowhere else.
 * What a listener gets back is the signature: proof it was sent, and nothing
 * they could send again themselves.
 */
import { readTransaction, writeTransaction, base58, base64, TxError } from "./solana-tx";
import { checkFeePayment, type FeePayExpect } from "./feepay";
import { setting } from "./store";

/** Bounds on a listening payment, in micro-dollars. The floor makes spam cost
 *  the sender more than the artist: each payment pays the artist at least a
 *  cent, and costs the fee wallet a few thousandths of one. The ceiling is the
 *  app's own largest payment. */
export const LISTEN_MIN_MICROS = 10_000;
export const LISTEN_MAX_MICROS = 2_000_000;

/** Fees paid per day, across every listener: a bound on spending, whatever
 *  goes wrong. At 10,000 lamports a payment, a full day is 0.01 SOL. */
export const DAILY_PAYMENTS = 1_000;

/** Below this, the node stops offering: enough for a payee's USDC account
 *  and a few hundred fees, and keeps the wallet itself above rent. */
export const OFFER_ABOVE_LAMPORTS = 3_000_000;

const FEE_KEY = "fee-wallet";
const RPC_TIMEOUT_MS = 10_000;
const CONFIRM_WITHIN_MS = 25_000;

// ── the key ─────────────────────────────────────────────────────────────────

interface FeeKey { address: string; sign(message: Uint8Array): Promise<Uint8Array> }
let cached: FeeKey | null = null;

async function load(stored: string): Promise<FeeKey> {
  const { pkcs8, address } = JSON.parse(stored) as { pkcs8: string; address: string };
  const raw = base64.decode(pkcs8);
  if (!raw || typeof address !== "string") throw new Error("the fee wallet's key is damaged");
  // Imported as not extractable: once loaded, this copy of it can only sign.
  const key = await crypto.subtle.importKey("pkcs8", raw, { name: "Ed25519" }, false, ["sign"]);
  return {
    address,
    sign: async (message) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, message)),
  };
}

/** This node's fee wallet, made the first time it's asked for. */
export async function feeKey(db: D1Database): Promise<FeeKey> {
  if (cached) return cached;
  let stored = await setting(db, FEE_KEY);
  if (!stored) {
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey) as ArrayBuffer);
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer);
    const made = JSON.stringify({ pkcs8: base64.encode(pkcs8), address: base58(pub) });
    // As with the token key: never overwrite one that's there, then read back
    // whichever was kept, so two requests at once agree on one wallet.
    await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING").bind(FEE_KEY, made).run();
    stored = (await setting(db, FEE_KEY)) ?? made;
  }
  cached = await load(stored);
  return cached;
}

/** Only the address, for the artist's editor and the offer. */
export async function feeAddress(db: D1Database): Promise<string> {
  return (await feeKey(db)).address;
}

/** Forget the loaded key (tests). */
export function forgetFeeKey(): void { cached = null; }

// ── the network ─────────────────────────────────────────────────────────────

export class RpcError extends Error {}

export type Rpc = (method: string, params: unknown[]) => Promise<any>;

export function rpcAt(url: string): Rpc {
  return async (method, params) => {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        // Solana's public endpoint refuses a Worker without a User-Agent.
        headers: { "Content-Type": "application/json", "User-Agent": "amply-node/1.0" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
    } catch {
      throw new RpcError("couldn't reach the network");
    }
    if (!res.ok) throw new RpcError(res.status === 429 ? "the network is busy" : "the network refused the request");
    const body = await res.json().catch(() => null) as { result?: unknown; error?: { message?: string } } | null;
    if (!body || body.error) throw new RpcError(`the network said: ${String(body?.error?.message || "nothing useful").slice(0, 200)}`);
    return body.result;
  };
}

/** The fee wallet's balance, asked at most every few minutes per copy of the
 *  Worker: the offer is read on every payment, and a question to the network
 *  each time would be slow and rude to a free endpoint. */
const balances = new Map<string, { lamports: number; at: number }>();
const BALANCE_FRESH_MS = 5 * 60_000;

export async function feeBalance(rpc: Rpc, address: string, { fresh = false, now = Date.now() } = {}): Promise<number> {
  const known = balances.get(address);
  if (known && !fresh && now - known.at < BALANCE_FRESH_MS) return known.lamports;
  const r = await rpc("getBalance", [address, { commitment: "confirmed" }]);
  const lamports = Number(r?.value ?? 0);
  balances.set(address, { lamports, at: now });
  return lamports;
}

// ── the daily cap ───────────────────────────────────────────────────────────

/** Count one more fee today; false once today's are used up. Fails closed:
 *  if the count can't be kept (a database built before this table), no fee
 *  is paid. */
export async function countFee(db: D1Database, now = Date.now()): Promise<boolean> {
  const day = new Date(now).toISOString().slice(0, 10);
  try {
    const row = await db.prepare(
      `INSERT INTO fee_days (day, count) VALUES (?, 1)
       ON CONFLICT(day) DO UPDATE SET count = count + 1
       RETURNING count`,
    ).bind(day).first<{ count: number }>();
    // Old days aren't needed; a month is kept for the artist to look at.
    if (row && row.count === 1) {
      await db.prepare("DELETE FROM fee_days WHERE day < ?").bind(new Date(now - 31 * 86400_000).toISOString().slice(0, 10)).run();
    }
    return !!row && row.count <= DAILY_PAYMENTS;
  } catch {
    return false;
  }
}

// ── settling ────────────────────────────────────────────────────────────────

export type Settled =
  | { ok: true; signature: string; micros: number; confirmed: boolean }
  | { ok: false; status: number; why: string };

const refuse = (status: number, why: string): Settled => ({ ok: false, status, why });

/**
 * Check, sign, simulate, send, and wait for it to land.
 *
 * `expect` comes from the artist's own manifest, never from the request.
 * `allowed` is the caller's per-listener rate limit, asked only once the
 * transaction is known to be a real payment from that listener.
 */
export async function settle(
  db: D1Database, rpc: Rpc, txBase64: unknown, expect: Omit<FeePayExpect, "feePayer">,
  { allowed = async (_listener: string) => true, now = Date.now(), wait = (ms: number) => new Promise((r) => setTimeout(r, ms)), confirmWithinMs = CONFIRM_WITHIN_MS }:
    { allowed?: (listener: string) => Promise<boolean>; now?: number; wait?: (ms: number) => Promise<unknown>; confirmWithinMs?: number } = {},
): Promise<Settled> {
  const bytes = base64.decode(String(txBase64 ?? ""));
  if (!bytes) return refuse(400, "that isn't a transaction");
  let tx;
  try { tx = readTransaction(bytes); } catch (e) {
    return refuse(400, e instanceof TxError ? e.message : "that isn't a transaction");
  }

  const key = await feeKey(db);
  const verdict = await checkFeePayment(tx, { ...expect, feePayer: key.address });
  if (!verdict.ok) return refuse(403, verdict.problem);

  if (!(await allowed(verdict.listener))) return refuse(429, "too many payments from this wallet; try again in a minute");
  if (!(await countFee(db, now))) return refuse(503, "this artist's node has paid all the fees it will today; try again tomorrow");

  tx.signatures[0] = await key.sign(tx.message);
  const signed = base64.encode(writeTransaction(tx));
  const signature = base58(tx.signatures[0]);

  try {
    // First, what would happen. A failed transaction still costs its fee,
    // so one that would fail isn't sent.
    const sim = await rpc("simulateTransaction", [signed, { encoding: "base64", sigVerify: true, commitment: "confirmed" }]);
    if (sim?.value?.err) return refuse(422, failureOf(sim.value));

    await rpc("sendTransaction", [signed, { encoding: "base64", skipPreflight: true, maxRetries: 5 }]);
  } catch (e) {
    return refuse(502, e instanceof RpcError ? e.message : "couldn't reach the network");
  }

  // Wait for it to land, briefly. If it hasn't yet, the listener's app can
  // look up the signature itself; nothing is lost either way.
  const until = Date.now() + confirmWithinMs;
  while (Date.now() < until) {
    await wait(1_500);
    try {
      const st = (await rpc("getSignatureStatuses", [[signature]]))?.value?.[0];
      if (st?.err) return refuse(422, "the payment failed on the network; nothing was taken");
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
        return { ok: true, signature, micros: verdict.micros, confirmed: true };
      }
    } catch { /* keep waiting */ }
  }
  return { ok: true, signature, micros: verdict.micros, confirmed: false };
}

/** What a failed simulation means, for a listener. */
function failureOf(value: { err?: unknown; logs?: string[] }): string {
  const logs = (value.logs || []).join("\n");
  if (/insufficient funds/i.test(logs) && /Transfer/i.test(logs)) return "there isn't enough in your wallet to pay this; nothing was sent";
  if (/Blockhash not found|BlockhashNotFound/i.test(JSON.stringify(value.err)) ) return "that payment is out of date; try again";
  if (/insufficient lamports|InsufficientFundsForFee|InsufficientFundsForRent/i.test(logs + JSON.stringify(value.err))) {
    return "this artist's node can't pay the network fee right now; nothing was sent";
  }
  return "the network wouldn't accept that payment; nothing was sent";
}
