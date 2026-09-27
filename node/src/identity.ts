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

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Solana addresses and signatures are base58. No dependencies for 40 lines. */
export function fromBase58(text: string): Uint8Array | null {
  // Decoding is bignum arithmetic and therefore quadratic in the length of the
  // input, which a stranger chooses. An address is 44 characters and a
  // signature 88; anything beyond this is not a slightly odd key, it is someone
  // trying to spend the node's processor time.
  if (typeof text !== "string" || text.length > 128) return null;
  let n = 0n;
  for (const ch of text) {
    const i = B58.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const ch of text) {
    if (ch === B58[0]) bytes.unshift(0);
    else break;
  }
  return Uint8Array.from(bytes);
}

/**
 * Does `signature` prove that the holder of `address` signed `message`?
 *
 * Ed25519 is what Solana signs with, and what WebCrypto calls "Ed25519". A
 * wrong key, a tampered message or a malformed input all come back false
 * rather than throwing: this is called with whatever a stranger sent.
 */
export async function verifySignature(
  address: string,
  message: string,
  signature: string,
): Promise<boolean> {
  const key = fromBase58(address);
  const sig = fromBase58(signature);
  if (!key || key.length !== 32 || !sig || sig.length !== 64) return false;

  try {
    const publicKey = await crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      sig,
      new TextEncoder().encode(message),
    );
  } catch {
    return false;   // unsupported curve, bad key material, anything
  }
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
