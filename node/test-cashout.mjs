/**
 * Cashing out from a Face ID payout wallet: the node's own address maths and
 * transaction building, checked against Solana's libraries, and the whole
 * draft → sign → check → send loop, refused wherever it should be.
 *
 *   npm run test:feepay
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { webcrypto } from "node:crypto";
import { SCHEMA } from "./src/store.ts";
import { onCurve, tokenAccountOf, readTransaction, writeTransaction, base64 } from "./src/solana-tx.ts";
import { TOKEN_PROGRAM, ATA_PROGRAM } from "./src/feepay.ts";
import { draftCashOut, cashOutProblem } from "./src/cashout.ts";
import { settle, feeAddress, forgetFeeKey } from "./src/settle.ts";
import { signWithSeed, publicKeyOf, base58 as b58 } from "../spec/passkey-wallet.mjs";

const require = createRequire(resolve("app/package.json"));
const web3 = require("@solana/web3.js");
const spl = require("@solana/spl-token");
const { Keypair, PublicKey, Transaction } = web3;

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

// ── on the curve or not, exactly as Solana decides ──────────────────────────
{
  let agree = 0, both = 0;
  const N = 3000;
  for (let i = 0; i < N; i++) {
    const b = webcrypto.getRandomValues(new Uint8Array(32));
    if (onCurve(b) === PublicKey.isOnCurve(b)) agree++;
  }
  for (let i = 0; i < 200; i++) {
    const k = Keypair.generate().publicKey.toBytes();
    if (onCurve(k) && PublicKey.isOnCurve(k)) both++;
  }
  ok(`the curve check agrees with Solana on ${N} random values`, agree === N, `${agree}/${N}`);
  ok("  and every real public key is on the curve", both === 200);
}

// ── a wallet's USDC account address ─────────────────────────────────────────
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
{
  let same = 0;
  for (let i = 0; i < 100; i++) {
    const owner = Keypair.generate().publicKey;
    const mine = await tokenAccountOf(owner.toBase58(), USDC, TOKEN_PROGRAM, ATA_PROGRAM);
    if (mine === spl.getAssociatedTokenAddressSync(new PublicKey(USDC), owner).toBase58()) same++;
  }
  ok("USDC account addresses match Solana's for 100 wallets", same === 100, `${same}/100`);
}

// ── the node, with a payout wallet made from a passkey seed ─────────────────
const sqlite = new DatabaseSync(":memory:");
for (const s of SCHEMA) sqlite.exec(s);
const DB = {
  prepare(sql) {
    const stmt = sqlite.prepare(sql);
    let args = [];
    const api = {
      bind(...a) { args = a; return api; },
      async run() { stmt.run(...args); },
      async first() { return stmt.get(...args) ?? null; },
      async all() { return { results: stmt.all(...args) }; },
    };
    return api;
  },
};
forgetFeeKey();
const feePayer = await feeAddress(DB);
const seed = webcrypto.getRandomValues(new Uint8Array(32));
const from = b58(await publicKeyOf(seed));
const cashApp = Keypair.generate().publicKey.toBase58();
const blockhash = Keypair.generate().publicKey.toBase58();
const payees = [from, Keypair.generate().publicKey.toBase58()];

const draft = await draftCashOut({ feePayer, from, to: cashApp, micros: 412_000, mint: USDC, blockhash });
{
  const t = Transaction.from(Buffer.from(draft));
  ok("the draft is a transaction Solana's library reads", !!t && t.instructions.length === 2);
  ok("  the fee is paid by the node's fee wallet", t.feePayer.toBase58() === feePayer);
  const want = [
    spl.createAssociatedTokenAccountIdempotentInstruction(new PublicKey(feePayer), spl.getAssociatedTokenAddressSync(new PublicKey(USDC), new PublicKey(cashApp)), new PublicKey(cashApp), new PublicKey(USDC)),
    spl.createTransferCheckedInstruction(spl.getAssociatedTokenAddressSync(new PublicKey(USDC), new PublicKey(from)), new PublicKey(USDC),
      spl.getAssociatedTokenAddressSync(new PublicKey(USDC), new PublicKey(cashApp)), new PublicKey(from), 412_000, 6),
  ];
  const same = (a, b) => a.programId.equals(b.programId) && Buffer.from(a.data).equals(Buffer.from(b.data))
    && a.keys.length === b.keys.length && a.keys.every((k, i) => k.pubkey.equals(b.keys[i].pubkey) && k.isSigner === b.keys[i].isSigner && k.isWritable === b.keys[i].isWritable);
  ok("  the same two instructions Solana's library would write", same(t.instructions[0], want[0]) && same(t.instructions[1], want[1]));
  ok("  both signature slots empty", t.signatures.every((s) => !s.signature));
}

/** What the editor does: sign the draft with the passkey seed. */
async function signed(bytes, by = seed) {
  const tx = readTransaction(bytes);
  tx.signatures[1] = await signWithSeed(by, tx.message);
  return base64.encode(writeTransaction(tx));
}
const sent = [];
const rpc = async (method, params) => {
  if (method === "simulateTransaction") return { value: { err: null, logs: [] } };
  if (method === "sendTransaction") { sent.push(params[0]); return "ok"; }
  if (method === "getSignatureStatuses") return { value: [{ confirmationStatus: "confirmed", err: null }] };
  throw new Error(method);
};
const quick = { wait: async () => {}, confirmWithinMs: 20 };
const terms = (to = cashApp, micros = 412_000) => ({ mint: USDC, payees: [{ address: to, split: 100 }], minMicros: micros, maxMicros: micros });

{
  const r = await settle(DB, rpc, await signed(draft), terms(), { ...quick, from: payees });
  ok("signed with Face ID, the node sends it", r.ok && sent.length === 1, r.why);
  const t = Transaction.from(Buffer.from(sent[0], "base64"));
  ok("  carrying both signatures, valid", t.verifySignatures());
}
{
  const r = await settle(DB, rpc, await signed(draft), terms(), { ...quick, from: [Keypair.generate().publicKey.toBase58()] });
  ok("from a wallet that isn't one of the artist's: refused", !r.ok && r.status === 403 && /payout wallets/.test(r.why));
}
{
  const r = await settle(DB, rpc, await signed(draft), terms(Keypair.generate().publicKey.toBase58()), { ...quick, from: payees });
  ok("to a different address than the one confirmed: refused", !r.ok && r.status === 403);
}
{
  const r = await settle(DB, rpc, await signed(draft), terms(cashApp, 999_999), { ...quick, from: payees });
  ok("a different amount than the one confirmed: refused", !r.ok && r.status === 403);
}
{
  const r = await settle(DB, rpc, await signed(draft, webcrypto.getRandomValues(new Uint8Array(32))), terms(), { ...quick, from: payees });
  ok("signed by the wrong key: refused", !r.ok && r.status === 403 && /signature/.test(r.why));
}

// ── what can be asked for at all ────────────────────────────────────────────
const rules = { payees, feePayer };
ok("a payout wallet to a deposit address is fine", cashOutProblem(from, cashApp, 412_000, rules) === null);
ok("only from the artist's own payout wallets", /payout wallets/.test(cashOutProblem(cashApp, from, 412_000, rules)));
ok("not to itself", /own address/.test(cashOutProblem(from, from, 412_000, rules)));
ok("not to the fees account", /fees account/.test(cashOutProblem(from, feePayer, 412_000, rules)));
ok("not to something that isn't an address", /isn't a Solana address/.test(cashOutProblem(from, "cashapp.com/$me", 412_000, rules)));
ok("not less than a cent", /at least a cent/.test(cashOutProblem(from, cashApp, 9_999, rules)));
ok("not a fraction of a micro", !!cashOutProblem(from, cashApp, 412_000.5, rules));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
