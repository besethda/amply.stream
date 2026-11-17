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
 * Cloudflare's terms for a temporary account. The artist accepts these on
 * Amply's setup page before the account is made, and the request must name
 * exactly these: an acceptance of anything else is not an acceptance.
 */
const TEMPORARY_TERMS = {
  termsOfService: "https://www.cloudflare.com/terms/",
  privacyPolicy: "https://www.cloudflare.com/privacypolicy/",
};

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

/**
 * Why a request to create a temporary account is refused, or null.
 *
 * Exactly the fields Cloudflare takes and nothing else, the terms named
 * exactly, and acceptance stated. The relay cannot see whether the artist
 * really ticked the box (setup won't send this until they have); what it can
 * do is make sure this route only ever does the one thing it exists for.
 */
export function temporaryAccountProblem(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "body must be an object";
  const b = body as Record<string, unknown>;
  const expected = ["termsOfService", "privacyPolicy", "acceptTermsOfService", "challengeToken", "solution"];
  const extra = Object.keys(b).filter((k) => !expected.includes(k));
  if (extra.length) return `unexpected field: ${extra[0]}`;
  if (b.termsOfService !== TEMPORARY_TERMS.termsOfService || b.privacyPolicy !== TEMPORARY_TERMS.privacyPolicy) {
    return "the terms must be Cloudflare's own";
  }
  if (b.acceptTermsOfService !== "yes") return "the terms must be accepted";
  if (typeof b.challengeToken !== "string" || !b.challengeToken || b.challengeToken.length > 4096) {
    return "not a challenge token";
  }
  const solution = b.solution as Record<string, unknown> | null;
  if (!solution || typeof solution !== "object" || Object.keys(solution).join() !== "checkpoints") {
    return "the solution must be checkpoints and nothing else";
  }
  // k + 1 SHA-256 checkpoints, Base64. Wrangler caps k * g at 64 million, so
  // even k alone stays far below this.
  const cp = solution.checkpoints;
  if (typeof cp !== "string" || cp.length > 1_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cp)) {
    return "the checkpoints must be Base64";
  }
  return null;
}

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
  const what = p.currency === "usdc"
    ? `${p.amount ? `$${p.amount} of ` : ""}USDC`
    : "a little SOL, the currency that pays payment fees ($1 is plenty)";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Add money - Amply</title></head>
<body style="font:18px/1.5 system-ui,sans-serif;max-width:34rem;margin:0 auto;padding:32px 16px;color:#1b1813;background:#fbf8f3">
<p style="font-weight:800;letter-spacing:-0.02em;margin:0 0 18px">amply</p>
<h1 style="font-size:28px;margin:0 0 12px">Add money to your Amply wallet</h1>
<p style="margin:0 0 16px">You're buying ${escapeHtml(what)} by card, through Stripe.${p.currency === "usdc" ? " USDC is a digital dollar: $1 of it is worth $1." : ""} Three steps:</p>
<ol style="margin:0 0 20px;padding-left:22px">
<li>Press the button below. We copy your wallet's address, and Stripe's page opens.</li>
<li>When Stripe asks where to send it, paste the address. If it asks for a network, choose <b>Solana</b>.</li>
<li>Pay by card. The first time, Stripe may ask for ID. Then go back to the Amply app.</li>
</ol>
<p style="background:#fff3e8;border:1px solid #f4c9a8;border-radius:12px;padding:12px 16px;margin:0 0 16px;font-size:16px">
<b>Check this is your wallet.</b> Your Amply app shows the last four characters of yours under Top up. They must match
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
  if (p.amount) options.amount = { source_amount: p.amount };
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

// ── adding money through Coinbase ────────────────────────────────────────
//
// Coinbase's onramp opens with everything filled in (the listener's wallet,
// USDC on Solana, the amount) only through a session that Coinbase issues to
// a server holding a developer key. That is this route, and the only key the
// relay holds. It is Amply's own key, never anyone's data or money, and the
// relay still keeps nothing: each call asks Coinbase for a single-use,
// five-minute session and hands back the link.
//
// Coinbase asks that sessions be issued only to real users. Here that means
// the request comes from Amply's own site (checked like every other route)
// and is signed by the wallet the money will go to, within five minutes.

const COINBASE_HOST = "api.developer.coinbase.com";
const COINBASE_TOKEN_PATH = "/onramp/v1/token";
const COINBASE_PAY = "https://pay.coinbase.com/buy/select-asset";
const COINBASE_RETURN = "https://amply.stream/app/?added=coinbase";
export const COINBASE_AMOUNTS = [20, 30, 60];
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
  const extra = Object.keys(b).filter((k) => !["address", "amount", "signedAt", "signature"].includes(k));
  if (extra.length) return `unexpected field: ${extra[0]}`;
  const address = typeof b.address === "string" ? b.address : "";
  const key = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) ? unbase58(address) : null;
  if (!key || key.length !== 32) return "not a Solana address";
  if (!COINBASE_AMOUNTS.includes(b.amount as number)) return "not an amount offered";
  const signedAt = b.signedAt;
  if (typeof signedAt !== "number" || Math.abs(now - signedAt) > SIGNED_WITHIN_MS) return "the signature is too old";
  const sig = typeof b.signature === "string" ? unbase58(b.signature) : null;
  if (!sig || sig.length !== 64) return "not a signature";
  let good = false;
  try {
    const pub = await crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, ["verify"]);
    good = await crypto.subtle.verify({ name: "Ed25519" }, pub, sig, new TextEncoder().encode(onrampMessage(address, signedAt)));
  } catch { good = false; }
  return good ? null : "the signature isn't this wallet's";
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

/** Coinbase's page for this session: USDC on Solana, the amount, and the way back. */
export async function onrampUrl(token: string, address: string, amount: number): Promise<string> {
  // Coinbase's reference for the person, for looking up the transaction
  // later: a hash of the wallet, not the wallet itself, and nothing else.
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address)));
  const ref = Array.from(digest.slice(0, 20), (x) => x.toString(16).padStart(2, "0")).join("");
  const q = new URLSearchParams({
    sessionToken: token,
    defaultNetwork: "solana",
    defaultAsset: "USDC",
    presetFiatAmount: String(amount),
    fiatCurrency: "USD",
    partnerUserRef: ref,
    redirectUrl: COINBASE_RETURN,
  });
  return `${COINBASE_PAY}?${q}`;
}

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
    const origin = allowedOrigin(request, env);
    const url = new URL(request.url);

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

    if (request.method === "OPTIONS") {
      if (!origin) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    // Browsers always send Origin on cross-origin requests. No match, no service.
    if (!origin) return refuse(403, "origin not allowed", null);

    // ── Coinbase ──────────────────────────────────────────────────────────
    const coinbaseReady = !!(env.CDP_KEY_ID && env.CDP_KEY_SECRET);
    if (url.pathname === "/coinbase/status" && request.method === "GET") {
      return new Response(JSON.stringify({ enabled: coinbaseReady, amounts: COINBASE_AMOUNTS }), {
        headers: cors(origin, { "Content-Type": "application/json", "Cache-Control": "no-store" }),
      });
    }
    if (url.pathname === "/coinbase/onramp" && request.method === "POST") {
      if (!coinbaseReady) return refuse(503, "Coinbase isn't set up here yet", origin);
      let body: unknown;
      try { body = JSON.parse(await request.text()); } catch { return refuse(400, "body must be JSON", origin); }
      const problem = await onrampProblem(body);
      if (problem) return refuse(403, problem, origin);
      const { address, amount } = body as { address: string; amount: number };
      // Per connection and per wallet, so neither many wallets from one place
      // nor one wallet from many places can mint sessions without end.
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      if (!(await onrampAllowed(env, `ip:${ip}`)) || !(await onrampAllowed(env, `addr:${address}`))) {
        return refuse(429, "too many requests; try again in a minute", origin);
      }

      const jwt = await coinbaseJwt(env.CDP_KEY_ID!, env.CDP_KEY_SECRET!, "POST", COINBASE_TOKEN_PATH);
      // Coinbase ties the session to the listener's connection. Cloudflare
      // sets this header itself, so it can't be supplied by the caller.
      const clientIp = request.headers.get("CF-Connecting-IP");
      const upstream = await fetch(`https://${COINBASE_HOST}${COINBASE_TOKEN_PATH}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          addresses: [{ address, blockchains: ["solana"] }],
          assets: ["USDC"],
          ...(clientIp ? { clientIp } : {}),
        }),
      });
      const json = (await upstream.json().catch(() => null)) as { token?: string; message?: string } | null;
      if (!upstream.ok || !json?.token) {
        return refuse(502, `Coinbase didn't start a session${json?.message ? `: ${json.message}` : ""}`, origin);
      }
      return new Response(JSON.stringify({ url: await onrampUrl(json.token, address, amount) }), {
        headers: cors(origin, { "Content-Type": "application/json", "Cache-Control": "no-store" }),
      });
    }

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
    // Cloudflare can make an account before the artist has one: a proof-of-
    // work, the artist's acceptance of Cloudflare's terms, and back comes a
    // temporary account, its token, and a link that makes it theirs. Claiming
    // it ends that token, so this keeps no more access than OAuth does.
    //
    // Neither call takes a credential, and neither is forwarded with one. The
    // response holds the temporary token and the claim link, and passes
    // through in memory like everything else here.
    if (url.pathname === "/preview/challenge" && request.method === "POST") {
      const upstream = await fetch(`${API}/provisioning/previews/challenge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: cors(origin, { "Content-Type": "application/json" }),
      });
    }

    if (url.pathname === "/preview/account" && request.method === "POST") {
      const raw = await request.text();
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return refuse(400, "body must be JSON", origin);
      }
      const problem = temporaryAccountProblem(parsed);
      if (problem) return refuse(403, problem, origin);
      const upstream = await fetch(`${API}/provisioning/previews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: raw,
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: cors(origin, { "Content-Type": "application/json" }),
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
