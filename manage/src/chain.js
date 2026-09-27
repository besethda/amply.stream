/**
 * Reading payments off the chain, from the artist's own browser.
 *
 * The node cannot do this: Solana's public RPC refuses a Cloudflare Worker
 * outright ("your IP or provider is blocked"), so reconciliation happens here,
 * in the editor, when the artist opens it. For real money even a browser is
 * refused by Solana's own server, so mainnet goes through PublicNode, which
 * accepts browsers without a key. Nothing for the artist to sign up for.
 *
 * No library either. The Solana packages are about 350kB, and the editor is
 * uploaded into the artist's own storage and served to one person, so it stays
 * small: this is two JSON-RPC calls and some parsing.
 */

export const NETWORKS = {
  devnet: {
    label: "Test network",
    rpc: "https://api.devnet.solana.com",
    usdc: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    real: false,
  },
  mainnet: {
    label: "Solana",
    // Not api.mainnet-beta.solana.com, which refuses every request carrying a
    // website's Origin — this editor's included. PublicNode accepts browsers,
    // free and without a key, but refuses getTokenAccountsByOwner ("indexed
    // requests require a personal token"), which is why paymentsTo below
    // finds the artist's dollar account inside each transaction instead.
    rpc: "https://solana-rpc.publicnode.com",
    usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    real: true,
  },
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One request, with patience.
 *
 * The public endpoint is free and rate-limits hard: a 429 is ordinary traffic
 * rather than a fault, and the only right answer is to wait a moment and ask
 * again. Three tries, doubling, then say so honestly.
 */
async function send(url, body) {
  let delay = 700;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    if (res.status === 429 && attempt < 3) {
      // Respect the endpoint's own figure when it offers one.
      const told = Number(res.headers.get("retry-after"));
      await wait(Number.isFinite(told) && told > 0 ? told * 1000 : delay);
      delay *= 2;
      continue;
    }
    throw new Error(res.status === 429
      ? "Solana's free endpoint is busy. Try again in a minute."
      : `The network answered with ${res.status}.`);
  }
}

async function rpc(url, method, params) {
  const body = await send(url, { jsonrpc: "2.0", id: 1, method, params });
  if (body.error) throw new Error(body.error.message || "The network refused the question.");
  return body.result;
}

/** Several questions in one request, which public endpoints allow and which
 *  keeps a few hundred payments to a handful of round trips. */
async function rpcBatch(url, calls) {
  if (!calls.length) return [];
  const body = await send(url,
    calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: c.method, params: c.params })));
  const out = [];
  for (const entry of Array.isArray(body) ? body : [body]) out[entry.id] = entry.result;
  return out;
}

/**
 * Who has paid this artist, and how much.
 *
 * Returns micros per payer wallet, so it can sit beside the listening totals
 * the node keeps. Both are keyed by the same wallet, which is the whole reason
 * the wallet is the identity: nobody has to report anything for these to line
 * up.
 */
export async function paymentsTo(address, networkName = "devnet", { limit = 200, mint } = {}) {
  const net = NETWORKS[networkName];
  if (!net) throw new Error("No such network.");
  if (!address) return { byWallet: {}, total: 0, count: 0 };
  // `mint` is only ever passed by the proof script, which pays itself in a
  // token it minted for the purpose. Artists are paid in USDC.
  const token = mint || net.usdc;

  // Every Amply payment names the artist's own wallet — it opens their dollar
  // account if it doesn't exist yet, idempotently, in the same transaction —
  // so asking for the transactions that touch the wallet finds them all,
  // without first looking up which account holds the dollars. That lookup is
  // exactly what free servers refuse to answer from a browser.
  const signatures = await rpc(net.rpc, "getSignaturesForAddress", [address, { limit }]);
  const wanted = (signatures || []).filter((s) => !s.err).map((s) => s.signature);
  if (!wanted.length) return { byWallet: {}, total: 0, count: 0 };

  const byWallet = {};
  let total = 0;
  let count = 0;

  // Ten at a time: the free endpoint counts every question in a batch
  // separately, and twenty is enough to be told to slow down.
  for (let i = 0; i < wanted.length; i += 10) {
    if (i) await wait(120);
    const chunk = wanted.slice(i, i + 10).map((signature) => ({
      method: "getTransaction",
      params: [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
    }));

    for (const tx of await rpcBatch(net.rpc, chunk)) {
      if (!tx || tx.meta?.err) continue;

      const keys = tx.transaction?.message?.accountKeys ?? [];
      const keyAt = (i) => (typeof keys[i] === "string" ? keys[i] : keys[i]?.pubkey);
      const mine = new Set(
        [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])]
          .filter((b) => b.owner === address && b.mint === token)
          .map((b) => keyAt(b.accountIndex))
          .filter(Boolean),
      );
      if (!mine.size) continue;   // touched the wallet, but not with dollars

      const instructions = [
        ...(tx.transaction?.message?.instructions ?? []),
        ...(tx.meta?.innerInstructions ?? []).flatMap((x) => x.instructions ?? []),
      ];

      for (const ix of instructions) {
        const p = ix?.parsed;
        if (!p || (p.type !== "transferChecked" && p.type !== "transfer")) continue;
        const info = p.info ?? {};
        if (!mine.has(info.destination)) continue;
        if (info.mint && info.mint !== token) continue;

        const micros = Number(info.tokenAmount?.amount ?? info.amount ?? 0);
        if (!Number.isFinite(micros) || micros <= 0) continue;

        // The authority on the transfer is the wallet that paid, which is the
        // same wallet the node saw listening.
        const payer = info.authority || info.multisigAuthority || "unknown";
        const had = byWallet[payer] || { micros: 0, payments: 0, last: 0 };
        byWallet[payer] = {
          micros: had.micros + micros,
          payments: had.payments + 1,
          last: Math.max(had.last, (tx.blockTime || 0) * 1000),
        };
        total += micros;
        count += 1;
      }
    }
  }

  return { byWallet, total, count, checked: wanted.length };
}

/**
 * Put listening and paying side by side.
 *
 * The node knows who listened and how much; the chain knows who paid. Neither
 * knows the other, and matching them is this one line of arithmetic, because
 * both are keyed by the same wallet.
 */
export function reconcile(listeners, byWallet) {
  return (listeners || []).map((l) => {
    const paid = byWallet[l.pubkey];
    return {
      ...l,
      paidMicros: paid?.micros || 0,
      payments: paid?.payments || 0,
      lastPaid: paid?.last || 0,
    };
  }).sort((a, b) => (b.seconds || 0) - (a.seconds || 0));
}
