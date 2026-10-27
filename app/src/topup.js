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

/** What the setup screen offers. Dollars in a few sizes, and one amount of SOL
 *  that covers the network fee for thousands of payments. */
export const DOLLAR_AMOUNTS = [5, 10, 20];
export const FEE_SOL = 0.01;

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

/** The top-up page for buying `currency` ("usdc" or "sol") to this address. */
export function topupUrl(address, { currency = "usdc", amount = null } = {}) {
  const q = [`address=${encodeURIComponent(address)}`, `currency=${currency}`];
  if (currency === "usdc" && amount !== null) {
    if (!CARD_AMOUNTS.includes(amount)) throw new Error(`not a card amount: ${amount}`);
    q.push(`amount=${amount}`);
  }
  return `${TOPUP_PAGE}?${q.join("&")}`;
}
