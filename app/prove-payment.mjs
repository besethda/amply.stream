/**
 * Prove a payment, on a real network, with real transactions.
 *
 * Everything else about payments is asserted against arithmetic. This runs the
 * actual code against Solana's devnet: a wallet is made, a token is minted, and
 * a split payment is sent to two people who have never held that token before,
 * which is the case that needs an account opening for them. Then it reads the
 * chain back and checks the numbers landed exactly.
 *
 * Devnet is a real network with real machines and a rate-limited faucet, so
 * this is not part of `npm run check`. Run it deliberately:
 *
 *   node app/prove-payment.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo,
  getAssociatedTokenAddress, getAccount, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { rpc, useNetwork, network } = await import("./src/wallet.js");
const { payArtist, shareOut, toMicros, PaymentError } = await import("./src/pay.js");

// Either test cluster will do. devnet's faucet is often dry, so:
//   AMPLY_CLUSTER=testnet node app/prove-payment.mjs
useNetwork(process.env.AMPLY_CLUSTER === "testnet" ? "testnet" : "devnet");
const conn = rpc();

let failed = 0;
const step = (s) => console.log(`\n── ${s}`);
const ok = (name, cond, detail = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};
const explorer = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

step(`Network: ${network().label} (${network().rpc})`);
console.log(`     real money: ${network().real}`);

// ── a listener, with some test SOL ──────────────────────────────────────────

step("The listener's wallet");

// Kept between runs, in .build/ which is not committed. The faucets refuse
// some networks outright, and a fresh keypair every run would mean begging for
// test SOL every run. Funded once, this address works from then on.
const PURSE = new URL("../.build/proof-wallet.json", import.meta.url);
let listener;
try {
  listener = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(PURSE, "utf8"))));
  console.log(`     reusing ${listener.publicKey.toBase58()}`);
} catch {
  listener = Keypair.generate();
  mkdirSync(new URL("../.build/", import.meta.url), { recursive: true });
  writeFileSync(PURSE, JSON.stringify(Array.from(listener.secretKey)));
  console.log(`     new ${listener.publicKey.toBase58()}`);
}

// Already funded from a previous run, or by hand? Then skip the faucet.
let last = null;
const already = await conn.getBalance(listener.publicKey);
if (already > 0.02 * LAMPORTS_PER_SOL) {
  console.log(`     already holds ${(already / LAMPORTS_PER_SOL).toFixed(3)} SOL, no faucet needed`);
} else
// The faucet is rate limited by IP and frequently busy. Ask for less, and ask
// a few times, before giving up.
for (const sol of [0.5, 0.2, 0.1, 0.1]) {
  try {
    const sig = await conn.requestAirdrop(listener.publicKey, Math.floor(sol * LAMPORTS_PER_SOL));
    await conn.confirmTransaction(sig, "confirmed");
    last = null;
    break;
  } catch (e) {
    last = e;
    console.log(`     faucet said no to ${sol} SOL, waiting`);
    await new Promise((r) => setTimeout(r, 4000));
  }
}
if (last) {
  console.log(`\nThe devnet faucet refused every time: ${last.message}`);
  console.log("It is rate limited by IP. Nothing below could run, so nothing is proved.");
  console.log("Fund this address at https://faucet.solana.com (0.1 SOL is plenty) and run again:");
  console.log(`  ${listener.publicKey.toBase58()}`);
  process.exit(2);
}
const funded = await conn.getBalance(listener.publicKey);
ok("the faucet funded the wallet", funded > 0, `${funded} lamports`);

// ── a token standing in for USDC ────────────────────────────────────────────

step("Creating a six-decimal token to stand in for USDC, and minting $5 of it");
const mint = await createMint(conn, listener, listener.publicKey, null, 6, undefined, undefined, TOKEN_PROGRAM_ID);
const purse = await getOrCreateAssociatedTokenAccount(conn, listener, mint, listener.publicKey, false, "confirmed", undefined, TOKEN_PROGRAM_ID);
await mintTo(conn, listener, mint, purse.address, listener, 5_000_000, [], undefined, TOKEN_PROGRAM_ID);
const before = await getAccount(conn, purse.address, "confirmed", TOKEN_PROGRAM_ID);
ok("the listener holds $5", Number(before.amount) === 5_000_000, `${before.amount}`);

// ── two artists who have never been paid in this token ──────────────────────

step("Two collaborators, 60/40, neither of whom has an account for this token");
const artistA = Keypair.generate();
const artistB = Keypair.generate();
const recipients = [
  { name: "Hollow Coast", address: artistA.publicKey.toBase58(), split: 60 },
  { name: "Ada Vance", address: artistB.publicKey.toBase58(), split: 40 },
];
for (const [who, key] of [["A", artistA], ["B", artistB]]) {
  const ata = await getAssociatedTokenAddress(mint, key.publicKey, false, TOKEN_PROGRAM_ID);
  const exists = await conn.getAccountInfo(ata);
  ok(`artist ${who} starts with no account for it`, exists === null);
}

// ── the payment ─────────────────────────────────────────────────────────────

const owed = toMicros(0.2);        // five songs at a cent a minute
step(`Paying $${(owed / 1e6).toFixed(2)}, split 60/40, in one transaction`);
const expected = shareOut(owed, recipients);
for (const s of expected) console.log(`     ${s.name}: ${s.micros} micros`);

const result = await payArtist(listener, recipients, owed, { mint: mint.toBase58() });
console.log(`     ${explorer(result.signature)}`);

// ── read the chain back ─────────────────────────────────────────────────────

step("Reading the balances back off the chain");
const landed = [];
for (const [who, key, want] of [["Hollow Coast", artistA, 120000], ["Ada Vance", artistB, 80000]]) {
  const ata = await getAssociatedTokenAddress(mint, key.publicKey, false, TOKEN_PROGRAM_ID);
  const account = await getAccount(conn, ata, "confirmed", TOKEN_PROGRAM_ID);
  landed.push(Number(account.amount));
  ok(`${who} received exactly ${want} micros`, Number(account.amount) === want, `${account.amount}`);
}
ok("the two shares add up to what was owed", landed[0] + landed[1] === owed, `${landed[0] + landed[1]} vs ${owed}`);

const after = await getAccount(conn, purse.address, "confirmed", TOKEN_PROGRAM_ID);
ok("and the listener is down by exactly that much",
  Number(before.amount) - Number(after.amount) === owed,
  `${Number(before.amount) - Number(after.amount)}`);

// ── paying again, now that accounts exist ───────────────────────────────────

step("Paying the same pair a second time, when their accounts already exist");
const second = await payArtist(listener, recipients, toMicros(0.05), { mint: mint.toBase58() });
console.log(`     ${explorer(second.signature)}`);
const aAgain = await getAccount(conn, await getAssociatedTokenAddress(mint, artistA.publicKey, false, TOKEN_PROGRAM_ID), "confirmed", TOKEN_PROGRAM_ID);
ok("the second payment adds to the first", Number(aAgain.amount) === 120000 + 30000, `${aAgain.amount}`);

// ── what happens when there isn't enough ────────────────────────────────────

step("Asking for more than the listener holds");
try {
  await payArtist(listener, recipients, toMicros(1000), { mint: mint.toBase58() });
  ok("a payment beyond the balance is refused", false, "it went through");
} catch (e) {
  ok("a payment beyond the balance is refused", e instanceof PaymentError, `${e}`);
  ok("  and says nothing was sent", /nothing was sent/i.test(e.message), e.message);
}
const untouched = await getAccount(conn, purse.address, "confirmed", TOKEN_PROGRAM_ID);
ok("  and the money really did not move", Number(untouched.amount) === Number(after.amount) - 50000,
  `${untouched.amount}`);

console.log(failed ? `\n${failed} FAILED` : "\nAll of it checked out, on chain.");
process.exit(failed ? 1 : 0);
