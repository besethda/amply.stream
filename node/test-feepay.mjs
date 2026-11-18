/**
 * What the node will and won't sign as a listener's fee payer.
 *
 * Transactions are built with Solana's own library, the way the app builds
 * them, then bent in every way that would make the fee wallet pay for, or
 * sign for, something other than the artist's own payment. Each must be
 * refused.
 *
 *   npm run test:feepay
 */
import { createRequire } from "node:module";
import { checkFeePayment, TOKEN_PROGRAM, ATA_PROGRAM } from "./src/feepay.ts";
import { readTransaction } from "./src/solana-tx.ts";
import { shareOut } from "../spec/pricing.mjs";

import { resolve } from "node:path";
import { createPrivateKey, sign } from "node:crypto";

// Solana's libraries come from the app, which already depends on them.
const require = createRequire(resolve("app/package.json"));
const web3 = require("@solana/web3.js");
const spl = require("@solana/spl-token");
/** An Ed25519 signature by `pair`, made without Solana's library. */
const signBy = (pair, message) => {
  const b64 = (b) => Buffer.from(b).toString("base64url");
  const key = createPrivateKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", d: b64(pair.secretKey.slice(0, 32)), x: b64(pair.publicKey.toBytes()) } });
  return sign(null, message, key);
};

const { Keypair, Transaction, PublicKey, SystemProgram, ComputeBudgetProgram, TransactionInstruction } = web3;

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

const fee = Keypair.generate(), listener = Keypair.generate();
const artist = Keypair.generate(), friend = Keypair.generate(), thief = Keypair.generate();
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const FAKE = Keypair.generate().publicKey;
const blockhash = Keypair.generate().publicKey.toBase58();

const expect = {
  feePayer: fee.publicKey.toBase58(),
  mint: USDC.toBase58(),
  payees: [{ address: artist.publicKey.toBase58(), split: 70 }, { address: friend.publicKey.toBase58(), split: 30 }],
  minMicros: 10_000,
  maxMicros: 2_000_000,
};

const ata = (owner, mint = USDC) => spl.getAssociatedTokenAddressSync(mint, owner, true);
const create = (owner, { payer = fee.publicKey, mint = USDC } = {}) =>
  spl.createAssociatedTokenAccountIdempotentInstruction(payer, ata(owner, mint), owner, mint);
const send = (owner, micros, { from = listener.publicKey, mint = USDC, decimals = 6, to } = {}) =>
  spl.createTransferCheckedInstruction(ata(from, mint), mint, to ?? ata(owner, mint), from, micros, decimals);

/** The payment the app writes: create-if-missing then pay, for each payee. */
const honest = (total = 100_000) => {
  const a = Math.floor(total * 0.7), f = total - a;
  return [create(artist.publicKey), send(artist.publicKey, a), create(friend.publicKey), send(friend.publicKey, f)];
};

async function verdict(instructions, { feePayer = fee.publicKey, signers = [listener], tamper, exp = expect } = {}) {
  const t = new Transaction({ feePayer, recentBlockhash: blockhash });
  t.add(...instructions);
  t.partialSign(...signers);
  let bytes = new Uint8Array(t.serialize({ requireAllSignatures: false, verifySignatures: false }));
  if (tamper) bytes = tamper(bytes);
  return checkFeePayment(readTransaction(bytes), exp);
}
const accepts = async (name, ixs, opts) => {
  const v = await verdict(ixs, opts);
  ok(name, v.ok, v.problem);
  return v;
};
const refuses = async (name, ixs, opts, pattern) => {
  let v;
  try { v = await verdict(ixs, opts); } catch (e) { v = { ok: false, problem: `unreadable: ${e.message}` }; }
  ok(name, !v.ok && (!pattern || pattern.test(v.problem)), v.ok ? "was accepted" : v.problem);
};

// ── what it signs ───────────────────────────────────────────────────────────
{
  const v = await accepts("the app's payment to an artist and a collaborator is accepted", honest());
  ok("  for the right total", v.micros === 100_000);
  ok("  split as the artist set it", v.shares[0].micros === 70_000 && v.shares[1].micros === 30_000);
  ok("  and it says who paid", v.listener === listener.publicKey.toBase58());

  const solo = { ...expect, payees: [{ address: artist.publicKey.toBase58(), split: 100 }] };
  await accepts("a payment to one artist is accepted", [create(artist.publicKey), send(artist.publicKey, 50_000)], { exp: solo });

  // Three ways, at splits that don't divide evenly: the leftover micro goes
  // where the app's shareOut puts it, and nowhere else.
  const three = [artist, friend, thief].map((k, i) => ({ key: k, address: k.publicKey.toBase58(), split: [33.34, 33.34, 33.32][i] }));
  const exp3 = { ...expect, payees: three.map(({ address, split }) => ({ address, split })) };
  const parts = shareOut(10_001, three);
  ok("  (the split really is uneven)", new Set(parts.map((p) => p.micros)).size > 1 && parts.reduce((a, p) => a + p.micros, 0) === 10_001);
  await accepts("an uneven split, rounded exactly as the app rounds it, is accepted",
    parts.flatMap((p) => [create(p.key.publicKey), send(p.key.publicKey, p.micros)]), { exp: exp3 });
  const nudged = parts.map((p, i) => ({ ...p, micros: p.micros + (i === 0 ? 1 : i === 1 ? -1 : 0) }));
  await refuses("  and rounded any other way, refused",
    nudged.flatMap((p) => [create(p.key.publicKey), send(p.key.publicKey, p.micros)]), { exp: exp3 }, /split/);

  await accepts("the smallest payment allowed is accepted", honest(10_000));
  await accepts("and the largest", honest(2_000_000));
}

// ── taking the fee wallet's money ───────────────────────────────────────────
await refuses("sending the fee wallet's SOL elsewhere is refused",
  [...honest(), SystemProgram.transfer({ fromPubkey: fee.publicKey, toPubkey: thief.publicKey, lamports: 1e9 })], {}, /doesn't need/);
await refuses("spending the fee wallet's own USDC is refused",
  [create(artist.publicKey), send(artist.publicKey, 70_000, { from: fee.publicKey }), create(friend.publicKey), send(friend.publicKey, 30_000)], {}, /listener must sign/);
await refuses("making the fee wallet a delegate or approving anything is refused",
  [...honest(), spl.createApproveInstruction(ata(fee.publicKey), thief.publicKey, fee.publicKey, 1)], {}, /only checked USDC/);
await refuses("closing an account into the thief's is refused",
  [...honest(), spl.createCloseAccountInstruction(ata(listener.publicKey), thief.publicKey, listener.publicKey)], {}, /only checked USDC/);
await refuses("changing an account's owner is refused",
  [...honest(), spl.createSetAuthorityInstruction(ata(listener.publicKey), listener.publicKey, 2, thief.publicKey)], {}, /only checked USDC/);
await refuses("a priority fee on the artist's SOL is refused",
  [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1e9 }), ...honest()], {}, /doesn't need/);
await refuses("asking for more compute is refused",
  [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...honest()], {}, /doesn't need/);
await refuses("any other program is refused",
  [...honest(), new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.from([]) })], {}, /doesn't need/);
await refuses("a memo is refused (listening payments don't carry one)",
  [...honest(), new TransactionInstruction({ programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), keys: [], data: Buffer.from("hi") })], {}, /doesn't need/);
await refuses("the fee wallet slipped into a transfer as an extra signer is refused", [
  create(artist.publicKey),
  new TransactionInstruction({ programId: new PublicKey(TOKEN_PROGRAM), data: send(artist.publicKey, 70_000).data,
    keys: [...send(artist.publicKey, 70_000).keys, { pubkey: fee.publicKey, isSigner: true, isWritable: false }] }),
  create(friend.publicKey), send(friend.publicKey, 30_000),
], {}, /four accounts/);

// ── paying for accounts nobody asked for ────────────────────────────────────
await refuses("creating an account for someone who isn't a payee is refused",
  [...honest(), create(thief.publicKey)], {}, /isn't paid/);
await refuses("creating a payee's account without paying them is refused",
  [create(artist.publicKey), send(artist.publicKey, 100_000), create(friend.publicKey)], { exp: { ...expect, payees: [{ address: artist.publicKey.toBase58(), split: 100 }, expect.payees[1]] } }, /isn't paid|without being paid|isn't a payee/);
await refuses("creating a payee's account twice is refused",
  [create(artist.publicKey), ...honest()], {}, /twice/);
await refuses("the non-idempotent create is refused", [
  spl.createAssociatedTokenAccountInstruction(fee.publicKey, ata(artist.publicKey), artist.publicKey, USDC),
  send(artist.publicKey, 70_000), create(friend.publicKey), send(friend.publicKey, 30_000),
], {}, /only creating/);
await refuses("a payee account in another token is refused",
  [create(artist.publicKey, { mint: FAKE }), send(artist.publicKey, 70_000), create(friend.publicKey), send(friend.publicKey, 30_000)], {}, /isn't USDC|isn't a payee/);

// ── paying the wrong people, or the wrong amounts ───────────────────────────
await refuses("paying the thief's account is refused",
  [create(artist.publicKey), send(artist.publicKey, 70_000, { to: ata(thief.publicKey) }), create(friend.publicKey), send(friend.publicKey, 30_000)], {}, /isn't a payee/);
await refuses("creating a payee's account after paying them is refused",
  [send(artist.publicKey, 70_000), create(artist.publicKey), create(friend.publicKey), send(friend.publicKey, 30_000)], {}, /created after/);
await refuses("a different split is refused", honest(100_000).map((ix, i) =>
  i === 1 ? send(artist.publicKey, 80_000) : i === 3 ? send(friend.publicKey, 20_000) : ix), {}, /split/);
await refuses("leaving out a collaborator is refused",
  [create(artist.publicKey), send(artist.publicKey, 100_000)], {}, /split/);
await refuses("paying a payee twice is refused",
  [...honest(), send(artist.publicKey, 1)], {}, /paid twice/);
await refuses("a fake token is refused",
  [create(artist.publicKey), send(artist.publicKey, 70_000, { mint: FAKE, to: ata(artist.publicKey) }), create(friend.publicKey), send(friend.publicKey, 30_000)], {}, /isn't USDC/);
await refuses("the wrong decimals are refused",
  honest().map((ix, i) => (i === 1 ? send(artist.publicKey, 70_000, { decimals: 9 }) : ix)), {}, /isn't USDC/);
await refuses("the unchecked transfer is refused", [
  create(artist.publicKey), spl.createTransferInstruction(ata(listener.publicKey), ata(artist.publicKey), listener.publicKey, 70_000),
  create(friend.publicKey), send(friend.publicKey, 30_000),
], {}, /only checked USDC/);
await refuses("a payment too small to be worth its fee is refused", honest(9_999), {}, /too small/);
await refuses("a payment over the limit is refused", honest(2_000_001), {}, /more than/);

// ── who signs ───────────────────────────────────────────────────────────────
await refuses("someone else as fee payer is refused", honest(), { feePayer: listener.publicKey }, /fee payer|two signers/);
await refuses("a third signer is refused",
  [...honest(), SystemProgram.transfer({ fromPubkey: thief.publicKey, toPubkey: thief.publicKey, lamports: 1 })], { signers: [listener, thief] }, /two signers/);
await refuses("a fee wallet signature already filled in is refused", honest(), {
  tamper: (b) => { b.fill(7, 1, 65); return b; },
}, /already there/);
await refuses("a listener signature that doesn't match is refused", honest(), {
  tamper: (b) => { b[1 + 64 + 10] ^= 1; return b; },   // one bit of the listener's signature
}, /signature|split/);
await refuses("a signature by someone else in the listener's place is refused", honest(), {
  tamper: (b) => { const t = Transaction.from(b); t.signatures[1].signature = signBy(thief, t.serializeMessage()); return new Uint8Array(t.serialize({ requireAllSignatures: false, verifySignatures: false })); },
}, /signature/);
await refuses("an artist can't pay themselves through their own node", [
  create(friend.publicKey), send(friend.publicKey, 30_000, { from: artist.publicKey }),
], { signers: [artist], exp: { ...expect, payees: [expect.payees[0], expect.payees[1]] } }, /themselves/);
await refuses("a fee wallet that's also a payee is refused", honest(), {
  exp: { ...expect, payees: [...expect.payees, { address: fee.publicKey.toBase58(), split: 0 }] },
}, /fee wallet/);
await refuses("an artist with no wallet is refused", honest(), { exp: { ...expect, payees: [] } }, /no wallet/);

// ── purchases carry exactly the note the node expects ──────────────────────
{
  const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
  const note = (text, signer = listener.publicKey) => new TransactionInstruction({
    programId: MEMO, keys: signer ? [{ pubkey: signer, isSigner: true, isWritable: false }] : [], data: Buffer.from(text, "utf8"),
  });
  const buy = { ...expect, memo: "amply:buy:a.example:tides", minMicros: 8_000_000, maxMicros: 8_000_000 };
  await accepts("a purchase with its note is accepted", [...honest(8_000_000), note(buy.memo)], { exp: buy });
  await refuses("  without it, refused", honest(8_000_000), { exp: buy }, /say what it bought/);
  await refuses("  with a different note, refused", [...honest(8_000_000), note("amply:buy:a.example:other")], { exp: buy }, /doesn't say/);
  await refuses("  with two notes, refused", [...honest(8_000_000), note(buy.memo), note(buy.memo)], { exp: buy }, /one note/);
  await refuses("  with the fee wallet signing the note, refused", [...honest(8_000_000), note(buy.memo, fee.publicKey)], { exp: buy }, /only the listener/);
  await refuses("  for less than the price, refused", [...honest(7_999_999), note(buy.memo)], { exp: buy }, /too small/);
}

// ── a listener sending their own money out, the artist paying the fee ──────
{
  const dest = Keypair.generate().publicKey;
  const w = { ...expect, payees: [{ address: dest.toBase58() }, { address: artist.publicKey.toBase58() }], minMicros: 10_000, maxMicros: 10_000_000_000, withdrawal: { fee: 50_000 } };
  const out = (toDest, toArtist, extra = []) => [create(dest), send(dest, toDest), create(artist.publicKey), send(artist.publicKey, toArtist), ...extra];
  const v = await accepts("a withdrawal with the fee to the artist is accepted", out(4_000_000, 50_000), { exp: w });
  ok("  and says what went where", v.shares?.[0].micros === 4_000_000 && v.shares?.[1].micros === 50_000);
  await refuses("  without enough fee, refused", out(4_000_000, 49_999), { exp: w }, /fee for sending/);
  await refuses("  with nothing for the artist, refused", [create(dest), send(dest, 4_000_000)], { exp: w }, /destination and the fee/);
  await refuses("  paying a third person too, refused", out(4_000_000, 50_000, [create(thief.publicKey), send(thief.publicKey, 1)]), { exp: w }, /isn't paid/);
  await refuses("  to anyone but the stated destination, refused",
    [create(thief.publicKey), send(thief.publicKey, 4_000_000), create(artist.publicKey), send(artist.publicKey, 50_000)], { exp: w }, /isn't paid/);
  await refuses("  with the fee wallet's own money, refused",
    [create(dest), send(dest, 4_000_000, { from: fee.publicKey }), create(artist.publicKey), send(artist.publicKey, 50_000)], { exp: w }, /listener must sign/);
  await refuses("  sending SOL from the fee wallet on the side, refused",
    out(4_000_000, 50_000, [SystemProgram.transfer({ fromPubkey: fee.publicKey, toPubkey: thief.publicKey, lamports: 1e9 })]), { exp: w }, /doesn't need/);
}

// ── paying into accounts that exist, and opening only what's allowed (A3) ──
{
  // A payee's account that's already open is simply paid into: nothing for
  // the fee wallet to pay rent on.
  await accepts("paying into payees' existing USDC accounts, opening nothing, is accepted",
    [send(artist.publicKey, 70_000), send(friend.publicKey, 30_000)]);
  await accepts("  or opening one and paying into the other's",
    [create(artist.publicKey), send(artist.publicKey, 70_000), send(friend.publicKey, 30_000)]);
  await refuses("a payee's account that isn't their own USDC account is refused", [
    create(artist.publicKey), send(artist.publicKey, 70_000),
    new TransactionInstruction({ programId: new PublicKey(ATA_PROGRAM), data: create(friend.publicKey).data,
      keys: create(friend.publicKey).keys.map((k, i) => (i === 1 ? { ...k, pubkey: ata(thief.publicKey) } : k)) }),
    send(friend.publicKey, 30_000),
  ], {}, /own USDC account/);

  // A withdrawal: the destination's account may be opened only when the
  // listener paid the node's new-account fee for it (`mayOpen`). Otherwise
  // it could be closed between the node's look and the send, and the fee
  // wallet would pay its rent each time.
  const dest = Keypair.generate().publicKey;
  const base = { ...expect, payees: [{ address: dest.toBase58() }, { address: artist.publicKey.toBase58() }], minMicros: 10_000, maxMicros: 10_000_000_000, withdrawal: { fee: 50_000 } };
  const existing = { ...base, mayOpen: [artist.publicKey.toBase58()] };
  await accepts("a withdrawal to an existing account, without opening it, is accepted",
    [send(dest, 4_000_000), create(artist.publicKey), send(artist.publicKey, 50_000)], { exp: existing });
  await refuses("  but one that also opens it, unpaid for, is refused",
    [create(dest), send(dest, 4_000_000), create(artist.publicKey), send(artist.publicKey, 50_000)], { exp: existing }, /can't be opened/);
  const opening = { ...base, withdrawal: { fee: 550_000 }, mayOpen: [dest.toBase58(), artist.publicKey.toBase58()] };
  await accepts("  and with the new-account fee paid, opening it is accepted",
    [create(dest), send(dest, 4_000_000), create(artist.publicKey), send(artist.publicKey, 550_000)], { exp: opening });
}

// ── a few facts the rules rest on ──────────────────────────────────────────
ok("the programs are Solana's own", spl.TOKEN_PROGRAM_ID.toBase58() === TOKEN_PROGRAM && spl.ASSOCIATED_TOKEN_PROGRAM_ID.toBase58() === ATA_PROGRAM);
ok("the app's create-if-missing is the idempotent kind", create(artist.publicKey).data.length === 1 && create(artist.publicKey).data[0] === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
