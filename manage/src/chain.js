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
import { SOLANA, TOKEN_PROGRAM, ATA_PROGRAM } from "../../spec/chains.mjs";

export const NETWORKS = {
  devnet: { label: "Test network", ...SOLANA.devnet, real: false },
  // PublicNode (spec/chains.mjs) accepts browsers, but refuses
  // getTokenAccountsByOwner ("indexed requests require a personal token"),
  // which is why paymentsTo below finds the artist's dollar account inside
  // each transaction instead.
  mainnet: { label: "Solana", ...SOLANA.mainnet, real: true },
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
 * Who has paid this artist, and how much: everything newer than `until`.
 *
 * Returns micros per payer wallet, so it can sit beside the listening totals
 * the node keeps. Both are keyed by the same wallet, which is the whole reason
 * the wallet is the identity: nobody has to report anything for these to line
 * up.
 *
 * All of it, page by page, not the latest few hundred: an artist paid every
 * few songs passes that in a week, and anything older would vanish, leaving
 * fans who paid looking as though they hadn't. The editor keeps what it has
 * read (usePayments) and asks only for what's newer each time.
 *
 * Only listening counts as paying for listening. A purchase or a tip carries
 * a note (amply:buy:…, amply:tip:…), and a listener sending their own money
 * out pays the artist a small fee in a transfer that also pays someone who
 * isn't a payee. Those are counted apart, as `other`.
 *
 * At most `most` transactions are read in one look, oldest first, so a
 * wallet sent thousands of junk "dust" transfers doesn't keep Earnings busy
 * for minutes: `newest` is then the newest one read, `more` is true, and the
 * next look carries on from there. (Before reading one, nothing says whether
 * it pays a payee in USDC — a signature's listing has no amounts — so junk
 * can't be skipped earlier without risking skipping a real payment.)
 */
export async function paymentsTo(address, networkName = "devnet", { until, payees = [address], mint, pageSize = 1000, most = MOST_IN_ONE_LOOK } = {}) {
  const net = NETWORKS[networkName];
  if (!net) throw new Error("No such network.");
  const none = { byWallet: {}, total: 0, count: 0, newest: until || null };
  if (!address) return none;
  // `mint` is only ever passed by the proof script, which pays itself in a
  // token it minted for the purpose. Artists are paid in USDC.
  const token = mint || net.usdc;
  const owners = new Set(payees.length ? payees : [address]);

  // Every Amply payment names the artist's own wallet — it opens their dollar
  // account if it doesn't exist yet, idempotently, in the same transaction —
  // so asking for the transactions that touch the wallet finds them all,
  // without first looking up which account holds the dollars. That lookup is
  // exactly what free servers refuse to answer from a browser. Finalized only,
  // so nothing kept here can later turn out not to have happened.
  const found = [];
  for (let before; ;) {
    const page = await rpc(net.rpc, "getSignaturesForAddress",
      [address, { limit: pageSize, commitment: "finalized", ...(before ? { before } : {}), ...(until ? { until } : {}) }]);
    found.push(...(page || []));
    if (!page || page.length < pageSize) break;
    before = page[page.length - 1].signature;
    await wait(150);
  }
  const newestSeen = found[0]?.signature || until || null;
  const succeeded = found.filter((s) => !s.err).map((s) => s.signature);   // newest first
  if (!succeeded.length) return { ...none, newest: newestSeen };
  const more = succeeded.length > most;
  const wanted = more ? succeeded.slice(-most) : succeeded;
  const newest = more ? wanted[0] : newestSeen;

  const byWallet = {};
  let total = 0;
  let count = 0;

  // Ten at a time: the free endpoint counts every question in a batch
  // separately, and twenty is enough to be told to slow down.
  for (let i = 0; i < wanted.length; i += 10) {
    if (i) await wait(120);
    const chunk = wanted.slice(i, i + 10).map((signature) => ({
      method: "getTransaction",
      params: [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "finalized" }],
    }));

    for (const tx of await rpcBatch(net.rpc, chunk)) {
      if (!tx || tx.meta?.err) continue;

      const keys = tx.transaction?.message?.accountKeys ?? [];
      const keyAt = (i) => (typeof keys[i] === "string" ? keys[i] : keys[i]?.pubkey);
      const balances = [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])];
      const ownerOf = new Map(balances.map((b) => [keyAt(b.accountIndex), b.owner]));
      const mine = new Set(balances.filter((b) => b.owner === address && b.mint === token).map((b) => keyAt(b.accountIndex)).filter(Boolean));
      if (!mine.size) continue;   // touched the wallet, but not with dollars

      const instructions = [
        ...(tx.transaction?.message?.instructions ?? []),
        ...(tx.meta?.innerInstructions ?? []).flatMap((x) => x.instructions ?? []),
      ];
      const transfers = instructions.map((ix) => ix?.parsed).filter((p) => p && (p.type === "transferChecked" || p.type === "transfer"));
      const memo = instructions.find((ix) => ix?.program === "spl-memo" && typeof ix.parsed === "string")?.parsed || "";
      // What kind of payment: a note says purchase or tip; a transfer to
      // anyone who isn't a payee makes it someone sending money out.
      const outward = transfers.some((p) => !owners.has(ownerOf.get(p.info?.destination)));
      const listening = !memo && !outward;

      for (const p of transfers) {
        const info = p.info ?? {};
        if (!mine.has(info.destination)) continue;
        if (info.mint && info.mint !== token) continue;

        const micros = Number(info.tokenAmount?.amount ?? info.amount ?? 0);
        if (!Number.isFinite(micros) || micros <= 0) continue;

        // The authority on the transfer is the wallet that paid, which is the
        // same wallet the node saw listening.
        const payer = info.authority || info.multisigAuthority || "unknown";
        byWallet[payer] = addPaid(byWallet[payer], { micros: listening ? micros : 0, other: listening ? 0 : micros,
          payments: listening ? 1 : 0, last: (tx.blockTime || 0) * 1000 });
        total += micros;
        count += 1;
      }
    }
  }

  return { byWallet, total, count, checked: wanted.length, newest, more };
}

/** How many transactions one look reads per address (paymentsTo). */
export const MOST_IN_ONE_LOOK = 5_000;

/** One wallet's payments, added to another's. */
export function addPaid(a, b) {
  const x = a || { micros: 0, other: 0, payments: 0, last: 0 };
  return {
    micros: x.micros + (b.micros || 0),
    other: (x.other || 0) + (b.other || 0),
    payments: x.payments + (b.payments || 0),
    last: Math.max(x.last || 0, b.last || 0),
  };
}

/** What was read before, and what's new since: one record. */
export function mergePayments(kept, fresh) {
  const byWallet = { ...(kept?.byWallet || {}) };
  for (const [w, p] of Object.entries(fresh.byWallet || {})) byWallet[w] = addPaid(byWallet[w], p);
  return { byWallet, total: (kept?.total || 0) + (fresh.total || 0), newest: fresh.newest || kept?.newest || null };
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

/**
 * How many dollars (USDC) a wallet holds right now, or null if unknown.
 *
 * Its dollar account is worked out from the address and read directly: free
 * endpoints refuse to search for a wallet's token accounts from a browser
 * ("indexed requests require a personal token"). No account yet is $0.
 */
export async function usdcBalance(address, networkName = "mainnet") {
  const net = NETWORKS[networkName];
  if (!net || !address) return null;
  const { tokenAccountOf } = await import("../../node/src/solana-tx.ts");
  const account = await tokenAccountOf(address, net.usdc, TOKEN_PROGRAM, ATA_PROGRAM);
  const r = await rpc(net.rpc, "getAccountInfo", [account, { encoding: "jsonParsed", commitment: "confirmed" }]);
  return Number(r?.value?.data?.parsed?.info?.tokenAmount?.amount || 0);
}
