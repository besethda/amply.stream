/**
 * The transaction reader, checked against Solana's own library: whatever
 * @solana/web3.js writes, the reader must read identically, and anything
 * malformed or outside what it understands must be refused.
 *
 *   node --experimental-strip-types node/test-solana-tx.mjs
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const web3 = require("../app/node_modules/@solana/web3.js");
const spl = require("../app/node_modules/@solana/spl-token");
const tx = await import("./src/solana-tx.ts");
const { readTransaction, writeTransaction, isSigner, isWritable, base58, unbase58, verifySignature, u64, TxError, shortBytes } = tx;

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};
const refuses = (name, bytes, pattern) => {
  try { readTransaction(bytes); ok(name, false, "was accepted"); }
  catch (e) { ok(name, e instanceof TxError && (!pattern || pattern.test(e.message)), e.message); }
};

const { Keypair, Transaction, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } = web3;
const fee = Keypair.generate(), listener = Keypair.generate(), artist = Keypair.generate(), friend = Keypair.generate();
const mint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const blockhash = base58(new Uint8Array(32).fill(9));

async function payment(shares = [[artist, 70_000], [friend, 30_000]]) {
  const t = new Transaction({ feePayer: fee.publicKey, recentBlockhash: blockhash });
  const from = await spl.getAssociatedTokenAddress(mint, listener.publicKey);
  for (const [who, micros] of shares) {
    const to = await spl.getAssociatedTokenAddress(mint, who.publicKey);
    t.add(spl.createAssociatedTokenAccountIdempotentInstruction(fee.publicKey, to, who.publicKey, mint));
    t.add(spl.createTransferCheckedInstruction(from, mint, to, listener.publicKey, micros, 6));
  }
  return t;
}

// ── reading what web3.js writes ─────────────────────────────────────────────
{
  const t = await payment();
  t.partialSign(listener);
  const bytes = t.serialize({ requireAllSignatures: false });
  const read = readTransaction(new Uint8Array(bytes));
  const msg = t.compileMessage();
  ok("a payment web3.js writes is read", !!read);
  ok("  the same accounts, in the same order", read.accounts.join() === msg.accountKeys.map((k) => k.toBase58()).join());
  ok("  the fee payer first", read.accounts[0] === fee.publicKey.toBase58());
  ok("  the same header", read.header.required === msg.header.numRequiredSignatures
    && read.header.readonlySigned === msg.header.numReadonlySignedAccounts
    && read.header.readonlyUnsigned === msg.header.numReadonlyUnsignedAccounts);
  ok("  the same blockhash", read.blockhash === blockhash);
  ok("  the same instructions", read.instructions.length === msg.instructions.length
    && read.instructions.every((ix, i) => ix.program === msg.instructions[i].programIdIndex
      && ix.accounts.join() === msg.instructions[i].accounts.join()
      && base58(ix.data) === msg.instructions[i].data));
  ok("  signers and writable accounts as Solana sees them", read.accounts.every((_, i) =>
    isSigner(read, i) === msg.isAccountSigner(i) && isWritable(read, i) === msg.isAccountWritable(i)));
  ok("  the message bytes are what signatures cover", Buffer.from(read.message).equals(msg.serialize()));
  ok("  written back, byte for byte the same", Buffer.from(writeTransaction(read)).equals(bytes));
  ok("  the fee payer's signature slot is still empty", read.signatures[0].every((b) => b === 0));
  ok("  the listener's signature checks out", await verifySignature(listener.publicKey.toBase58(), read.signatures[1], read.message));
  ok("  and isn't accepted for anyone else", !(await verifySignature(fee.publicKey.toBase58(), read.signatures[1], read.message)));

  const transfer = read.instructions[1];
  ok("  a transferChecked's amount reads correctly", transfer.data[0] === 12 && u64(transfer.data, 1) === 70_000 && transfer.data[9] === 6);
}

// ── refusals ────────────────────────────────────────────────────────────────
{
  const t = await payment();
  t.partialSign(listener);
  const bytes = new Uint8Array(t.serialize({ requireAllSignatures: false }));

  refuses("an empty transaction is refused", new Uint8Array(0));
  refuses("a transaction cut short is refused", bytes.slice(0, bytes.length - 3), /ends early/);
  refuses("extra bytes after it are refused", Uint8Array.from([...bytes, 0]), /extra bytes/);
  refuses("anything over Solana's size limit is refused", new Uint8Array(1300), /too large/);

  const lie = bytes.slice(); lie[0] = 3;   // claims three signatures
  refuses("a signature count that doesn't match the signers is refused", lie);

  const badIndex = bytes.slice();
  const read = readTransaction(bytes);
  // Point the first instruction's program at an account that doesn't exist.
  const head = 1 + 64 * read.signatures.length + 3 + 1 + 32 * read.accounts.length + 32 + 1;
  badIndex[head] = read.accounts.length + 5;
  refuses("an instruction naming an account that isn't there is refused", badIndex, /isn't there/);

  // A versioned (v0) transaction, which could hide accounts in lookup tables.
  const m = new TransactionMessage({ payerKey: fee.publicKey, recentBlockhash: blockhash, instructions: t.instructions }).compileToV0Message();
  const v0 = new VersionedTransaction(m);
  refuses("a versioned transaction is refused", v0.serialize(), /only legacy/);

  // The same account listed twice.
  const dup = bytes.slice();
  const keysAt = 1 + 64 * read.signatures.length + 3 + 1;
  dup.set(dup.slice(keysAt, keysAt + 32), keysAt + 32);
  refuses("an account listed twice is refused", dup, /twice/);

  refuses("a non-standard length encoding is refused", Uint8Array.from([0x81, 0x00]), /non-standard/);
}

// ── the small pieces ────────────────────────────────────────────────────────
{
  const keys = [fee.publicKey, new PublicKey(new Uint8Array(32)), new PublicKey(Uint8Array.from([0, 0, 1, ...new Array(29).fill(255)]))];
  ok("base58 writes keys as Solana does", keys.every((k) => base58(k.toBytes()) === k.toBase58()));
  ok("and reads them back", keys.every((k) => Buffer.from(unbase58(k.toBase58())).equals(k.toBytes())));
  ok("base58 refuses what isn't base58", unbase58("0OIl") === null && unbase58("") === null);
  ok("short lengths are written as Solana does", [0, 1, 127, 128, 300, 16383, 16384].every((n) =>
    Buffer.from(shortBytes(n)).equals(Buffer.from(web3.Transaction ? encodeLength(n) : []))));
  let threw = false; try { u64(Uint8Array.from(new Array(9).fill(255)), 1); } catch { threw = true; }
  ok("an amount too large to be real is refused", threw);
  ok("SystemProgram is recognised by address", SystemProgram.programId.toBase58() === "11111111111111111111111111111111");
}

function encodeLength(len) {
  const out = [];
  let rem = len;
  for (;;) {
    let elem = rem & 0x7f;
    rem >>= 7;
    if (rem === 0) { out.push(elem); break; }
    elem |= 0x80; out.push(elem);
  }
  return out;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
