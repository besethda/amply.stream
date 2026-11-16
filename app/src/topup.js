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

// ── adding money through Coinbase ───────────────────────────────────────────
//
// Coinbase's page opens with everything filled in: this wallet, USDC on
// Solana, and the amount. The relay asks Coinbase for the session, with
// Amply's own developer key; the app proves the wallet is its own by signing
// a short message, so nobody else can ask for a session for it.

/** The relay that serves the card page and asks Coinbase for sessions. */
export const RELAY = new URL(TOPUP_PAGE).origin;
export const COINBASE_AMOUNTS = [20, 30, 60];

/** Exactly what the relay checks the signature against. */
export const onrampMessage = (address, signedAt) =>
  `Amply: add money to ${address} through Coinbase (${signedAt})`;

let offered = null;
/** Whether Coinbase is set up on the relay. Asked once per visit. */
export async function coinbaseOffered(fetchFn = fetch) {
  if (offered !== null) return offered;
  try {
    const res = await fetchFn(`${RELAY}/coinbase/status`);
    offered = res.ok && (await res.json()).enabled === true;
  } catch { offered = false; }
  return offered;
}

/**
 * Coinbase's page for adding `amount` dollars to this wallet. `sign(text)`
 * returns the wallet's base58 signature over text.
 */
export async function coinbaseLink(address, amount, sign, { fetchFn = fetch, now = Date.now() } = {}) {
  if (!COINBASE_AMOUNTS.includes(amount)) throw new Error(`not a Coinbase amount: ${amount}`);
  const signature = await sign(onrampMessage(address, now));
  const res = await fetchFn(`${RELAY}/coinbase/onramp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, amount, signedAt: now, signature }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.url) throw new Error(json.error || "Coinbase didn't open. Try again in a moment.");
  return json.url;
}

/**
 * Cash App can pay a Solana wallet straight from its dollar balance. There
 * is no link that fills it in, so the app copies the address and says
 * exactly where to paste it. Free for now (Cash App's offer), US only, and
 * not available in New York.
 */
export const CASH_APP = "https://cash.app/";
