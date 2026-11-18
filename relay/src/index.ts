/**
 * Amply CORS relay.
 *
 * Cloudflare's API sends no CORS headers, so a browser cannot call it directly.
 * This forwards requests and adds the headers the browser needs. The one other
 * thing it does is serve a static page for adding money by card (see /topup
 * below), because that page must not share an origin with the listener app.
 *
 * It exists because Amply's deploy site has to provision resources in an
 * artist's own Cloudflare account, and the alternative — asking artists to paste
 * an API token, or routing them through a GitHub account they do not have — is
 * worse. See docs/build.md §1A.
 *
 * WHAT THIS MUST NEVER BECOME
 *
 * There are no storage bindings on this Worker. No KV, no R2, no D1, no Durable
 * Objects. That is deliberate and load-bearing: there is nothing here to
 * exfiltrate even if this code is wrong. Adding a binding would make Amply a
 * party that holds something, which the whole architecture exists to avoid
 * (docs/legal.md §1).
 *
 * Nothing is logged. Not headers, not bodies, not tokens, not origins. An
 * artist's access token passes through this Worker in memory for the duration
 * of one request and is never written anywhere.
 *
 * And the bright line: Amply never requests `offline_access` and never accepts
 * a refresh token. Access to an artist's account lasts for one provisioning
 * flow and is then gone permanently. This relay rejects any token response
 * carrying a refresh token rather than passing it on.
 */


export interface Env {
  ALLOWED_ORIGINS: string;
  /**
   * Amply's own Coinbase Developer Platform key, for one thing only: asking
   * Coinbase for a five-minute onramp session for a listener's wallet. Set as
   * Worker secrets (`wrangler secret put`), never in code or config. Without
   * them the Coinbase route says so and the app doesn't offer Coinbase.
   */
  CDP_KEY_ID?: string;
  CDP_KEY_SECRET?: string;
  /** Cloudflare's rate limiter: it counts requests and stores nothing else. */
  ONRAMP_LIMIT?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

/**
 * How often one connection, or one wallet, may ask for a Coinbase session.
 * A listener taps a top-up button a few times at most; a script minting
 * sessions to run up Amply's Coinbase usage hits this at once. Counted by
 * Cloudflare's limiter where bound, else in this copy of the Worker.
 */
const ONRAMP_PER_MINUTE = 6;
const counts = new Map<string, { n: number; until: number }>();
export async function onrampAllowed(env: Env, key: string, now = Date.now()): Promise<boolean> {
  if (env.ONRAMP_LIMIT) {
    try { return (await env.ONRAMP_LIMIT.limit({ key })).success; } catch { /* fall back below */ }
  }
  let c = counts.get(key);
  if (!c || c.until <= now) {
    if (counts.size > 5_000) counts.clear();
    c = { n: 0, until: now + 60_000 };
    counts.set(key, c);
  }
  return ++c.n <= ONRAMP_PER_MINUTE;
}

const API = "https://api.cloudflare.com/client/v4";
const TOKEN = "https://dash.cloudflare.com/oauth2/token";
const REVOKE = "https://dash.cloudflare.com/oauth2/revoke";

/**
 * Exactly the API paths provisioning needs, and nothing else. An open proxy to
 * the Cloudflare API would be a genuinely dangerous thing to leave running.
 */
const ALLOWED: Array<{ method: string; pattern: RegExp }> = [
  // Discover which account to build in.
  { method: "GET", pattern: /^\/accounts$/ },
  // Storage for audio.
  { method: "POST", pattern: /^\/accounts\/[0-9a-f]{32}\/r2\/buckets$/ },
  // Or KV, for a node that starts in a temporary account, which can't use R2.
  // Value keys are URL-encoded into the path (a slash is %2F), so the pattern
  // admits percent-escapes and no slash at all. Never an encoded dot, in any
  // case, and never a leading one: URL parsing turns a %2e%2E segment into
  // "..", which would aim the write at the namespace itself.
  { method: "GET", pattern: /^\/accounts\/[0-9a-f]{32}\/storage\/kv\/namespaces$/ },
  { method: "POST", pattern: /^\/accounts\/[0-9a-f]{32}\/storage\/kv\/namespaces$/ },
  { method: "PUT", pattern: /^\/accounts\/[0-9a-f]{32}\/storage\/kv\/namespaces\/[0-9a-f]{32}\/values\/(?!.*\.\.)(?!.*%2[eE])[A-Za-z0-9!_*'()%-][A-Za-z0-9!_.*'()%-]{0,1535}$/ },
  { method: "GET", pattern: /^\/accounts\/[0-9a-f]{32}\/r2\/buckets$/ },
  // Audio and artwork. Object keys may contain slashes and dots; no traversal,
  // no query smuggling.
  { method: "PUT", pattern: /^\/accounts\/[0-9a-f]{32}\/r2\/buckets\/[a-z0-9][a-z0-9-]{1,62}\/objects\/(?!.*\.\.)[A-Za-z0-9!_.*'()/-]{1,512}$/ },
  { method: "GET", pattern: /^\/accounts\/[0-9a-f]{32}\/r2\/buckets\/[a-z0-9][a-z0-9-]{1,62}\/objects\/(?!.*\.\.)[A-Za-z0-9!_.*'()/-]{1,512}$/ },
  { method: "DELETE", pattern: /^\/accounts\/[0-9a-f]{32}\/r2\/buckets\/[a-z0-9][a-z0-9-]{1,62}\/objects\/(?!.*\.\.)[A-Za-z0-9!_.*'()/-]{1,512}$/ },
  // Zero Trust, so the artist can host their own editor behind Cloudflare Access.
  // Read first, then create only if absent — these are account-wide objects and
  // must never be clobbered if the artist already uses Zero Trust for something.
  { method: "GET", pattern: /^\/accounts\/[0-9a-f]{32}\/access\/organizations$/ },
  { method: "POST", pattern: /^\/accounts\/[0-9a-f]{32}\/access\/organizations$/ },
  { method: "GET", pattern: /^\/accounts\/[0-9a-f]{32}\/access\/apps$/ },
  // Identity providers. A fresh Zero Trust organisation has none, so nobody can
  // sign in to the editor at all. POST is body-checked below and accepts only
  // one-time PIN — see the note there.
  { method: "GET", pattern: /^\/accounts\/[0-9a-f]{32}\/access\/identity_providers$/ },
  { method: "POST", pattern: /^\/accounts\/[0-9a-f]{32}\/access\/identity_providers$/ },
  { method: "POST", pattern: /^\/accounts\/[0-9a-f]{32}\/access\/apps$/ },
  { method: "POST", pattern: /^\/accounts\/[0-9a-f]{32}\/access\/apps\/[0-9a-f-]{36}\/policies$/ },
  // Read back who an already-existing application admits. Setup adopts an app
  // it finds for this address, and adopting one without reading its rule would
  // mean inheriting whoever it lets in.
  { method: "GET", pattern: /^\/accounts\/[0-9a-f]{32}\/access\/apps\/[0-9a-f-]{36}\/policies$/ },
  // The artist's database: the track list, the sign-in settings, and a tally
  // per listener. Creating one, and running the schema into it.
  { method: "GET", pattern: /^\/accounts\/[0-9a-f]{32}\/d1\/database$/ },
  { method: "POST", pattern: /^\/accounts\/[0-9a-f]{32}\/d1\/database$/ },
  { method: "POST", pattern: /^\/accounts\/[0-9a-f]{32}\/d1\/database\/[0-9a-f-]{36}\/query$/ },
  // The streaming service itself.
  { method: "PUT", pattern: /^\/accounts\/[0-9a-f]{32}\/workers\/scripts\/[a-z0-9-]{1,63}$/ },
  { method: "GET", pattern: /^\/accounts\/[0-9a-f]{32}\/workers\/scripts\/[a-z0-9-]{1,63}$/ },
  // A rebuild reads which storage and database the service is already wired
  // to, and reuses exactly those, rather than guessing them from its name.
  { method: "GET", pattern: /^\/accounts\/[0-9a-f]{32}\/workers\/scripts\/[a-z0-9-]{1,63}\/settings$/ },
  // Give it a public URL.
  { method: "GET", pattern: /^\/accounts\/[0-9a-f]{32}\/workers\/subdomain$/ },
  // Claim the account's workers.dev name. A new account has none, and
  // Cloudflare's advice, that opening the dashboard creates one, does not
  // hold: artists were left stuck at a screen telling them to go and do
  // something the page did not do.
  { method: "PUT", pattern: /^\/accounts\/[0-9a-f]{32}\/workers\/subdomain$/ },
  { method: "POST", pattern: /^\/accounts\/[0-9a-f]{32}\/workers\/scripts\/[a-z0-9-]{1,63}\/subdomain$/ },
  // Put the artist's service on a domain they own, like listen.theirname.com.
  // Body-checked below: a hostname and the Worker's name, and never the flag
  // that would overwrite an existing DNS record — that is how an artist's
  // website would get replaced by accident.
  { method: "PUT", pattern: /^\/accounts\/[0-9a-f]{32}\/workers\/domains$/ },
];

// ── adding money by card ──────────────────────────────────────────────────
//
// Stripe's onramp sells USDC by card. Its no-account mode builds the checkout
// link with a script of Stripe's, and that script must never run on
// amply.stream: the listener's wallet key is in that origin's storage, and a
// third-party script there could read it. So the step runs here instead, on
// this Worker's own origin, which holds nothing and can see nothing of the
// app's.
//
// The page shows the listener's wallet address (public: it is where money is
// sent), copies it for them to paste into Stripe's checkout, and sends them
// on. No-account mode can't fill the address in itself; only a server-made
// session can, and that would need a Stripe secret here.

const STRIPE_ONRAMP_SCRIPT = "https://crypto-js.stripe.com/crypto-onramp-outer.js";
const TOPUP_AMOUNTS = ["10", "20", "50"];

/** The parameters the top-up page takes, or why they're refused. */
export function topupParams(url: URL): { address: string; currency: "usdc" | "sol"; amount: string | null } | string {
  const address = url.searchParams.get("address") || "";
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return "not a Solana address";
  const currency = url.searchParams.get("currency") || "usdc";
  if (currency !== "usdc" && currency !== "sol") return "only USDC or SOL";
  const amount = url.searchParams.get("amount");
  if (currency === "usdc" && amount !== null && !TOPUP_AMOUNTS.includes(amount)) return "not an amount offered";
  if (currency === "sol" && amount !== null) return "SOL is bought in whatever amount the listener picks";
  return { address, currency, amount };
}

const TOPUP_CSP = [
  "default-src 'none'",
  // This Worker's own script, and Stripe's. Nothing inline.
  `script-src 'self' ${STRIPE_ONRAMP_SCRIPT}`,
  "connect-src https://*.stripe.com",
  "frame-src https://*.stripe.com",
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function topupPage(p: { address: string; currency: "usdc" | "sol"; amount: string | null }): string {
  if (p.currency === "sol") return feesPage(p);
  const what = p.currency === "usdc"
    ? `${p.amount ? `$${p.amount} of ` : ""}USDC`
    : "SOL";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Add money - Amply</title></head>
<body style="font:18px/1.5 system-ui,sans-serif;max-width:34rem;margin:0 auto;padding:32px 16px;color:#1b1813;background:#fbf8f3">
<p style="font-weight:800;letter-spacing:-0.02em;margin:0 0 18px">amply</p>
<h1 style="font-size:28px;margin:0 0 12px">${p.currency === "usdc" ? "Add money to your Amply wallet" : "Fill your fees account"}</h1>
<p style="margin:0 0 16px">You're buying ${escapeHtml(what)} by card, through Stripe.${p.currency === "usdc" ? " USDC is a digital dollar: $1 of it is worth $1." : ""} Three steps:</p>
<ol style="margin:0 0 20px;padding-left:22px">
<li>Press the button below. We copy your wallet's address, and Stripe's page opens.</li>
<li>When Stripe asks where to send it, paste the address. If it asks for a network, choose <b>Solana</b>.</li>
<li>Pay by card. The first time, Stripe may ask for ID. Then go back to Amply.</li>
</ol>
<p style="background:#fff3e8;border:1px solid #f4c9a8;border-radius:12px;padding:12px 16px;margin:0 0 16px;font-size:16px">
<b>Check this is yours.</b> The Amply page you came from shows the last four characters. They must match
<b style="font:20px ui-monospace,monospace;letter-spacing:.06em">${escapeHtml(p.address.slice(-4))}</b>.
If they don't, or someone sent you this link, close this page: the money would go to someone else.</p>
<p style="color:#6b6257;font-size:15px;margin:0 0 6px">The wallet the money goes to:</p>
<p id="address" style="font:15px ui-monospace,monospace;overflow-wrap:anywhere;background:#fff;border:1px solid #e4dccf;border-radius:12px;padding:14px 16px;margin:0 0 20px">${escapeHtml(p.address.slice(0, -4))}<b style="font-size:18px">${escapeHtml(p.address.slice(-4))}</b></p>
<button id="go" disabled style="font:inherit;font-weight:700;padding:14px 26px;border:0;border-radius:999px;background:#f26b1d;color:#1b1813;cursor:pointer">Copy address and continue</button>
<p id="said" style="color:#6b6257;font-size:15px;margin:16px 0 0">Loading Stripe…</p>
<p style="color:#6b6257;font-size:15px;margin:28px 0 0">Stripe handles the payment and any identity check. Amply never sees your card and takes nothing.</p>
<p style="font-size:15px;margin:20px 0 0"><a href="https://amply.stream/app/" style="color:#1b1813">&larr; Back to Amply</a></p>
<script id="params" type="application/json">${JSON.stringify(p).replace(/</g, "\\u003c")}</script>
<script src="${STRIPE_ONRAMP_SCRIPT}"></script>
<script src="/topup.js"></script>
</body></html>`;
}

/** An artist filling their fees account: a few words, the address, the button. */
function feesPage(p: { address: string; currency: "usdc" | "sol"; amount: string | null }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Fill your fees account - Amply</title></head>
<body style="font:18px/1.5 system-ui,sans-serif;max-width:34rem;margin:0 auto;padding:32px 16px;color:#1b1813;background:#fbf8f3">
<p style="font-weight:800;letter-spacing:-0.02em;margin:0 0 18px">amply</p>
<h1 style="font-size:28px;margin:0 0 12px">Fill your fees account</h1>
<p style="margin:0 0 16px">Artists cover transaction fees to make it easier for their listeners ($1 covers ~1,000 payments).
We use the Solana network, and you may have to create an account with Stripe.</p>
<p style="margin:0 0 6px">Make sure your wallet address matches this:</p>
<p id="address" style="font:15px ui-monospace,monospace;overflow-wrap:anywhere;background:#fff;border:1px solid #e4dccf;border-radius:12px;padding:14px 16px;margin:0 0 20px">${escapeHtml(p.address.slice(0, -4))}<b style="font-size:18px">${escapeHtml(p.address.slice(-4))}</b></p>
<button id="go" disabled style="font:inherit;font-weight:700;padding:14px 26px;border:0;border-radius:999px;background:#f26b1d;color:#1b1813;cursor:pointer">Copy address and continue</button>
<p id="said" style="color:#6b6257;font-size:15px;margin:16px 0 0">Loading Stripe…</p>
<script id="params" type="application/json">${JSON.stringify(p).replace(/</g, "\\u003c")}</script>
<script src="${STRIPE_ONRAMP_SCRIPT}"></script>
<script src="/topup.js"></script>
</body></html>`;
}

/** Runs on the top-up page: build Stripe's checkout link, copy the address, go. */
const TOPUP_SCRIPT = String.raw`(function () {
  var p = JSON.parse(document.getElementById("params").textContent);
  var go = document.getElementById("go");
  var said = document.getElementById("said");
  var options = {
    destination_currency: p.currency,
    destination_network: "solana",
    supported_destination_currencies: [p.currency],
    supported_destination_networks: ["solana"]
  };
  // A fees account starts at $5: Stripe's page opens there, not at its own default.
  if (p.amount) options.amount = { source_amount: p.amount };
  else if (p.currency === "sol") options.amount = { source_amount: "5" };
  var link = null;
  try { link = window.StripeOnramp && window.StripeOnramp.Standalone(options).getUrl(); } catch (e) { link = null; }
  if (!link || !/^https:\/\/([a-z0-9-]+\.)*(stripe|link)\.com(\/|\?|$)/.test(link)) {
    said.textContent = "Stripe's checkout didn't load. Check your connection and reload this page.";
    return;
  }
  said.textContent = "";
  go.disabled = false;
  go.addEventListener("click", function () {
    var leave = function () { location.assign(link); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(p.address).then(leave, leave);
    } else { leave(); }
  });
})();`;

// ── Coinbase ─────────────────────────────────────────────────────────────
//
// Coinbase's pages open with everything filled in only through a session that
// Coinbase issues to a server holding a developer key: Amply's own key, the
// only one the relay holds, never anyone's data or money. Two uses: an
// artist buying SOL for their fees account, and an artist cashing out. Each
// request must be signed by the wallet concerned, and the relay keeps nothing.

const COINBASE_HOST = "api.developer.coinbase.com";
const COINBASE_TOKEN_PATH = "/onramp/v1/token";
const COINBASE_PAY = "https://pay.coinbase.com/buy/select-asset";
// SOL for an artist's fees account: a few dollars lasts months.
export const COINBASE_SOL_AMOUNTS = [5, 10];
export type OnrampAsset = "USDC" | "SOL";
// Long enough for a slow phone, short enough that a copied request is soon useless.
const SIGNED_WITHIN_MS = 90_000;

/** What the wallet signs to ask for a Coinbase session. */
export const onrampMessage = (address: string, signedAt: number) =>
  `Amply: add money to ${address} through Coinbase (${signedAt})`;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58, as Solana writes addresses and signatures. Null if it isn't. */
export function unbase58(s: string): Uint8Array | null {
  if (!s || s.length > 120) return null;
  const bytes: number[] = [];
  for (const ch of s) {
    let carry = B58.indexOf(ch);
    if (carry < 0) return null;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const ch of s) { if (ch === "1") bytes.push(0); else break; }
  return new Uint8Array(bytes.reverse());
}

/**
 * Why a request for a Coinbase session is refused, or null. The signature
 * must be the wallet's own, over exactly this message, signed recently.
 */
export async function onrampProblem(body: unknown, now = Date.now()): Promise<string | null> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "body must be an object";
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => !["address", "amount", "signedAt", "signature", "asset"].includes(k));
  if (extra.length) return `unexpected field: ${extra[0]}`;
  const address = typeof b.address === "string" ? b.address : "";
  const key = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) ? unbase58(address) : null;
  if (!key || key.length !== 32) return "not a Solana address";
  if (b.asset !== "SOL") return "only SOL, for a fees account";
  if (!COINBASE_SOL_AMOUNTS.includes(b.amount as number)) return "not an amount offered";
  const signedAt = b.signedAt;
  if (typeof signedAt !== "number" || Math.abs(now - signedAt) > SIGNED_WITHIN_MS) return "the signature is too old";
  return signedBy(key, b.signature, onrampMessage(address, signedAt));
}

/** Whether `signature` (base58) is `key`'s signature over `message`, or why not. */
async function signedBy(key: Uint8Array, signature: unknown, message: string): Promise<string | null> {
  const sig = typeof signature === "string" ? unbase58(signature) : null;
  if (!sig || sig.length !== 64) return "not a signature";
  let good = false;
  try {
    const pub = await crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, ["verify"]);
    good = await crypto.subtle.verify({ name: "Ed25519" }, pub, sig, new TextEncoder().encode(message));
  } catch { good = false; }
  return good ? null : "the signature isn't this wallet's";
}

// ── cashing out (Coinbase Offramp) ─────────────────────────────────────────

const COINBASE_SELL = "https://pay.coinbase.com/v3/sell/input";
const CASHOUT_RETURN = "https://amply.stream/cashout";
// Long enough to open Coinbase after Face ID; the status check is asked for
// while Coinbase's own 30-minute window runs, so it accepts a longer one.
const SELL_SIGNED_WITHIN_MS = 5 * 60_000;
const SELL_STATUS_WITHIN_MS = 45 * 60_000;
export const CASHOUT_MAX_USD = 10_000;

/**
 * What a payout wallet signs to cash out through Coinbase, and to follow it:
 * the amount, and a random `nonce` the editor makes for this one cash-out.
 * The nonce goes into Coinbase's reference for the session (sellRefOf), so
 * the status check finds that session's transaction and no other; and the
 * signature starts one session only (usedSells).
 */
export const sellMessage = (address: string, signedAt: number, nonce: string, amount: number) =>
  `Amply: cash out $${Number(amount).toFixed(2)} from ${address} through Coinbase (${signedAt}, ${nonce})`;

/** A cash-out's nonce: 16 random bytes, as hex. */
export const SELL_NONCE = /^[0-9a-f]{32}$/;

/** The address, if the request is signed by its wallet within `within`; else why not. */
export async function sellProblem(
  q: { address?: unknown; signedAt?: unknown; signature?: unknown; nonce?: unknown; amount?: unknown }, within: number, now = Date.now(),
): Promise<string | null> {
  const address = typeof q.address === "string" ? q.address : "";
  const key = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) ? unbase58(address) : null;
  if (!key || key.length !== 32) return "not a Solana address";
  const signedAt = Number(q.signedAt);
  if (!Number.isSafeInteger(signedAt) || Math.abs(now - signedAt) > within) return "the signature is too old";
  // An editor from before the nonce: its requests could be replayed, so they
  // aren't taken. Updating the editor fixes it.
  if (typeof q.nonce !== "string" || !SELL_NONCE.test(q.nonce)) return "update your Amply editor to cash out (this request has no nonce)";
  const amount = Number(q.amount);
  if (!(amount >= 1 && amount <= CASHOUT_MAX_USD) || Math.round(amount * 100) !== amount * 100) return "cash out at least $1, in whole cents";
  return signedBy(key, q.signature, sellMessage(address, signedAt, q.nonce, amount));
}

/** Coinbase's reference for a wallet: a hash of it, not the wallet itself. */
async function refOf(address: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address)));
  return Array.from(digest.slice(0, 20), (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Coinbase's reference for one cash-out: a hash of the wallet and that
 *  cash-out's nonce, so its transactions are that session's alone. */
export const sellRefOf = (address: string, nonce: string) => refOf(`${address}:${nonce}`);

/**
 * Sell signatures already used to start a session, until they'd be too old
 * anyway: a signature (sent in an address, so it may be seen) can't start a
 * second session. Kept in this copy of the Worker, which Cloudflare may run
 * several of: a short-lived bar, on top of the nonce binding the session.
 */
const usedSells = new Map<string, number>();
function usedSell(signature: string, now: number): boolean {
  const until = usedSells.get(signature);
  return until !== undefined && until > now;
}
/** Marks the signature used; false if it already was (or the set is full). */
export function firstUseOf(signature: string, now = Date.now()): boolean {
  for (const [k, until] of usedSells) if (until <= now) usedSells.delete(k);
  if (usedSells.has(signature)) return false;
  if (usedSells.size >= 10_000) return false;   // under a flood, refuse rather than forget
  usedSells.set(signature, now + 2 * SELL_SIGNED_WITHIN_MS);
  return true;
}

/** A session token from Coinbase for this wallet, USDC on Solana, or why not. */
async function sessionToken(env: Env, address: string, clientIp: string | null, asset: OnrampAsset = "USDC"): Promise<{ token: string } | { status: number; error: string }> {
  const jwt = await coinbaseJwt(env.CDP_KEY_ID!, env.CDP_KEY_SECRET!, "POST", COINBASE_TOKEN_PATH);
  // Coinbase ties the session to the person's connection. Cloudflare sets
  // CF-Connecting-IP itself, so it can't be supplied by the caller.
  const upstream = await fetch(`https://${COINBASE_HOST}${COINBASE_TOKEN_PATH}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      addresses: [{ address, blockchains: ["solana"] }],
      assets: [asset],
      ...(clientIp ? { clientIp } : {}),
    }),
  });
  const json = (await upstream.json().catch(() => null)) as { token?: string; message?: string } | null;
  if (!upstream.ok || !json?.token) {
    return { status: 502, error: `Coinbase didn't start a session${json?.message ? `: ${json.message}` : ""}` };
  }
  return { token: json.token };
}

/** Coinbase's cash-out page for a signed request: USDC on Solana, the amount, back to amply.stream. */
export async function startCashout(env: Env, q: URLSearchParams, clientIp: string | null, now = Date.now()): Promise<{ url: string } | { status: number; error: string }> {
  if (!env.CDP_KEY_ID || !env.CDP_KEY_SECRET) return { status: 503, error: "Coinbase isn't set up here yet" };
  const address = q.get("address") || "";
  const amount = Number(q.get("amount"));
  if (!(amount >= 1 && amount <= CASHOUT_MAX_USD) || Math.round(amount * 100) !== amount * 100) {
    return { status: 400, error: "cash out at least $1, in whole cents" };
  }
  const nonce = q.get("nonce") || "";
  const signature = q.get("signature") || "";
  const problem = await sellProblem({ address, signedAt: q.get("signedAt"), signature, nonce, amount }, SELL_SIGNED_WITHIN_MS, now);
  if (problem) return { status: 403, error: problem };
  const reused = { status: 403, error: "this cash-out was already started; start again from your editor" };
  if (usedSell(signature, now)) return reused;
  if (!(await onrampAllowed(env, `ip:${clientIp || "unknown"}`)) || !(await onrampAllowed(env, `addr:${address}`))) {
    return { status: 429, error: "too many requests; try again in a minute" };
  }
  if (!firstUseOf(signature, now)) return reused;
  const session = await sessionToken(env, address, clientIp);
  if ("error" in session) return session;
  const p = new URLSearchParams({
    sessionToken: session.token,
    partnerUserRef: await sellRefOf(address, nonce),
    redirectUrl: CASHOUT_RETURN,
    defaultNetwork: "solana",
    defaultAsset: "USDC",
    presetCryptoAmount: String(amount),
  });
  return { url: `${COINBASE_SELL}?${p}` };
}

export type CashoutState =
  | { waiting: true }
  | { send: { to: string; micros: number } }
  | { last: "success" | "failed" };

/**
 * Where Coinbase is waiting for this wallet's USDC, once the artist has
 * pressed "Cash out now": its address and the exact amount. Read from
 * Coinbase's own record of that one session (its reference carries the
 * cash-out's nonce), for a signed request only. The editor sends only if the
 * amount is what the artist asked for.
 */
export async function cashoutStatus(env: Env, q: URLSearchParams, now = Date.now()): Promise<CashoutState | { status: number; error: string }> {
  if (!env.CDP_KEY_ID || !env.CDP_KEY_SECRET) return { status: 503, error: "Coinbase isn't set up here yet" };
  const address = q.get("address") || "";
  const nonce = q.get("nonce") || "";
  const problem = await sellProblem({ address, signedAt: q.get("signedAt"), signature: q.get("signature"), nonce, amount: q.get("amount") }, SELL_STATUS_WITHIN_MS, now);
  if (problem) return { status: 403, error: problem };
  // That session's transactions alone: its reference carries the nonce.
  const path = `/onramp/v1/sell/user/${await sellRefOf(address, nonce)}/transactions`;
  const jwt = await coinbaseJwt(env.CDP_KEY_ID, env.CDP_KEY_SECRET, "GET", path, now);
  const res = await fetch(`https://${COINBASE_HOST}${path}?page_size=5`, { headers: { Authorization: `Bearer ${jwt}` } });
  const json = (await res.json().catch(() => null)) as { transactions?: Record<string, unknown>[] } | null;
  if (!res.ok || !Array.isArray(json?.transactions)) return { status: 502, error: "Coinbase didn't answer" };
  const newest = json.transactions[0];
  if (!newest) return { waiting: true };
  const status = String(newest.status || "");
  if (status === "TRANSACTION_STATUS_SUCCESS") return { last: "success" };
  if (status === "TRANSACTION_STATUS_FAILED") return { last: "failed" };
  const to = String(newest.to_address || "");
  const micros = Math.round(Number(newest.sell_amount) * 1_000_000);
  const solana = /solana/i.test(String(newest.network || ""));
  const usdc = String(newest.asset || "").toUpperCase() === "USDC";
  const toKey = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to) ? unbase58(to) : null;
  // Only an exact, sendable request comes back; anything else waits.
  if (status !== "TRANSACTION_STATUS_STARTED" || !solana || !usdc || !toKey || toKey.length !== 32
    || !Number.isSafeInteger(micros) || micros < 10_000 || micros > CASHOUT_MAX_USD * 1_000_000) return { waiting: true };
  return { send: { to, micros } };
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlText = (text: string) => b64url(new TextEncoder().encode(text));

/** The PKCS#8 wrapper for a raw Ed25519 seed, which WebCrypto needs to import it. */
const ED25519_PKCS8 = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];

/**
 * A two-minute token for one Coinbase API call, signed with Amply's key, as
 * Coinbase documents: EdDSA, the key's name as `kid` and `sub`, and the call
 * it is for in `uri`.
 */
export async function coinbaseJwt(keyId: string, keySecret: string, method: string, path: string, now = Date.now()): Promise<string> {
  const raw = Uint8Array.from(atob(keySecret.trim()), (c) => c.charCodeAt(0));
  if (raw.length !== 64) throw new Error("the Coinbase key secret should be a base64 Ed25519 key");
  const pkcs8 = new Uint8Array(ED25519_PKCS8.length + 32);
  pkcs8.set(ED25519_PKCS8);
  pkcs8.set(raw.slice(0, 32), ED25519_PKCS8.length);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(8)), (x) => x.toString(16).padStart(2, "0")).join("");
  const t = Math.floor(now / 1000);
  const head = b64urlText(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: keyId, nonce }));
  const body = b64urlText(JSON.stringify({
    sub: keyId, iss: "cdp", aud: ["cdp_service"], nbf: t, exp: t + 120,
    uri: `${method} ${COINBASE_HOST}${path}`,
  }));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

/** Coinbase's page for this session: SOL on Solana, in this amount. The artist's
 *  editor lives at its own address, which Coinbase can't know in advance, so
 *  Coinbase shows its own "done" page. */
export async function onrampUrl(token: string, address: string, amount: number): Promise<string> {
  const q = new URLSearchParams({
    sessionToken: token,
    defaultNetwork: "solana",
    defaultAsset: "SOL",
    presetFiatAmount: String(amount),
    fiatCurrency: "USD",
    partnerUserRef: await refOf(address),
  });
  return `${COINBASE_PAY}?${q}`;
}

/** A Coinbase session for a signed request, or why not. */
async function startOnramp(env: Env, body: unknown, clientIp: string | null): Promise<{ url: string } | { status: number; error: string }> {
  if (!env.CDP_KEY_ID || !env.CDP_KEY_SECRET) return { status: 503, error: "Coinbase isn't set up here yet" };
  const problem = await onrampProblem(body);
  if (problem) return { status: 403, error: problem };
  const { address, amount } = body as { address: string; amount: number };
  // Per connection and per wallet, so neither many wallets from one place
  // nor one wallet from many places can mint sessions without end.
  if (!(await onrampAllowed(env, `ip:${clientIp || "unknown"}`)) || !(await onrampAllowed(env, `addr:${address}`))) {
    return { status: 429, error: "too many requests; try again in a minute" };
  }
  const session = await sessionToken(env, address, clientIp, "SOL");
  if ("error" in session) return session;
  return { url: await onrampUrl(session.token, address, amount) };
}

/** An artist's node on workers.dev: `<worker>.<subdomain>.workers.dev`, nothing else. */
export const NODE_HOST = /^[a-z0-9-]{1,63}\.[a-z0-9-]{1,63}\.workers\.dev$/;

/**
 * Whether an editor's Cloudflare sign-in is ready for the artist: its
 * /manage sends to an Access login page, and that page is there.
 */
export async function signInReady(host: string | null): Promise<{ ready: boolean }> {
  if (!host || !NODE_HOST.test(host)) return { ready: false };
  try {
    const gate = await fetch(`https://${host}/manage`, { redirect: "manual" });
    const to = gate.status >= 300 && gate.status < 400 ? gate.headers.get("Location") : null;
    if (!to) return { ready: false };
    const login = new URL(to);
    if (login.protocol !== "https:" || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(login.hostname)
        || login.pathname !== `/cdn-cgi/access/login/${host}`) {
      return { ready: false };
    }
    const page = await fetch(login.toString(), { redirect: "manual" });
    return { ready: page.status === 200 };
  } catch {
    return { ready: false };
  }
}

/** A plain page for a person who followed a link: what went wrong, nothing else. */
function page(status: number, text: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><p>${escapeHtml(text)}.</p>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } },
  );
}

const seeOther = (location: string) =>
  new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });

function allowedOrigin(req: Request, env: Env): string | null {
  const origin = req.headers.get("Origin");
  if (!origin) return null;
  const list = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : null;
}

function cors(origin: string | null, extra?: HeadersInit): Headers {
  const h = new Headers(extra);
  if (origin) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Vary", "Origin");
  }
  h.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  h.set("Access-Control-Max-Age", "86400");
  return h;
}

function refuse(status: number, message: string, origin: string | null): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: cors(origin, { "Content-Type": "application/json" }),
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = allowedOrigin(request, env);

    // The top-up page is opened as a page, not called by one, so it carries
    // no Origin and is served to anyone: it holds and receives nothing.
    if (request.method === "GET" && url.pathname === "/topup") {
      const params = topupParams(url);
      const headers = {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": TOPUP_CSP,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      };
      if (typeof params === "string") {
        return new Response(`<!doctype html><meta charset="utf-8"><p>${escapeHtml(params)}.</p>`, { status: 400, headers });
      }
      return new Response(topupPage(params), { status: 200, headers });
    }
    if (request.method === "GET" && url.pathname === "/topup.js") {
      return new Response(TOPUP_SCRIPT, {
        headers: { "Content-Type": "text/javascript; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=300" },
      });
    }

    // SOL for an artist's fees account. The editor opens this as a page (its
    // own policy lets it reach nothing but its node), with the node's
    // signature for the fees account; the answer is a redirect to Coinbase.
    if (request.method === "GET" && url.pathname === "/coinbase/sol") {
      const q = url.searchParams;
      const body = {
        address: q.get("address") ?? "", amount: Number(q.get("amount")), signedAt: Number(q.get("signedAt")),
        signature: q.get("signature") ?? "", asset: "SOL",
      };
      const started = await startOnramp(env, body, request.headers.get("CF-Connecting-IP"));
      if ("error" in started) return page(started.status, started.error);
      return seeOther(started.url);
    }


    // Cashing out through Coinbase: a page the artist's editor opens, and the
    // check the artist's node makes for where to send (server to server, so
    // no Origin; the wallet's signature is what's checked).
    if (request.method === "GET" && url.pathname === "/coinbase/sell") {
      const started = await startCashout(env, url.searchParams, request.headers.get("CF-Connecting-IP"));
      if ("error" in started) return page(started.status, started.error);
      return seeOther(started.url);
    }
    if (request.method === "GET" && url.pathname === "/coinbase/sell/status") {
      const state = await cashoutStatus(env, url.searchParams);
      const body = "error" in state ? { error: state.error } : state;
      return new Response(JSON.stringify(body), {
        status: "error" in state ? state.status : 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    if (request.method === "OPTIONS") {
      if (!origin) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    // Browsers always send Origin on cross-origin requests. No match, no service.
    if (!origin) return refuse(403, "origin not allowed", null);

    // ── token exchange ────────────────────────────────────────────────────
    if (url.pathname === "/token" && request.method === "POST") {
      const body = await request.text();

      // Enforce the no-standing-access rule here as well as at the call site,
      // so a mistake upstream cannot quietly create a durable credential.
      const params = new URLSearchParams(body);
      if (params.get("grant_type") === "refresh_token") {
        return refuse(400, "refresh tokens are not used", origin);
      }
      if ((params.get("scope") ?? "").split(/\s+/).includes("offline_access")) {
        return refuse(400, "offline_access is not requested", origin);
      }

      const upstream = await fetch(TOKEN, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });

      const text = await upstream.text();

      // If Cloudflare ever returns a refresh token unasked, drop it rather than
      // hand the browser a durable credential.
      let payload = text;
      try {
        const json = JSON.parse(text);
        if (json && typeof json === "object" && "refresh_token" in json) {
          delete json.refresh_token;
          payload = JSON.stringify(json);
        }
      } catch {
        /* not JSON — pass through untouched */
      }

      return new Response(payload, {
        status: upstream.status,
        headers: cors(origin, { "Content-Type": "application/json" }),
      });
    }

    // ── token revocation ──────────────────────────────────────────────────
    // Called when provisioning finishes, so the token is dead before the
    // artist has closed the tab rather than merely forgotten.
    if (url.pathname === "/revoke" && request.method === "POST") {
      const upstream = await fetch(REVOKE, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: await request.text(),
      });
      return new Response(null, { status: upstream.status, headers: cors(origin) });
    }

    // ── a temporary account ───────────────────────────────────────────────
    // ── is a new editor's sign-in working yet? ────────────────────────────
    // Setup adds Cloudflare Access to the editor, and for a few minutes after,
    // Cloudflare's login page for it answers "Unable to find your Access
    // application". Setup waits for it before sending the artist there, and
    // can't look itself: both pages are other sites. Read-only and narrow:
    // only an editor on workers.dev, and only the Access login it sends to.
    if (url.pathname === "/ready" && request.method === "GET") {
      return new Response(JSON.stringify(await signInReady(url.searchParams.get("host"))), {
        headers: cors(origin, { "Content-Type": "application/json", "Cache-Control": "no-store" }),
      });
    }

    // ── Cloudflare API ────────────────────────────────────────────────────
    if (url.pathname.startsWith("/api/")) {
      const path = url.pathname.slice("/api".length);

      if (!ALLOWED.some((r) => r.method === request.method && r.pattern.test(path))) {
        return refuse(403, `not a permitted path: ${request.method} ${path}`, origin);
      }

      const auth = request.headers.get("Authorization");
      if (!auth) return refuse(401, "missing authorization", origin);

      /**
       * Creating an identity provider is the most dangerous thing the granted
       * scopes permit: a SAML or OIDC provider would let whoever configured it
       * authenticate as the artist across everything Access protects on that
       * account.
       *
       * Amply needs exactly one kind — one-time PIN, which mails a code to an
       * address the artist already controls and adds no new trust relationship.
       * So the relay reads the body and refuses anything else. The scope
       * permits more than this; the relay does not.
       */
      let forwardBody: BodyInit | null | undefined =
        request.method === "GET" ? undefined : request.body;

      if (request.method === "POST" && /\/access\/identity_providers$/.test(path)) {
        const raw = await request.text();
        let parsed: { type?: unknown };
        try {
          parsed = JSON.parse(raw);
        } catch {
          return refuse(400, "identity provider body must be JSON", origin);
        }
        if (parsed?.type !== "onetimepin") {
          return refuse(403, "only the one-time PIN identity provider is permitted", origin);
        }
        // One-time PIN takes no configuration. Anything in `config` would be
        // settings for a provider type we do not permit in the first place.
        const config = (parsed as { config?: unknown }).config;
        if (config && typeof config === "object" && Object.keys(config).length > 0) {
          return refuse(403, "the one-time PIN provider takes no configuration", origin);
        }
        forwardBody = raw;
      }

      if (request.method === "PUT" && /\/workers\/domains$/.test(path)) {
        const raw = await request.text();
        let parsed: { hostname?: unknown; service?: unknown; override_existing_dns_record?: unknown };
        try {
          parsed = JSON.parse(raw);
        } catch {
          return refuse(400, "domain body must be JSON", origin);
        }
        const host = String(parsed?.hostname || "");
        if (!/^[a-z0-9-]+(\.[a-z0-9-]+){2,}$/.test(host) || /\.(workers|pages)\.dev$/.test(host)) {
          return refuse(403, "only a subdomain of the artist's own domain may be attached", origin);
        }
        if (!/^[a-z0-9-]{1,63}$/.test(String(parsed?.service || ""))) {
          return refuse(403, "not a Worker name", origin);
        }
        // Replacing whatever already answers at a hostname is how an artist's
        // website would be overwritten. Setup never asks for it; nor may
        // anything else through here.
        if (parsed.override_existing_dns_record) {
          return refuse(403, "existing DNS records are never overwritten", origin);
        }
        forwardBody = raw;
      }

      const headers = new Headers({ Authorization: auth });
      const ct = request.headers.get("Content-Type");
      if (ct) headers.set("Content-Type", ct);

      const upstream = await fetch(API + path + url.search, {
        method: request.method,
        headers,
        body: forwardBody,
      });

      const out = cors(origin);
      const upstreamType = upstream.headers.get("Content-Type");
      if (upstreamType) out.set("Content-Type", upstreamType);

      return new Response(upstream.body, { status: upstream.status, headers: out });
    }

    return refuse(404, "not found", origin);
  },
} satisfies ExportedHandler<Env>;
