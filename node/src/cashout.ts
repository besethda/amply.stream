/**
 * The artist moving their earnings out, from a payout wallet made with Face
 * ID, without needing SOL: the node drafts the transfer with its fee wallet
 * as fee payer, the editor checks it and signs it with the passkey, and
 * settle.ts checks it again, signs as fee payer and sends it.
 *
 * Only behind the editor's sign-in (index.ts). The draft is exactly the shape
 * checkFeePayment accepts, with the destination as the only payee and the
 * payout wallet in the listener's place, so the same strict check covers it.
 */
import { compileTransaction, tokenAccountOf, u64Bytes, keyOf } from "./solana-tx";
import { TOKEN_PROGRAM, ATA_PROGRAM, SYSTEM_PROGRAM } from "./feepay";

/** Bounds on one transfer out, in micro-dollars: a cent to ten thousand dollars. */
export const CASHOUT_MIN_MICROS = 10_000;
export const CASHOUT_MAX_MICROS = 10_000_000_000;

export function cashOutProblem(from: string, to: string, micros: number, { payees, feePayer }: { payees: string[]; feePayer: string }): string | null {
  if (!payees.includes(from)) return "that isn't one of your payout wallets";
  if (!keyOf(to)) return "that isn't a Solana address. Copy it again from Cash App or Coinbase";
  if (to === from) return "that's your payout wallet's own address";
  if (to === feePayer) return "that's your fees account. Paste the deposit address from Cash App or Coinbase";
  if (!Number.isSafeInteger(micros) || micros < CASHOUT_MIN_MICROS) return "send at least a cent";
  if (micros > CASHOUT_MAX_MICROS) return "that's more than one transfer can be";
  return null;
}

/** The unsigned transfer: create the destination's USDC account if it
 *  isn't there (the fee wallet pays), then move the USDC. */
export async function draftCashOut({ feePayer, from, to, micros, mint, blockhash }:
  { feePayer: string; from: string; to: string; micros: number; mint: string; blockhash: string }): Promise<Uint8Array> {
  const source = await tokenAccountOf(from, mint, TOKEN_PROGRAM, ATA_PROGRAM);
  const dest = await tokenAccountOf(to, mint, TOKEN_PROGRAM, ATA_PROGRAM);
  const data = new Uint8Array(10);
  data[0] = 12; data.set(u64Bytes(micros), 1); data[9] = 6;
  return compileTransaction(feePayer, blockhash, [
    {
      program: ATA_PROGRAM, data: Uint8Array.of(1),
      accounts: [
        { key: feePayer, signer: true, writable: true },
        { key: dest, signer: false, writable: true },
        { key: to, signer: false, writable: false },
        { key: mint, signer: false, writable: false },
        { key: SYSTEM_PROGRAM, signer: false, writable: false },
        { key: TOKEN_PROGRAM, signer: false, writable: false },
      ],
    },
    {
      program: TOKEN_PROGRAM, data,
      accounts: [
        { key: source, signer: false, writable: true },
        { key: mint, signer: false, writable: false },
        { key: dest, signer: false, writable: true },
        { key: from, signer: true, writable: false },
      ],
    },
  ]);
}
