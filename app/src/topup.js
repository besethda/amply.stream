/**
 * Topping up with one tap.
 *
 * A Solana Pay transfer request is a link that says who to pay, how much, and
 * in which coin. Phantom and other wallets open it with everything filled in,
 * so the listener confirms instead of copying a 44-character address between
 * two apps — and cannot pick the wrong network, because the coin is named
 * exactly: USDC on Solana, by its mint.
 *
 *   solana:<address>?amount=5&spl-token=<USDC mint>&label=Amply&message=…
 *
 * No imports: this is string-building, and it is used on a screen that should
 * not wait for the payment libraries.
 */

/** A request for `amount` of a token (or of SOL, when `mint` is omitted). */
export function transferRequest(address, amount, { mint = null, message = "Top up your Amply wallet" } = {}) {
  // Built by hand rather than with URLSearchParams, which writes a space as
  // "+". The spec's examples percent-encode ("Thanks%20for%20all"), and a
  // strict wallet is entitled to read "+" as a plus sign — or to refuse.
  const parts = [`amount=${amount}`];
  if (mint) parts.push(`spl-token=${mint}`);
  parts.push(`label=${encodeURIComponent("Amply")}`);
  parts.push(`message=${encodeURIComponent(message)}`);
  return `solana:${address}?${parts.join("&")}`;
}

/**
 * Can this wallet be topped up with a one-tap request yet?
 *
 * Not until it exists on the network and has an account for dollars. The
 * Solana Pay reference implementation — which wallets follow — refuses a
 * transfer to a recipient that doesn't exist ("recipient not found") or, for
 * USDC, whose dollar account doesn't ("recipient not initialized"). So the
 * first top-up is an ordinary send from Phantom, which sets up both, and
 * one-tap works from then on.
 */
export const oneTapReady = (balance) => !!(balance && balance.exists && balance.dollarAccount);

/** What the setup screen offers: dollars in a few sizes. */
export const DOLLAR_AMOUNTS = [5, 10, 20];

/**
 * Adding money by card, through Stripe's onramp.
 *
 * Opened on a page of the relay's, never inside the app: Stripe's onramp
 * runs a script of theirs, and this app's origin is where the wallet key
 * lives. That page shows the address, copies it, and hands over to Stripe.
 * Stripe's fee includes a fixed part, so the amounts start at $10.
 */
export const TOPUP_PAGE = "https://amply-relay.sdarmistead.workers.dev/topup";
export const CARD_AMOUNTS = [10, 20, 50];

/** Amply's relay, where these pages live. */
export const RELAY = new URL(TOPUP_PAGE).origin;

/** The top-up page for buying `currency` ("usdc" or "sol") to this address. */
export function topupUrl(address, { currency = "usdc", amount = null } = {}) {
  const q = [`address=${encodeURIComponent(address)}`, `currency=${currency}`];
  if (currency === "usdc" && amount !== null) {
    if (!CARD_AMOUNTS.includes(amount)) throw new Error(`not a card amount: ${amount}`);
    q.push(`amount=${amount}`);
  }
  return `${TOPUP_PAGE}?${q.join("&")}`;
}

// ── Coinbase, for artists ───────────────────────────────────────────────────
//
// Pages of Amply's relay, opened by the artist's editor: buying SOL for the
// fees account, and cashing out. Each is signed by the wallet concerned.

/** The page that sends an artist to Coinbase to buy SOL for their node's
 *  fees account, signed by the node (a page, so the editor fetches nothing). */
export const coinbaseSolPage = (address, amount, signedAt, signature) =>
  `${RELAY}/coinbase/sol?${new URLSearchParams({ address, amount: String(amount), signedAt: String(signedAt), signature })}`;

/** What a payout wallet signs to cash out through Coinbase (the relay checks
 *  it): the amount, and this cash-out's own random nonce. */
export const sellMessage = (address, signedAt, nonce, amount) =>
  `Amply: cash out $${Number(amount).toFixed(2)} from ${address} through Coinbase (${signedAt}, ${nonce})`;

/** A fresh nonce for one cash-out: 16 random bytes, as hex. */
export const sellNonce = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

/** Coinbase's cash-out page for `amount` USDC from this wallet, opened from the editor. */
export const coinbaseCashoutPage = (address, amount, signedAt, signature, nonce) =>
  `${RELAY}/coinbase/sell?${new URLSearchParams({ address, amount: String(amount), signedAt: String(signedAt), signature, nonce })}`;

/**
 * Whether to send what Coinbase asks for, or why not. Coinbase's answer comes
 * through the relay and the artist's node; the editor sends only exactly the
 * amount the artist entered, to a Solana address.
 */
export function cashoutProblem(send, enteredMicros) {
  if (!send || typeof send.to !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(send.to)) return "Coinbase didn't give a Solana address to send to. Nothing was sent.";
  if (!Number.isSafeInteger(send.micros) || send.micros !== enteredMicros) {
    return `Coinbase is asking for $${(Number(send.micros) / 1e6).toFixed(2)}, not the $${(enteredMicros / 1e6).toFixed(2)} you entered. Nothing was sent; start again.`;
  }
  return null;
}

/**
 * Cash App can pay a Solana wallet straight from its dollar balance. There
 * is no link that fills it in, so the app copies the address and says
 * exactly where to paste it. Free for now (Cash App's offer), US only, and
 * not available in New York.
 */
export const CASH_APP = "https://cash.app/";
