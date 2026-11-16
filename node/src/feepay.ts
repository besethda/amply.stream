/**
 * Paying listeners' network fees, safely.
 *
 * A Solana payment needs a little SOL for its network fee. Listeners don't
 * have any and shouldn't have to, so the artist's node can pay it: the
 * listener signs their USDC payment, the node adds its own signature as the
 * transaction's fee payer, and sends it.
 *
 * Signing as fee payer means the node's key signs the WHOLE transaction. If
 * the transaction also asked the fee wallet to move money, or to sign for
 * anything else, the node's signature would authorise that too. So the node
 * signs only a transaction it can account for completely, and refuses
 * everything else. What it accepts is exactly what the app writes:
 *
 *   - legacy format only (no lookup tables hiding accounts);
 *   - two signers: the fee wallet first (so it pays the fee), then the
 *     listener; the fee wallet's signature not yet there, the listener's valid;
 *   - two kinds of instruction and nothing else, not even a compute-budget
 *     instruction (no priority fees on the artist's SOL):
 *       · "create the payee's USDC account if it doesn't exist" (the
 *         associated-token program's idempotent create), for a payee named in
 *         the artist's own manifest, with the fee wallet as rent payer and the
 *         USDC mint. Solana's own program checks the account it creates is
 *         that payee's real USDC account, so a listener can't substitute one;
 *       · a checked USDC transfer, signed by the listener, into one of those
 *         payee accounts;
 *   - for a purchase, one memo naming what was bought, exactly as the node
 *     expects it, signed by the listener alone; for listening, no memo;
 *   - the fee wallet appears nowhere else: not as a transfer's source or
 *     authority, not as a payee, not in any other program;
 *   - the amounts divide between the payees exactly as the manifest's splits
 *     say (the same shareOut the app uses), and the total is within bounds.
 *     The lower bound makes spam cost the sender more than the artist: every
 *     accepted payment pays the artist at least that much, while the fee is a
 *     fraction of a cent.
 *
 * This file only decides. It never signs and never touches the network, so
 * it can be tested exhaustively; settle.ts does the rest.
 */
import { shareOut } from "../../spec/pricing.mjs";
import { isSigner, isWritable, u64, verifySignature, type Transaction } from "./solana-tx";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

const TRANSFER_CHECKED = 12;
const CREATE_IDEMPOTENT = 1;
const USDC_DECIMALS = 6;

export interface FeePayExpect {
  feePayer: string;                              // the node's fee wallet
  mint: string;                                  // USDC on this network
  payees: { address: string; split?: number }[]; // from the artist's manifest
  minMicros: number;
  maxMicros: number;
  memo?: string;                                 // a purchase's note; none for listening
}

export type FeePayVerdict =
  | { ok: true; listener: string; micros: number; shares: { address: string; micros: number }[] }
  | { ok: false; problem: string };

const no = (problem: string): FeePayVerdict => ({ ok: false, problem });

/**
 * Whether the node may sign `tx` as its fee payer. Everything is checked
 * before the listener's signature, which is the only slow part.
 */
export async function checkFeePayment(tx: Transaction, expect: FeePayExpect): Promise<FeePayVerdict> {
  const { feePayer, mint } = expect;
  const payees = expect.payees.filter((p) => typeof p?.address === "string");
  if (!payees.length) return no("this artist has no wallet to pay");
  const payeeSet = new Set(payees.map((p) => p.address));
  if (payeeSet.size !== payees.length) return no("the artist's wallet list names someone twice");
  if (payeeSet.has(feePayer)) return no("the fee wallet can't also be paid");

  // ── who signs ──
  if (tx.header.required !== 2 || tx.signatures.length !== 2) return no("a payment has exactly two signers");
  if (tx.accounts[0] !== feePayer) return no("the fee wallet isn't the fee payer");
  if (!isWritable(tx, 0)) return no("the fee wallet must pay the fee");
  const listener = tx.accounts[1];
  if (payeeSet.has(listener)) return no("the artist can't pay themselves through their own node");
  if (!tx.signatures[0].every((b) => b === 0)) return no("the fee wallet's signature is already there");

  // ── what it does ──
  const at = (i: number) => tx.accounts[i];
  const created = new Map<string, string>();   // payee account → payee
  const paid = new Map<string, number>();      // payee → micros
  const uses = new Map<number, number>();      // fee wallet / listener appearances, checked below
  let memos = 0;

  for (const ix of tx.instructions) {
    const program = at(ix.program);
    // A program is never a signer here; that would make no sense and isn't
    // something the app writes.
    if (isSigner(tx, ix.program)) return no("a signer is used as a program");

    if (program === ATA_PROGRAM) {
      if (ix.data.length !== 1 || ix.data[0] !== CREATE_IDEMPOTENT) return no("only creating a payee's USDC account is allowed");
      if (ix.accounts.length !== 6) return no("creating a USDC account takes six accounts");
      const [payer, account, owner, mintAt, system, token] = ix.accounts;
      if (payer !== 0) return no("the fee wallet pays for a payee's USDC account, nobody else");
      if (!payeeSet.has(at(owner))) return no("a USDC account is being created for someone who isn't paid");
      if (at(mintAt) !== mint) return no("that isn't USDC");
      if (at(system) !== SYSTEM_PROGRAM || at(token) !== TOKEN_PROGRAM) return no("creating a USDC account names the wrong programs");
      if (account < 2 || owner < 2) return no("a signer can't be a payee's account");
      if (created.has(at(account)) || [...created.values()].includes(at(owner))) return no("a payee's USDC account is created twice");
      created.set(at(account), at(owner));
      uses.set(0, (uses.get(0) ?? 0) + 1);
      continue;
    }

    if (program === TOKEN_PROGRAM) {
      if (ix.data.length !== 10 || ix.data[0] !== TRANSFER_CHECKED) return no("only checked USDC transfers are allowed");
      if (ix.data[9] !== USDC_DECIMALS) return no("that isn't USDC");
      if (ix.accounts.length !== 4) return no("a transfer takes four accounts");
      const [source, mintAt, dest, authority] = ix.accounts;
      if (authority !== 1) return no("the listener must sign their own payment");
      if (at(mintAt) !== mint) return no("that isn't USDC");
      if (source < 2) return no("a signer can't be a token account");
      // Only into an account this transaction creates (or confirms) as a
      // payee's: Solana's associated-token program won't accept one that
      // isn't that payee's real USDC account.
      const payee = created.get(at(dest));
      if (!payee) return no("a transfer goes somewhere that isn't a payee's USDC account");
      if (created.has(at(source))) return no("a transfer can't come from a payee's account");
      if (paid.has(payee)) return no("a payee is paid twice");
      const micros = u64(ix.data, 1);
      if (micros <= 0) return no("a transfer of nothing");
      paid.set(payee, micros);
      uses.set(1, (uses.get(1) ?? 0) + 1);
      continue;
    }

    if (program === MEMO_PROGRAM && expect.memo !== undefined) {
      if (++memos > 1) return no("a payment carries one note");
      if (ix.accounts.length !== 1 || ix.accounts[0] !== 1) return no("only the listener signs a payment's note");
      if (new TextDecoder().decode(ix.data) !== expect.memo || ix.data.length > 200) return no("the note doesn't say what was bought");
      uses.set(1, (uses.get(1) ?? 0) + 1);
      continue;
    }

    return no("the payment uses a program it doesn't need");
  }

  // The fee wallet and the listener appear only where counted above. Any
  // other mention (an extra account slot, a program index) is refused.
  for (const ix of tx.instructions) {
    if (ix.program === 0 || ix.program === 1) return no("a signer is used as a program");
  }
  const mentions = (i: number) => tx.instructions.reduce((n, ix) => n + ix.accounts.filter((a) => a === i).length, 0);
  if (mentions(0) !== (uses.get(0) ?? 0)) return no("the fee wallet is used for something other than fees");
  if (mentions(1) !== (uses.get(1) ?? 0)) return no("the listener's key is used for something other than paying");

  if (expect.memo !== undefined && memos !== 1) return no("a purchase must say what it bought");

  // Every account created is paid into: no paying rent for nothing.
  if (paid.size !== created.size) return no("a USDC account is created without being paid");

  // ── how much, and to whom ──
  const micros = [...paid.values()].reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(micros)) return no("the amount is impossibly large");
  if (micros < expect.minMicros) return no("too small to pay the network fee for");
  if (micros > expect.maxMicros) return no("more than one payment can be");
  const shares = shareOut(micros, payees).map((s) => ({ address: s.address, micros: s.micros }));
  if (shares.length !== paid.size || !shares.every((s) => paid.get(s.address) === s.micros)) {
    return no("the payment isn't split the way the artist set it");
  }

  // ── last, the listener's signature ──
  if (!(await verifySignature(listener, tx.signatures[1], tx.message))) return no("the listener's signature doesn't check out");

  return { ok: true, listener, micros, shares };
}
