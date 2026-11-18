/**
 * Checking that a listener really paid.
 *
 * The listener's app says "here is the transaction where I paid you". The node
 * does not take its word for any of it: it fetches the transaction from the
 * chain and checks, itself, that the money arrived, in the right currency, at
 * the right address, from the key claiming credit for it.
 *
 * Every field in the claim is attacker-controlled. A transaction that exists
 * but paid somebody else, or paid in a worthless token, or was sent by a
 * different wallet, must all fail. So must one already spent for access.
 */
import { MEMO_PROGRAM, TOKEN_PROGRAM } from "../../spec/chains.mjs";

export interface PaymentClaim {
  signature: string;    // the transaction
  payer: string;        // the wallet claiming it
}

export interface PaymentTerms {
  rpc: string;          // where to ask
  mint: string;         // which token counts as money
  recipients: string[]; // addresses of this artist and any collaborators
  minMicros: number;    // the least that buys anything
  /** A note the transaction must carry, saying what it paid for. Without it,
   *  any earlier payment to the artist — a tip, a settled listen — could be
   *  presented as paying for something else. */
  memo?: string;
}

export interface PaymentResult {
  ok: boolean;
  why?: string;
  micros?: number;
  when?: number;        // block time, seconds
  status?: number;      // for diagnosis; never shown to a listener
  detail?: string;
}

const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,120}$/;

/** The note a purchase's payment carries: which artist, and what it bought. */
export const purchaseMemo = (host: string, item: string) => `amply:buy:${host}:${item}`;
/** A tip's note: the app writes the same (app/src/tips.js). */
export const tipMemo = (host: string) => `amply:tip:${host}`;
/** A tip is ten cents to fifty dollars: the app offers $1, $3 and $5. */
export const TIP_MIN_MICROS = 100_000;
export const TIP_MAX_MICROS = 50_000_000;

/**
 * Ask the chain what happened, and believe only the chain.
 *
 * Counts every transfer of the right token to any of the artist's addresses,
 * which is what a split payment looks like: one transaction, several
 * recipients. Their shares add up to what the listener paid.
 */
export async function verifyPayment(claim: PaymentClaim, terms: PaymentTerms): Promise<PaymentResult> {
  if (!SIG.test(claim.signature || "")) return { ok: false, why: "that is not a transaction signature" };

  let body: any;
  try {
    const res = await fetch(terms.rpc, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Solana's public endpoint answers curl and refuses a Worker with a
        // 403 unless one of these is set.
        "User-Agent": "amply-node/1.0",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        // Confirmed, not finalized: a supermajority has voted for it, which is
        // plenty for a song, and it's there seconds after sending rather than
        // most of a minute.
        params: [claim.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }],
      }),
    });
    if (!res.ok) {
      // Public RPC endpoints rate limit hard, and "busy" is a different problem
      // from "unreachable": the first is worth retrying, the second means the
      // artist's node is pointed somewhere wrong.
      return {
        ok: false,
        why: res.status === 429 ? "the network is busy" : "the network refused the question",
        status: res.status,
        detail: (await res.text().catch(() => "")).slice(0, 300),
      };
    }
    body = await res.json();
  } catch (e) {
    return { ok: false, why: "could not reach the network", detail: String((e as Error)?.message || e) };
  }

  const tx = body?.result;
  if (!tx) return { ok: false, why: "no such transaction" };
  if (tx.meta?.err) return { ok: false, why: "that transaction failed" };

  const wanted = new Set(terms.recipients);
  let micros = 0;
  let sawPayer = false;

  // Token transfers appear as parsed instructions, and a split payment is
  // several of them in one transaction.
  const all = [
    ...(tx.transaction?.message?.instructions ?? []),
    ...(tx.meta?.innerInstructions ?? []).flatMap((i: any) => i.instructions ?? []),
  ];

  for (const ix of all) {
    const p = ix?.parsed;
    if (!p || (p.type !== "transferChecked" && p.type !== "transfer")) continue;
    const info = p.info ?? {};
    if (info.mint && info.mint !== terms.mint) continue;      // a different token
    // Only what the buyer sent counts towards what the buyer paid.
    if (!info.authority || info.authority !== claim.payer) continue;
    sawPayer = true;

    const amount = Number(info.tokenAmount?.amount ?? info.amount ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    // Where it went, and in what. A bare `transfer` names no mint, so the
    // destination account's balance entry is what says: without this, a
    // worthless token sent to an account the artist "owns" (anyone can make
    // one) would count as dollars.
    const to = destinationOf(tx, info.destination);
    if (to && to.mint === terms.mint && wanted.has(to.owner)) micros += amount;
  }

  if (terms.memo !== undefined) {
    const noted = all.some((ix: any) => (ix?.program === "spl-memo" || ix?.programId === MEMO_PROGRAM) && ix?.parsed === terms.memo);
    if (!noted) return { ok: false, why: "that payment wasn't for this" };
  }
  if (!sawPayer) return { ok: false, why: "that payment was not sent by this wallet" };
  if (micros <= 0) return { ok: false, why: "that payment did not go to this artist" };
  if (micros < terms.minMicros) return { ok: false, why: "that payment was too small", micros };

  return { ok: true, micros, when: tx.blockTime ?? undefined };
}

// ── a payment for listening, reported by the listener's app ────────────────

export interface ListeningTerms {
  mint: string;                       // USDC on the artist's network
  /** Each payee's own USDC account, mapped to the payee. */
  accounts: Map<string, string>;
  now: number;
  /** How old a payment may be and still be reported, in milliseconds. */
  withinMs: number;
}

export type ListeningVerdict =
  | { ok: true; payer: string; micros: number; when: number | null }
  | { ok: false; why: string; retry?: boolean };

/**
 * Is this transaction, as the chain returned it (getTransaction, jsonParsed),
 * a plain payment for listening to this artist — and who made it?
 *
 * Plain means what the app sends when it pays for listening, and what the
 * editor counts as paying for listening when it reads the chain: USDC, from
 * one wallet that signed it, into the artist's payees' own USDC accounts and
 * nowhere else, with no note. A note marks a tip or a purchase, which are not
 * payment for listening; a transfer anywhere else is a withdrawal or
 * something stranger, whose fee to the artist isn't either. Nothing here is
 * taken from the request but the signature: who paid is read off the chain,
 * so reporting someone else's payment only ever credits them.
 */
export function readListeningPayment(tx: any, terms: ListeningTerms): ListeningVerdict {
  // Not there yet: an unconfirmed send may still land, so worth asking again.
  if (!tx) return { ok: false, retry: true, why: "that payment isn't on the network yet; try again in a minute" };
  if (tx.meta?.err) return { ok: false, why: "that payment failed on the network" };
  const blockMs = Number(tx.blockTime) > 0 ? Number(tx.blockTime) * 1000 : null;
  if (blockMs !== null && terms.now - blockMs > terms.withinMs) return { ok: false, why: "that payment is too old to report" };

  const all = [
    ...(tx.transaction?.message?.instructions ?? []),
    ...(tx.meta?.innerInstructions ?? []).flatMap((i: any) => i?.instructions ?? []),
  ];
  if (all.some((ix: any) => ix?.program === "spl-memo" || ix?.programId === MEMO_PROGRAM)) {
    return { ok: false, why: "that payment carries a note: a tip or a purchase, not paying for listening" };
  }

  const keys: { pubkey: string; signer?: boolean }[] = (tx.transaction?.message?.accountKeys ?? [])
    .map((k: any) => (typeof k === "string" ? { pubkey: k } : k));
  let payer: string | null = null;
  let micros = 0;
  for (const ix of all) {
    const p = ix?.parsed;
    if (!p || typeof p !== "object") continue;
    // Token transfers only: a SOL transfer (the system program's "transfer")
    // moves no dollars and is nothing to do with this.
    if (ix?.program !== "spl-token" && ix?.programId !== TOKEN_PROGRAM) continue;
    if (p.type !== "transferChecked" && p.type !== "transfer") continue;
    const info = p.info ?? {};
    const owner = terms.accounts.get(String(info.destination));
    if (!owner) return { ok: false, why: "that payment sends money somewhere other than this artist" };
    // The payee's account is worked out from the USDC mint, so nothing else
    // can be in it; a transfer that names another mint is refused all the same.
    if (info.mint && info.mint !== terms.mint) return { ok: false, why: "that payment isn't in USDC" };
    const from = String(info.authority || info.multisigAuthority || "");
    if (!from) return { ok: false, why: "that payment doesn't say who sent it" };
    if (payer !== null && from !== payer) return { ok: false, why: "that payment comes from more than one wallet" };
    payer = from;
    const amount = Number(info.tokenAmount?.amount ?? info.amount ?? 0);
    if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false, why: "that payment's amount doesn't make sense" };
    micros += amount;
  }
  if (!payer || micros <= 0) return { ok: false, why: "that transaction doesn't pay this artist" };
  if ([...terms.accounts.values()].includes(payer)) return { ok: false, why: "that's the artist's own money moving, not a listener paying" };
  const signer = keys.find((k) => k.pubkey === payer);
  if (signer && signer.signer === false) return { ok: false, why: "the wallet it's from didn't sign it" };
  if (!Number.isSafeInteger(micros)) return { ok: false, why: "that payment's amount doesn't make sense" };
  return { ok: true, payer, micros, when: blockMs };
}

/**
 * Whose wallet is behind a token account?
 *
 * A transfer names token accounts, not people. The owner is in the balances
 * the chain reports alongside the transaction, which is the reliable place to
 * look: it does not depend on how the instruction was encoded.
 */
function destinationOf(tx: any, tokenAccount: string): { owner: string; mint: string } | null {
  const keys: string[] = (tx.transaction?.message?.accountKeys ?? []).map((k: any) =>
    typeof k === "string" ? k : k.pubkey);
  const index = keys.indexOf(tokenAccount);
  if (index < 0) return null;

  for (const b of tx.meta?.postTokenBalances ?? []) {
    if (b.accountIndex === index) return b.owner && b.mint ? { owner: b.owner, mint: b.mint } : null;
  }
  return null;
}
