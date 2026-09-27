/**
 * Getting money into the wallet, and back out of it.
 *
 * The top-up link has to name exactly the right coin — a wrong mint is money
 * sent somewhere it can't be spent — and sending back has to refuse an address
 * that isn't one before anything is signed.
 *
 * Run via `npm --prefix app run test`.
 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { transferRequest, DOLLAR_AMOUNTS, FEE_SOL, oneTapReady } = await import("./src/topup.js");
const { NETWORKS } = await import("./src/networks.js");
const pay = await import("./src/pay.js");
const { Keypair } = await import("@solana/web3.js");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

const ADDRESS = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const USDC = NETWORKS.mainnet.usdc;

// ── the one-tap link ────────────────────────────────────────────────────────

{
  const link = transferRequest(ADDRESS, 5, { mint: USDC });
  const url = new URL(link);
  ok("it is a Solana Pay link", link.startsWith(`solana:${ADDRESS}?`), link);
  ok("  for the amount asked", url.searchParams.get("amount") === "5");
  ok("  in USDC on Solana, named by its exact mint", url.searchParams.get("spl-token") === USDC);
  ok("  and it says who is asking", url.searchParams.get("label") === "Amply");
}

{
  const url = new URL(transferRequest(ADDRESS, FEE_SOL));
  ok("the fee link asks for SOL itself, so names no token", url.searchParams.get("spl-token") === null);
  ok("  a small amount of it", Number(url.searchParams.get("amount")) === FEE_SOL && FEE_SOL <= 0.05);
}

ok("the dollar amounts on offer are modest", DOLLAR_AMOUNTS.every((n) => n > 0 && n <= 20));

{
  const url = new URL(transferRequest(ADDRESS, 5, { mint: USDC, message: "Top up & go" }));
  ok("a message with awkward characters survives the link", url.searchParams.get("message") === "Top up & go");
}

{
  const link = transferRequest(ADDRESS, 5, { mint: USDC });
  ok("spaces are percent-encoded, as the spec's own examples are", link.includes("Top%20up%20your%20Amply%20wallet"), link);
  ok("  never written as a plus sign", !link.includes("+"), link);
}

// ── when one tap can work at all ────────────────────────────────────────────
//
// Wallets follow the Solana Pay reference code, which refuses to pay a wallet
// that doesn't exist on the network yet ("recipient not found") or, for USDC,
// one with no dollar account ("recipient not initialized"). Phantom shows that
// as "invalid link" — which is what happened on the first real test.

ok("a brand-new wallet is not ready for one tap", !oneTapReady({ sol: 0, usdc: 0, exists: false, dollarAccount: false }));
ok("  nor one with SOL but no dollar account yet", !oneTapReady({ sol: 0.01, usdc: 0, exists: true, dollarAccount: false }));
ok("  nor one with a dollar account that doesn't exist on the network", !oneTapReady({ sol: 0, usdc: 5, exists: false, dollarAccount: true }));
ok("once it has both, one tap works", oneTapReady({ sol: 0.01, usdc: 5, exists: true, dollarAccount: true }));
ok("  even with the dollars spent — the account stays", oneTapReady({ sol: 0.01, usdc: 0, exists: true, dollarAccount: true }));
ok("before the balance is known, it waits", !oneTapReady(null));

// ── sending it back ─────────────────────────────────────────────────────────

const pair = Keypair.generate();
const refuses = async (name, fn, pattern) => {
  try { await fn(); ok(name, false, "it did not refuse"); }
  catch (e) { ok(name, pattern.test(e.message), e.message); }
};

await refuses("sending to something that isn't an address is refused",
  () => pay.sendDollarsOut(pair, "not an address"), /isn't a Solana address/);
await refuses("so is sending to nothing at all",
  () => pay.sendDollarsOut(pair, ""), /isn't a Solana address/);
await refuses("and sending a wallet's money to itself",
  () => pay.sendDollarsOut(pair, pair.publicKey.toBase58()), /own address/);
await refuses("the SOL is refused the same way",
  () => pay.sendSolOut(pair, "0x1234"), /isn't a Solana address/);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
