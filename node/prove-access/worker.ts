/**
 * A throwaway Worker that exists to answer two questions in the real runtime:
 *
 *   1. Can a Worker verify an Ed25519 signature from a Solana wallet?
 *   2. Can a Worker check a payment by reading the chain?
 *
 * Both are load-bearing for the wallet-as-identity design, and neither is worth
 * designing around until it has been seen working somewhere other than Node.
 * Driven by node/prove-access/run.mjs.
 */
import { verifySignature, challenge, challengeIsFresh } from "../src/identity";
import { verifyPayment } from "../src/payment-check";

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    if (pathname === "/challenge") {
      return json({ challenge: challenge("prove.test") });
    }

    if (pathname === "/verify" && request.method === "POST") {
      const { address, message, signature } = (await request.json()) as Record<string, string>;
      return json({
        ok: await verifySignature(address, message, signature),
        fresh: challengeIsFresh(message, "prove.test"),
      });
    }

    if (pathname === "/payment" && request.method === "POST") {
      const { claim, terms } = (await request.json()) as any;
      return json(await verifyPayment(claim, terms));
    }

    return json({ error: "not found" }, 404);
  },
};
