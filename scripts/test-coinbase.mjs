/**
 * The relay's Coinbase route.
 *
 * It holds the only key the relay has, so it is held to a narrow job: a
 * session for a wallet that signed for it, from Amply's own site, for USDC on
 * Solana, in an amount Amply offers. Real Ed25519 keys throughout, so the
 * signature and token checks are the real ones.
 *
 *   node --experimental-strip-types scripts/test-coinbase.mjs
 */
const { default: relay, onrampMessage, onrampProblem, unbase58, coinbaseJwt } = await import("../relay/src/index.ts");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = "1" + out; else break; }
  return out;
}
const b64urlDecode = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

// A listener's wallet.
const wallet = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const address = base58(new Uint8Array(await crypto.subtle.exportKey("raw", wallet.publicKey)));
const signFor = async (text, key = wallet.privateKey) =>
  base58(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(text))));

// Amply's Coinbase key, in the shape Coinbase issues: base64 of seed + public key.
const cdp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const cdpPkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", cdp.privateKey));
const cdpPub = new Uint8Array(await crypto.subtle.exportKey("raw", cdp.publicKey));
const cdpSecret = btoa(String.fromCharCode(...cdpPkcs8.slice(-32), ...cdpPub));

const ORIGIN = "https://amply.stream";
const configured = { ALLOWED_ORIGINS: ORIGIN, CDP_KEY_ID: "organizations/test/apiKeys/key1", CDP_KEY_SECRET: cdpSecret };
const bare = { ALLOWED_ORIGINS: ORIGIN };

let sent = [];
let reply = { status: 200, body: { token: "SESSION-TOKEN" } };
globalThis.fetch = async (url, init = {}) => {
  sent.push({ url: String(url), init });
  return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
};
const call = (path, { method = "POST", body, env = configured, origin = ORIGIN, headers = {} } = {}) => {
  sent = [];
  return relay.fetch(new Request(`https://relay.test${path}`, {
    method, body, headers: { ...(origin ? { Origin: origin } : {}), ...headers },
  }), env);
};

// ── Coinbase's session, for an artist's fees account ───────────────────────
{
  const app = await import("../app/src/topup.js");
  const at = Date.now();
  sent = [];
  const res = await relay.fetch(new Request(app.coinbaseSolPage(address, 5, at, await signFor(onrampMessage(address, at))).replace(app.RELAY, "https://relay.test"),
    { headers: { "CF-Connecting-IP": "203.0.113.7" } }), configured);
  ok("a signed request gets a Coinbase session", res.status === 303, String(res.status));
  const up = sent[0];
  ok("Coinbase is asked at its token endpoint", up?.url === "https://api.developer.coinbase.com/onramp/v1/token");
  const asked = JSON.parse(up?.init.body || "{}");
  ok("  for exactly this wallet, on Solana", asked.addresses?.length === 1 && asked.addresses[0].address === address && asked.addresses[0].blockchains.join() === "solana");
  ok("  and only SOL", asked.assets?.join() === "SOL");
  ok("  tied to the artist's connection", asked.clientIp === "203.0.113.7");
  ok("  with nothing else in it", Object.keys(asked).sort().join() === "addresses,assets,clientIp");

  const jwt = new Headers(up?.init.headers).get("Authorization")?.replace(/^Bearer /, "") || "";
  const [h, p, sig] = jwt.split(".");
  const head = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
  ok("  signed as Coinbase documents (EdDSA, the key's name)", head.alg === "EdDSA" && head.kid === configured.CDP_KEY_ID && claims.sub === configured.CDP_KEY_ID && claims.iss === "cdp");
  ok("  for this one call", claims.uri === "POST api.developer.coinbase.com/onramp/v1/token");
  ok("  for two minutes", claims.exp - claims.nbf === 120);
  const verified = await crypto.subtle.verify({ name: "Ed25519" }, cdp.publicKey, b64urlDecode(sig), new TextEncoder().encode(`${h}.${p}`));
  ok("  and the signature is the key's own", verified);

  reply = { status: 401, body: { message: "Unauthorized" } };
  const bad = await relay.fetch(new Request(app.coinbaseSolPage(address, 5, at, await signFor(onrampMessage(address, at))).replace(app.RELAY, "https://relay.test")), configured);
  ok("if Coinbase refuses, that is passed on plainly", bad.status === 502 && /Unauthorized/.test(await bad.text()));
  reply = { status: 200, body: { token: "SESSION-TOKEN" } };

  const old = await call("/coinbase/onramp", { body: "{}" });
  ok("listeners' Coinbase route is gone", old.status !== 200 && sent.length === 0);
  ok("  and so is its status", (await call("/coinbase/status", { method: "GET" })).status !== 200);
}

// ── SOL for an artist's fees account, opened as a page from the editor ─────
{
  const app = await import("../app/src/topup.js");
  const solPage = async ({ amount = 5, signedAt = Date.now(), signature, ip = "203.0.113.9" } = {}) => {
    const href = app.coinbaseSolPage(address, amount, signedAt, signature ?? (await signFor(onrampMessage(address, signedAt))));
    sent = [];
    return relay.fetch(new Request(href.replace(app.RELAY, "https://relay.test"), { headers: { "CF-Connecting-IP": ip } }), configured);
  };
  const res = await solPage();
  ok("the node's signed page goes straight to Coinbase", res.status === 303, String(res.status));
  const link = new URL(res.headers.get("Location") || "about:blank");
  ok("  to buy SOL on Solana, $5", link.origin === "https://pay.coinbase.com" && link.searchParams.get("defaultAsset") === "SOL" && link.searchParams.get("presetFiatAmount") === "5");
  ok("  with no return address Coinbase couldn't know", !link.searchParams.has("redirectUrl"));
  const asked = JSON.parse(sent[0]?.init.body || "{}");
  ok("  Coinbase is asked for SOL only, for this wallet", asked.assets?.join() === "SOL" && asked.addresses?.[0]?.address === address);
  ok("  tied to the artist's own connection", asked.clientIp === "203.0.113.9");
  ok("  and the address isn't passed on to Coinbase's page", res.headers.get("Referrer-Policy") === "no-referrer");

  const stale = await solPage({ signedAt: Date.now() - 10 * 60_000 });
  ok("an old signature gets a page saying so, not Coinbase", stale.status === 403 && sent.length === 0 && /too old/.test(await stale.text()));
  const big = await solPage({ amount: 30 });
  ok("more SOL than offered is refused", big.status === 403 && sent.length === 0);
  const forged = await solPage({ signature: await signFor(onrampMessage(address, Date.now()), (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign"])).privateKey) });
  ok("someone else's signature is refused", forged.status === 403 && sent.length === 0);
  const off = await relay.fetch(new Request(app.coinbaseSolPage(address, 5, Date.now(), "x").replace(app.RELAY, "https://relay.test")), bare);
  ok("without a key, it says Coinbase isn't set up", off.status === 503);

}

// ── cashing out through Coinbase (Offramp) ─────────────────────────────────
{
  const app = await import("../app/src/topup.js");
  const relayMod = await import("../relay/src/index.ts");
  const NONCE = app.sellNonce();
  ok("the editor signs exactly the words the relay checks to cash out", app.sellMessage(address, 99, NONCE, 25) === relayMod.sellMessage(address, 99, NONCE, 25));
  ok("  naming the amount and this cash-out's nonce", app.sellMessage(address, 99, NONCE, 25).includes("$25.00") && app.sellMessage(address, 99, NONCE, 25).includes(NONCE));
  ok("  a fresh nonce each time, of the shape the relay takes", app.sellNonce() !== NONCE && relayMod.SELL_NONCE.test(NONCE));
  const signed = async (signedAt = Date.now(), key, { nonce = app.sellNonce(), amount = 25 } = {}) =>
    ({ signedAt, nonce, amount, signature: await signFor(relayMod.sellMessage(address, signedAt, nonce, amount), key) });
  const open = async ({ amount = 25, signedAt, signature, env = configured, s: given, href: hrefGiven, signedAmount } = {}) => {
    const s = given ?? await signed(signedAt, undefined, { amount: signedAmount ?? amount });
    const href = hrefGiven ?? app.coinbaseCashoutPage(address, amount, s.signedAt, signature ?? s.signature, s.nonce);
    sent = [];
    return relay.fetch(new Request(href.replace(app.RELAY, "https://relay.test"), { headers: { "CF-Connecting-IP": `203.0.113.${Math.floor(Math.random() * 200) + 20}` } }), env);
  };
  reply = { status: 200, body: { token: "SELL-TOKEN" } };
  const res = await open();
  ok("a signed cash-out goes to Coinbase's cash-out page", res.status === 303, String(res.status));
  const to = new URL(res.headers.get("Location") || "about:blank");
  ok("  pay.coinbase.com/v3/sell", to.origin === "https://pay.coinbase.com" && to.pathname === "/v3/sell/input");
  ok("  USDC on Solana, the amount asked for", to.searchParams.get("defaultAsset") === "USDC" && to.searchParams.get("defaultNetwork") === "solana"
    && to.searchParams.get("presetCryptoAmount") === "25");
  ok("  back to amply.stream afterwards", to.searchParams.get("redirectUrl") === "https://amply.stream/cashout");
  ok("  naming the wallet only by a hash", /^[0-9a-f]{40}$/.test(to.searchParams.get("partnerUserRef") || ""));
  const asked = JSON.parse(sent[0]?.init.body || "{}");
  ok("  Coinbase is asked for this wallet's USDC on Solana", asked.addresses?.[0]?.address === address && asked.assets?.join() === "USDC");
  {
    // Cloudflare's per-wallet limit is counted elsewhere; not what's tested here.
    const unlimited = { ...configured, ONRAMP_LIMIT: { limit: async () => ({ success: true }) } };
    const s = await signed();
    reply = { status: 200, body: { token: "SELL-TOKEN" } };
    const first = await open({ s, env: unlimited });
    const ref = new URL(first.headers.get("Location")).searchParams.get("partnerUserRef");
    const other = await signed();
    const second = new URL((await open({ s: other, env: unlimited })).headers.get("Location")).searchParams.get("partnerUserRef");
    ok("  a reference of its own for each cash-out (its nonce), not one per wallet", ref !== second && /^[0-9a-f]{40}$/.test(second));
    const again = await open({ s, env: unlimited });
    ok("the same signature can't start a second session", again.status === 403 && sent.length === 0, String(again.status));
    const legacy = `https://relay.test/coinbase/sell?${new URLSearchParams({ address, amount: "25", signedAt: String(s.signedAt), signature: await signFor(`Amply: cash out from ${address} through Coinbase (${s.signedAt})`) })}`;
    ok("a request from an editor before the nonce is refused", (await open({ href: legacy, env: unlimited })).status === 403 && sent.length === 0);
    ok("a signature for another amount is refused", (await open({ amount: 25, signedAmount: 26, env: unlimited })).status === 403 && sent.length === 0);
  }

  ok("an old signature is refused", (await open({ signedAt: Date.now() - 10 * 60_000 })).status === 403 && sent.length === 0);
  ok("someone else's signature is refused", (await open({ signature: (await signed(Date.now(), (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign"])).privateKey)).signature })).status === 403);
  ok("less than a dollar is refused", (await open({ amount: 0.5 })).status === 400);
  ok("fractions of a cent are refused", (await open({ amount: 1.005 })).status === 400);
  ok("without Amply's key it says Coinbase isn't set up", (await open({ env: bare })).status === 503);

  // Where to send, once the artist has pressed "Cash out now".
  let lastStatusNonce = null;
  const status = async ({ signedAt = Date.now(), transactions = [], code = 200, nonce } = {}) => {
    const s = await signed(signedAt, undefined, nonce ? { nonce } : {});
    lastStatusNonce = s.nonce;
    reply = { status: code, body: { transactions } };
    sent = [];
    const r = await relay.fetch(new Request(`https://relay.test/coinbase/sell/status?${new URLSearchParams({ address, signedAt: String(s.signedAt), signature: s.signature, nonce: s.nonce, amount: String(s.amount) })}`), configured);
    return { r, json: await r.json() };
  };
  const coinbaseAddress = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const started = { status: "TRANSACTION_STATUS_STARTED", asset: "USDC", network: "solana", sell_amount: "25.00", to_address: coinbaseAddress };
  let { r, json } = await status({ transactions: [started] });
  ok("Coinbase's waiting cash-out comes back as where and how much to send", r.status === 200 && json.send?.to === coinbaseAddress && json.send?.micros === 25_000_000, JSON.stringify(json));
  const call = sent[0];
  ok("  asked of Coinbase's sell transactions for this wallet's reference", /\/onramp\/v1\/sell\/user\/[0-9a-f]{40}\/transactions\?page_size=5$/.test(call?.url || ""), call?.url);
  {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${address}:${lastStatusNonce}`)));
    const exact = Array.from(digest.slice(0, 20), (x) => x.toString(16).padStart(2, "0")).join("");
    ok("  for exactly that cash-out's reference (wallet and nonce)", (call?.url || "").includes(`/sell/user/${exact}/`), call?.url);
  }
  ok("  with a token for exactly that GET", (() => {
    const jwt = new Headers(call?.init.headers).get("Authorization")?.replace(/^Bearer /, "") || "";
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(jwt.split(".")[1] || "")));
    return /^GET api\.developer\.coinbase\.com\/onramp\/v1\/sell\/user\/[0-9a-f]{40}\/transactions$/.test(claims.uri);
  })());
  ({ json } = await status());
  ok("nothing yet: waiting", json.waiting === true);
  ({ json } = await status({ transactions: [{ ...started, network: "ethereum" }] }));
  ok("anything but USDC on Solana: still waiting, never sent", json.waiting === true && !json.send);
  ({ json } = await status({ transactions: [{ ...started, to_address: "0xabc" }] }));
  ok("an address that isn't Solana's: never sent", json.waiting === true);
  ({ json } = await status({ transactions: [{ ...started, sell_amount: "abc" }] }));
  ok("an amount that isn't a number: never sent", json.waiting === true);
  ({ json } = await status({ transactions: [{ status: "TRANSACTION_STATUS_SUCCESS" }] }));
  ok("a finished cash-out says so", json.last === "success");
  ({ json } = await status({ transactions: [{ status: "TRANSACTION_STATUS_FAILED" }] }));
  ok("  and a failed one", json.last === "failed");
  ({ r } = await status({ signedAt: Date.now() - 60 * 60_000, transactions: [started] }));
  ok("a signature over 45 minutes old can't ask", r.status === 403 && sent.length === 0);
  ({ r } = await status({ code: 500 }));
  ok("Coinbase not answering is passed on, not guessed", r.status === 502);
  ({ r } = await (async () => {
    reply = { status: 200, body: { transactions: [started] } };
    sent = [];
    const s = await signed();
    const q = new URLSearchParams({ address, signedAt: String(s.signedAt), signature: s.signature, amount: "25" });
    return { r: await relay.fetch(new Request(`https://relay.test/coinbase/sell/status?${q}`), configured) };
  })());
  ok("a status check without the nonce is refused, and Coinbase isn't asked", r.status === 403 && sent.length === 0);
  reply = { status: 200, body: { token: "SESSION-TOKEN" } };

  // The editor sends only exactly what the artist entered, to a Solana address.
  ok("the editor sends what Coinbase asks when it's the amount entered", app.cashoutProblem({ to: coinbaseAddress, micros: 25_000_000 }, 25_000_000) === null);
  ok("  and refuses another amount", /\$30\.00, not the \$25\.00/.test(app.cashoutProblem({ to: coinbaseAddress, micros: 30_000_000 }, 25_000_000) || ""));
  ok("  or an address that isn't Solana's", /Solana address/.test(app.cashoutProblem({ to: "0xabc", micros: 25_000_000 }, 25_000_000) || ""));
  ok("  or anything when it doesn't know what was entered", app.cashoutProblem({ to: coinbaseAddress, micros: 25_000_000 }, undefined) !== null);
}

// ── the pieces ──────────────────────────────────────────────────────────────
ok("base58 reads a Solana address as 32 bytes", unbase58(address)?.length === 32);
ok("and refuses what isn't base58", unbase58("0OIl") === null);
ok("a malformed address is refused", (await onrampProblem({ address: "not-an-address", amount: 5, asset: "SOL", signedAt: Date.now(), signature: "x" })) === "not a Solana address");
ok("only SOL, for a fees account", (await onrampProblem({ address, amount: 30, asset: "USDC", signedAt: Date.now(), signature: "x" })) === "only SOL, for a fees account");
let threw = false;
try { await coinbaseJwt("k", btoa("short"), "POST", "/x"); } catch { threw = true; }
ok("a key secret of the wrong shape is refused, not used", threw);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
