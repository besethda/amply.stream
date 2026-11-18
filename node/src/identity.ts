/**
 * Proving who a listener is, without an account.
 *
 * The listener's wallet is their identity. To show they hold it, the app signs
 * a challenge this node issued, and the node checks the signature against the
 * public key. No password, no email, nothing for the artist to store securely,
 * and nothing that can be stolen and reused elsewhere.
 *
 * The whole design rests on a Worker being able to do this check, which is why
 * node/prove-access/run.mjs runs it in the real runtime rather than in Node.
 */

import { unbase58, verifySignature as verifyBytes } from "./solana-tx";

/** Solana addresses and signatures are base58 (solana-tx.ts decodes it, and
 *  refuses anything longer than a key or signature could be). */
export const fromBase58 = unbase58;

/**
 * Does `signature` prove that the holder of `address` signed `message`?
 *
 * Ed25519 is what Solana signs with, and what WebCrypto calls "Ed25519". A
 * wrong key, a tampered message or a malformed input all come back false
 * rather than throwing: this is called with whatever a stranger sent. The
 * check itself is solana-tx.ts's, on bytes; this takes the strings a
 * listener's app sends.
 */
export async function verifySignature(
  address: string,
  message: string,
  signature: string,
): Promise<boolean> {
  const sig = unbase58(signature);
  if (!sig) return false;
  return verifyBytes(address, sig, new TextEncoder().encode(message));
}

/**
 * A challenge for the listener to sign.
 *
 * It names this node and carries a timestamp, so a signature collected by one
 * artist cannot be replayed at another, or reused tomorrow.
 */
export function challenge(host: string, now = Date.now()): string {
  return `amply:${host}:${now}:${crypto.randomUUID()}`;
}

export function challengeIsFresh(text: string, host: string, now = Date.now()): boolean {
  const [tag, who, at] = text.split(":");
  if (tag !== "amply" || who !== host) return false;
  const when = Number(at);
  return Number.isFinite(when) && Math.abs(now - when) < 5 * 60_000;
}
