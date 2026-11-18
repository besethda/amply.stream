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
import { readTransaction, writeTransaction, base58, base64, TxError, tokenAccountOf } from "./solana-tx";
import { checkFeePayment, TOKEN_PROGRAM, ATA_PROGRAM, type FeePayExpect } from "./feepay";
import { setting } from "./store";
import { FEES_READY_LAMPORTS, LISTEN_MIN_MICROS as MIN, LISTEN_MAX_MICROS as MAX } from "../../spec/pricing.mjs";

/** Bounds on a listening payment, in micro-dollars. The floor makes spam cost
 *  the sender more than the artist: each payment pays the artist at least a
 *  cent, and costs the fee wallet a few thousandths of one. The ceiling is the
 *  app's own largest payment. */
export const LISTEN_MIN_MICROS = MIN;
export const LISTEN_MAX_MICROS = MAX;

/** Fees paid per day, across every listener: a bound on spending, whatever
 *  goes wrong. At 10,000 lamports a payment, a full day is 0.01 SOL. */
export const DAILY_PAYMENTS = 1_000;
/** Sends to the bank, counted apart, so listeners' traffic can never stop
 *  the artist cashing out. */
export const DAILY_SENDS = 50;

export type FeeKind = "pay" | "send";
/** The fee_days row a day's fees of this kind are counted under (the
 *  editor's fees status reads the same one). */
export const dayKey = (kind: FeeKind, now: number) => {
  const day = new Date(now).toISOString().slice(0, 10);
  return kind === "send" ? `send:${day}` : day;
};
const capOf = (kind: FeeKind) => (kind === "send" ? DAILY_SENDS : DAILY_PAYMENTS);

/** Below this, the node stops offering: enough for a payee's USDC account
 *  and a few hundred fees, and keeps the wallet itself above rent. Below it,
 *  too, the artist's USDC price is paused (spec/pricing.mjs): the listener's
 *  app checks the same number on the network itself. */
export const OFFER_ABOVE_LAMPORTS = FEES_READY_LAMPORTS;

/** What a listener pays the artist, in USDC, when the artist's node pays the
 *  network fee on their withdrawal: the fee, and more when the destination's
 *  USDC account has to be opened (about 0.002 SOL of rent). */
export const WITHDRAW_FEE_MICROS = 50_000;
export const NEW_ACCOUNT_FEE_MICROS = 500_000;

const FEE_KEY = "fee-wallet";
const RPC_TIMEOUT_MS = 10_000;
/** Tries per question when the network answers busy, and the longest wait between. */
const RPC_TRIES = 4;
const RPC_PAUSE_MAX_MS = 2_000;
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

/** The words Amply's relay checks before opening Coinbase for a wallet
 *  (relay/src/index.ts, onrampMessage); test-coinbase.mjs keeps them equal. */
export const onrampMessage = (address: string, signedAt: number) =>
  `Amply: add money to ${address} through Coinbase (${signedAt})`;

/**
 * The fees account's signature for a Coinbase purchase of SOL into itself,
 * so the artist can top it up in one tap. All it can start is a purchase
 * into this account; the time must be now, so it's soon useless if copied.
 */
export async function feeOnrampSignature(db: D1Database, signedAt: number, now = Date.now()): Promise<{ address: string; signature: string } | null> {
  if (!Number.isSafeInteger(signedAt) || Math.abs(now - signedAt) > 30_000) return null;
  const key = await feeKey(db);
  const sig = await key.sign(new TextEncoder().encode(onrampMessage(key.address, signedAt)));
  return { address: key.address, signature: base58(sig) };
}

/** Forget the loaded key (tests). */
export function forgetFeeKey(): void { cached = null; }

// ── the network ─────────────────────────────────────────────────────────────

export class RpcError extends Error {}

type Rpc = (method: string, params: unknown[]) => Promise<any>;

export function rpcAt(url: string, timeoutMs = RPC_TIMEOUT_MS, tries = RPC_TRIES, pause: (ms: number) => Promise<unknown> = (ms) => new Promise((r) => setTimeout(r, ms))): Rpc {
  return async (method, params) => {
    // A free endpoint shares one rate limit between everyone on a Worker's
    // address, so a busy answer (429) or a hiccup (5xx) is ordinary traffic.
    // Asking again after a moment is safe for every call made here: a
    // sendTransaction repeats the same signed transaction, which lands once.
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          // Solana's public endpoint refuses a Worker without a User-Agent.
          headers: { "Content-Type": "application/json", "User-Agent": "amply-node/1.0" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new RpcError("couldn't reach the network");
      }
      if (!res.ok) {
        if ((res.status === 429 || res.status >= 500) && attempt < tries) {
          const told = Number(res.headers.get("Retry-After"));
          await pause(Math.min(Number.isFinite(told) && told > 0 ? told * 1000 : 400 * attempt, RPC_PAUSE_MAX_MS));
          continue;
        }
        throw new RpcError(res.status === 429 ? "the network is busy" : "the network refused the request");
      }
      const body = await res.json().catch(() => null) as { result?: unknown; error?: { message?: string } } | null;
      if (!body || body.error) throw new RpcError(`the network said: ${String(body?.error?.message || "nothing useful").slice(0, 200)}`);
      return body.result;
    }
  };
}

/** The fee wallet's balance, asked at most every few minutes per copy of the
 *  Worker: the offer is read on every payment, and a question to the network
 *  each time would be slow and rude to a free endpoint. */
const balances = new Map<string, { lamports: number; at: number }>();
const BALANCE_FRESH_MS = 5 * 60_000;
/** A balance this old still stands while the network can't be asked. */
const BALANCE_STANDS_MS = 3_600_000;
/** After a failed ask, how long the balance is simply unknown, without asking
 *  again: during an outage, one request waits for the network, not every one. */
const FAILURE_REMEMBERED_MS = 30_000;
/** How long a listener's request waits for the balance when nothing is known.
 *  The network answers in well under a second when it's well. */
export const BALANCE_TIMEOUT_MS = 3_000;
const failures = new Map<string, number>();
const asking = new Map<string, Promise<number>>();

/** One question to the network at a time per wallet; the answer, or the
 *  failure, is remembered. */
function askBalance(rpc: Rpc, address: string, now: number): Promise<number> {
  const already = asking.get(address);
  if (already) return already;
  const p = (async () => {
    try {
      const r = await rpc("getBalance", [address, { commitment: "confirmed" }]);
      const lamports = Number(r?.value ?? 0);
      balances.set(address, { lamports, at: now });
      failures.delete(address);
      return lamports;
    } catch (e) {
      failures.set(address, now);
      throw e;
    } finally {
      asking.delete(address);
    }
  })();
  asking.set(address, p);
  return p;
}

/**
 * `later`, where given, is the request's ctx.waitUntil: a balance that's a few
 * minutes old is then used at once and asked again in the background, so no
 * listener waits on the network for it. Without it, the ask is awaited.
 */
export async function feeBalance(rpc: Rpc, address: string, { fresh = false, now = Date.now(), later }:
  { fresh?: boolean; now?: number; later?: (p: Promise<unknown>) => void } = {}): Promise<number> {
  const known = balances.get(address);
  const stands = !!known && now - known.at < BALANCE_STANDS_MS;
  if (known && !fresh && now - known.at < BALANCE_FRESH_MS) return known.lamports;
  if (!fresh) {
    if (stands && later) {
      later(askBalance(rpc, address, now).catch(() => {}));
      return known!.lamports;
    }
    // The network failed just now: don't wait on it again so soon.
    const failed = failures.get(address);
    if (failed !== undefined && now - failed < FAILURE_REMEMBERED_MS) {
      if (stands) return known!.lamports;
      throw new RpcError("couldn't reach the network just now");
    }
  }
  try {
    return await askBalance(rpc, address, now);
  } catch (e) {
    // A busy network for a minute shouldn't pause the artist's price: what
    // was true within the hour stands. Any older, and nobody can say.
    if (!fresh && stands) return known!.lamports;
    throw e;
  }
}

// ── the daily cap ───────────────────────────────────────────────────────────

/** Whether today's fees of this kind still have room, without counting one.
 *  Fails closed: no table (a database built before it), no fees. */
export async function feeRoom(db: D1Database, kind: FeeKind = "pay", now = Date.now()): Promise<boolean> {
  try {
    const row = await db.prepare("SELECT count FROM fee_days WHERE day = ?").bind(dayKey(kind, now)).first<{ count: number }>();
    return (row?.count ?? 0) < capOf(kind);
  } catch {
    return false;
  }
}

/** Count one more fee today; false once today's are used up. Called only for
 *  a payment the network has accepted in simulation, so payments that could
 *  never succeed (an empty wallet, say) don't use up the day. Fails closed. */
export async function countFee(db: D1Database, now = Date.now(), kind: FeeKind = "pay"): Promise<boolean> {
  try {
    const row = await db.prepare(
      `INSERT INTO fee_days (day, count) VALUES (?, 1)
       ON CONFLICT(day) DO UPDATE SET count = count + 1
       RETURNING count`,
    ).bind(dayKey(kind, now)).first<{ count: number }>();
    // Old days aren't needed; a month is kept for the artist to look at.
    if (row && row.count === 1) {
      const cutoff = new Date(now - 31 * 86400_000).toISOString().slice(0, 10);
      await db.prepare("DELETE FROM fee_days WHERE (day NOT LIKE 'send:%' AND day < ?) OR (day LIKE 'send:%' AND substr(day, 6) < ?)")
        .bind(cutoff, cutoff).run();
    }
    return !!row && row.count <= capOf(kind);
  } catch {
    return false;
  }
}

// ── opening payees' accounts, once each ─────────────────────────────────────

/**
 * Opening a USDC account costs the fee wallet about 0.002 SOL of rent, which
 * goes to whoever later closes it. So the node opens each payee's account at
 * most once: a payee who closed theirs (and kept the rent) can't have the fee
 * wallet pay to reopen it again and again. Recorded in fee_days, under the
 * owner's address, which holds nothing about any listener.
 */
async function openedBefore(db: D1Database, owner: string): Promise<boolean> {
  const row = await db.prepare("SELECT count FROM fee_days WHERE day = ?").bind(`opened:${owner}`).first<{ count: number }>();
  return !!row;
}
async function noteOpened(db: D1Database, owner: string): Promise<void> {
  await db.prepare("INSERT INTO fee_days (day, count) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET count = count + 1").bind(`opened:${owner}`).run();
}

// ── settling ────────────────────────────────────────────────────────────────

export type Settled =
  | { ok: true; signature: string; micros: number; confirmed: boolean; listener: string }
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
  { allowed = async (_listener: string) => true, now = Date.now(), wait = (ms: number) => new Promise((r) => setTimeout(r, ms)), confirmWithinMs = CONFIRM_WITHIN_MS, from, kind = "pay", openOnce }:
    { allowed?: (listener: string) => Promise<boolean>; now?: number; wait?: (ms: number) => Promise<unknown>; confirmWithinMs?: number; from?: string[]; kind?: FeeKind;
      /** Whose accounts the node will open only once; by default every payee. */
      openOnce?: string[] } = {},
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
  // The artist cashing out: only from one of their own payout wallets.
  if (from && !from.includes(verdict.listener)) return refuse(403, "that isn't one of your payout wallets");

  if (!(await allowed(verdict.listener))) return refuse(429, "too many payments from this wallet; try again in a minute");
  const full = refuse(503, kind === "send"
    ? "that's the most sends to the bank in one day; try again tomorrow"
    : "this artist's node has paid all the fees it will today; try again tomorrow");
  if (!(await feeRoom(db, kind, now))) return full;
  // Which payees' accounts this transfer would open, and whether any was
  // opened before (and so has been closed since).
  const once = openOnce ?? verdict.shares.map((s) => s.address);
  const opening: string[] = [];
  if (once.length) {
    try {
      const accounts = await Promise.all(once.map((o) => tokenAccountOf(o, expect.mint, TOKEN_PROGRAM, ATA_PROGRAM)));
      const found = await rpc("getMultipleAccounts", [accounts, { encoding: "base64", commitment: "confirmed" }]);
      once.forEach((o, i) => { if (!found?.value?.[i]) opening.push(o); });
    } catch (e) {
      return refuse(502, e instanceof RpcError ? e.message : "couldn't reach the network");
    }
    for (const o of opening) {
      if (await openedBefore(db, o).catch(() => true)) {
        return refuse(403, "a payee closed their USDC account after this server opened it; they need to open it again themselves");
      }
    }
  }


  tx.signatures[0] = await key.sign(tx.message);
  const signed = base64.encode(writeTransaction(tx));
  const signature = base58(tx.signatures[0]);

  try {
    // First, what would happen. A failed transaction still costs its fee,
    // so one that would fail isn't sent.
    const sim = await rpc("simulateTransaction", [signed, { encoding: "base64", sigVerify: true, commitment: "confirmed" }]);
    if (sim?.value?.err) {
      const why = failureOf(sim.value);
      // The fees account ran out between balance checks: that's "not paying
      // fees right now" (409), which the app knows to wait on, not a fault.
      // And the remembered balance goes, so the next look asks the network.
      if (why === CANT_PAY_FEE) { balances.delete(key.address); return refuse(409, why); }
      return refuse(422, why);
    }
  } catch (e) {
    // Nothing was sent: the listener can safely try again, or pay otherwise.
    return refuse(502, e instanceof RpcError ? e.message : "couldn't reach the network");
  }
  // Only now does it count: it would succeed, and it's about to be paid for.
  if (!(await countFee(db, now, kind))) return full;
  for (const o of opening) await noteOpened(db, o).catch(() => {});

  try {
    await rpc("sendTransaction", [signed, { encoding: "base64", skipPreflight: true, maxRetries: 5 }]);
  } catch {
    // It may have gone anyway: an answer lost is not a payment unsent. So the
    // listener gets the signature to look up, never a "try again" that could
    // pay twice.
    return { ok: true, signature, micros: verdict.micros, confirmed: false, listener: verdict.listener };
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
        return { ok: true, signature, micros: verdict.micros, confirmed: true, listener: verdict.listener };
      }
    } catch { /* keep waiting */ }
  }
  return { ok: true, signature, micros: verdict.micros, confirmed: false, listener: verdict.listener };
}

const CANT_PAY_FEE = "this artist's node can't pay the network fee right now; nothing was sent";

/** What a failed simulation means, for a listener. */
function failureOf(value: { err?: unknown; logs?: string[] }): string {
  const logs = (value.logs || []).join("\n");
  if (/insufficient funds/i.test(logs) && /Transfer/i.test(logs)) return "there isn't enough in your wallet to pay this; nothing was sent";
  if (/Blockhash not found|BlockhashNotFound/i.test(JSON.stringify(value.err)) ) return "that payment is out of date; try again";
  if (/insufficient lamports|InsufficientFundsForFee|InsufficientFundsForRent/i.test(logs + JSON.stringify(value.err))) {
    return CANT_PAY_FEE;
  }
  return "the network wouldn't accept that payment; nothing was sent";
}
