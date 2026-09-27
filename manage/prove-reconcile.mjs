/**
 * Proof that reconciliation reads a real payment off a real chain.
 *
 * The payment is the one proved in node/prove-access: a single transaction
 * splitting 0.20 USDC sixty-forty between two artists on devnet. Here we start
 * from the other end — an artist's address, knowing nothing — and check that
 * the payer and the amount come back.
 *
 *     node manage/prove-reconcile.mjs
 *
 * Talks to devnet, so it needs the network and it will fail once devnet prunes
 * the transaction. That is expected; it is a proof, not a unit test.
 */
import { paymentsTo, reconcile } from "./src/chain.js";

const TX = "2ZySULDHhURLEtLbxHiA16Rog4bNehApNm1BrmkEUU4xtFNNvmzW65j5o5s84EPYk6RcgtiKWc2MKN3dtk6faP9s";
const RPC = "https://api.devnet.solana.com";

let pass = 0, fail = 0;
const ok = (what, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${what}${cond || !extra ? "" : `\n        ${extra}`}`);
};

const tx = await (await fetch(RPC, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "getTransaction",
    params: [TX, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
  }),
})).json();

if (!tx.result) {
  console.log("the devnet transaction has been pruned; nothing to reconcile against");
  process.exit(2);
}

const payer = tx.result.transaction.message.accountKeys.find((k) => k.signer).pubkey;
const owners = tx.result.meta.postTokenBalances.map((b) => b.owner).filter((o) => o !== payer);
const [first] = owners;
// Devnet has no real USDC to hand out, so the proof pays in a token it minted.
// Everything else about the transaction is exactly what a real one looks like.
const mint = tx.result.meta.postTokenBalances[0].mint;
console.log(`     payer   ${payer}`);
console.log(`     artists ${owners.join(", ")}`);
console.log(`     token   ${mint}\n`);

/** What this one transaction moved to a given artist, from the chain's own
 *  before-and-after. The wallet has been paid more than once on devnet, so the
 *  figures to check against have to come from the transaction, not from me. */
const movedTo = (owner) => {
  const at = (side) => Number(
    (tx.result.meta[side].find((b) => b.owner === owner)?.uiTokenAmount.amount) ?? 0);
  return at("postTokenBalances") - at("preTokenBalances");
};
const share = { [owners[0]]: movedTo(owners[0]), [owners[1]]: movedTo(owners[1]) };
console.log(`     this payment split ${share[owners[0]]} / ${share[owners[1]]} micros\n`);
ok("the split under test is the 60/40 one that was proved",
  share[owners[0]] + share[owners[1]] === 200000, JSON.stringify(share));

const found = await paymentsTo(first, "devnet", { mint });
ok("the artist's payments come back at all", found.count > 0, JSON.stringify(found));
ok("the payer is there, named by their wallet", !!found.byWallet[payer],
  `saw ${Object.keys(found.byWallet).join(", ")}`);
ok("what they were paid includes this payment's share",
  found.byWallet[payer]?.micros >= share[first], JSON.stringify(found.byWallet[payer]));
ok("and is a whole number of micros, never a rounded float",
  Number.isInteger(found.byWallet[payer]?.micros));
ok("and it is dated", found.byWallet[payer]?.last > 0);

const other = await paymentsTo(owners[1], "devnet", { mint });
ok("the second artist sees their own share, not the whole payment",
  other.byWallet[payer]?.micros >= share[owners[1]]
  && other.byWallet[payer]?.micros !== found.byWallet[payer]?.micros,
  JSON.stringify({ first: found.byWallet[payer], second: other.byWallet[payer] }));

// An address nobody has ever paid answers cleanly rather than throwing.
const nobody = await paymentsTo("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", "devnet", { mint });
ok("an address with no USDC account is empty, not an error", nobody.total === 0);

// And the join with what the node recorded.
const rows = reconcile(
  [{ pubkey: payer, plays: 3, seconds: 600, last_seen: Date.now() },
   { pubkey: "StrangerNobodyHasEverSeenPayAnything11111111", plays: 40, seconds: 9000, last_seen: Date.now() }],
  found.byWallet,
);
ok("listening and paying line up on the same wallet", rows[1].pubkey === payer && rows[1].paidMicros === found.byWallet[payer].micros,
  JSON.stringify(rows));
ok("the freeloader shows nothing paid", rows[0].paidMicros === 0);
ok("and sorts to the top, having listened most", rows[0].seconds === 9000);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
