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

export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

/** The note a purchase's payment carries: which artist, and what it bought. */
export const purchaseMemo = (host: string, item: string) => `amply:buy:${host}:${item}`;

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
