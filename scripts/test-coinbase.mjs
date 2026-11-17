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

const request = async (over = {}) => {
  const signedAt = over.signedAt ?? Date.now();
  const amount = over.amount ?? 30;
  return { address, amount, signedAt, signature: over.signature ?? (await signFor(onrampMessage(address, signedAt))), ...over.extra };
};

// ── whether it's offered ────────────────────────────────────────────────────
{
  const on = await (await call("/coinbase/status", { method: "GET" })).json();
  ok("with a key set, Coinbase is offered", on.enabled === true && on.amounts.includes(30));
  const off = await (await call("/coinbase/status", { method: "GET", env: bare })).json();
  ok("without one, it isn't", off.enabled === false);
  ok("another site may not ask", (await call("/coinbase/status", { method: "GET", origin: "https://evil.test" })).status === 403);
}

// ── a good request ──────────────────────────────────────────────────────────
{
  const res = await call("/coinbase/onramp", { body: JSON.stringify(await request()), headers: { "CF-Connecting-IP": "203.0.113.7" } });
  const json = await res.json();
  ok("a signed request gets a Coinbase link", res.status === 200 && json.url?.startsWith("https://pay.coinbase.com/buy/select-asset?"), JSON.stringify(json));
  const link = new URL(json.url);
  ok("  with Coinbase's session", link.searchParams.get("sessionToken") === "SESSION-TOKEN");
  ok("  for USDC on Solana", link.searchParams.get("defaultNetwork") === "solana" && link.searchParams.get("defaultAsset") === "USDC");
  ok("  in the amount asked for", link.searchParams.get("presetFiatAmount") === "30" && link.searchParams.get("fiatCurrency") === "USD");
  ok("  and back to the app afterwards", link.searchParams.get("redirectUrl") === "https://amply.stream/app/?added=coinbase");
  const ref = link.searchParams.get("partnerUserRef");
  ok("  naming the person only by a hash, not their wallet", ref && ref.length < 50 && ref !== address && !ref.includes(address));

  const up = sent[0];
  ok("Coinbase is asked at its token endpoint", up?.url === "https://api.developer.coinbase.com/onramp/v1/token");
  const asked = JSON.parse(up?.init.body || "{}");
  ok("  for exactly this wallet, on Solana", asked.addresses?.length === 1 && asked.addresses[0].address === address && asked.addresses[0].blockchains.join() === "solana");
  ok("  and only USDC", asked.assets?.join() === "USDC");
  ok("  tied to the listener's connection", asked.clientIp === "203.0.113.7");
  ok("  with nothing else in it", Object.keys(asked).sort().join() === "addresses,assets,clientIp");

  const jwt = new Headers(up?.init.headers).get("Authorization")?.replace(/^Bearer /, "") || "";
  const [h, p, s] = jwt.split(".");
  const head = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
  ok("  signed as Coinbase documents (EdDSA, the key's name)", head.alg === "EdDSA" && head.kid === configured.CDP_KEY_ID && claims.sub === configured.CDP_KEY_ID && claims.iss === "cdp");
  ok("  for this one call", claims.uri === "POST api.developer.coinbase.com/onramp/v1/token");
  ok("  for two minutes", claims.exp - claims.nbf === 120);
  const verified = await crypto.subtle.verify({ name: "Ed25519" }, cdp.publicKey, b64urlDecode(s), new TextEncoder().encode(`${h}.${p}`));
  ok("  and the signature is the key's own", verified);
}

// ── refusals ────────────────────────────────────────────────────────────────
{
  const refused = async (name, body, expect = 403) => {
    const res = await call("/coinbase/onramp", { body: typeof body === "string" ? body : JSON.stringify(body) });
    ok(name, res.status === expect && sent.length === 0, `${res.status}, ${sent.length} sent`);
  };
  await refused("someone else's signature is refused", await request({ signature: await signFor(onrampMessage(address, Date.now()), (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign"])).privateKey) }));
  const at = Date.now();
  await refused("a signature over different words is refused", await request({ signedAt: at, signature: await signFor(`Amply: add money to ${address} (${at})`) }));
  await refused("an old signature is refused", await request({ signedAt: Date.now() - 10 * 60_000 }));
  await refused("an amount Amply doesn't offer is refused", await request({ amount: 1000 }));
  await refused("an extra field is refused", await request({ extra: { blockchains: ["ethereum"] } }));
  await refused("a body that isn't JSON is refused", "address=x", 400);
  const res = await call("/coinbase/onramp", { body: JSON.stringify(await request()), origin: "https://evil.test" });
  ok("another site may not ask for a session", res.status === 403 && sent.length === 0);
  const off = await call("/coinbase/onramp", { body: JSON.stringify(await request()), env: bare });
  ok("without a key, it says Coinbase isn't set up", off.status === 503 && sent.length === 0);

  reply = { status: 401, body: { message: "Unauthorized" } };
  const bad = await call("/coinbase/onramp", { body: JSON.stringify(await request()) });
  ok("if Coinbase refuses, that is passed on plainly", bad.status === 502 && /Unauthorized/.test((await bad.json()).error));
  reply = { status: 200, body: { token: "SESSION-TOKEN" } };
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
  ok("the app offers the relay's SOL amounts", app.COINBASE_SOL_AMOUNTS.join() === (await import("../relay/src/index.ts")).COINBASE_SOL_AMOUNTS.join());

  const amply = await call("/coinbase/onramp", { body: JSON.stringify({ ...(await request({ amount: 10 })), asset: "SOL" }) });
  ok("Amply's own site may ask for SOL by the usual route too", amply.status === 200);
  const eth = await call("/coinbase/onramp", { body: JSON.stringify({ ...(await request()), asset: "ETH" }) });
  ok("only USDC or SOL", eth.status === 403 && sent.length === 0);
}

// ── cashing out through Coinbase (Offramp) ─────────────────────────────────
{
  const app = await import("../app/src/topup.js");
  const relayMod = await import("../relay/src/index.ts");
  ok("the editor signs exactly the words the relay checks to cash out", app.sellMessage(address, 99) === relayMod.sellMessage(address, 99));
  const signed = async (signedAt = Date.now(), key) => ({ signedAt, signature: await signFor(relayMod.sellMessage(address, signedAt), key) });
  const open = async ({ amount = 25, signedAt, signature, env = configured } = {}) => {
    const s = await signed(signedAt);
    const href = app.coinbaseCashoutPage(address, amount, s.signedAt, signature ?? s.signature);
    sent = [];
    return relay.fetch(new Request(href.replace(app.RELAY, "https://relay.test"), { headers: { "CF-Connecting-IP": "203.0.113.4" } }), env);
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

  ok("an old signature is refused", (await open({ signedAt: Date.now() - 10 * 60_000 })).status === 403 && sent.length === 0);
  ok("someone else's signature is refused", (await open({ signature: (await signed(Date.now(), (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign"])).privateKey)).signature })).status === 403);
  ok("less than a dollar is refused", (await open({ amount: 0.5 })).status === 400);
  ok("fractions of a cent are refused", (await open({ amount: 1.005 })).status === 400);
  ok("without Amply's key it says Coinbase isn't set up", (await open({ env: bare })).status === 503);

  // Where to send, once the artist has pressed "Cash out now".
  const status = async ({ signedAt = Date.now(), transactions = [], code = 200 } = {}) => {
    const s = await signed(signedAt);
    reply = { status: code, body: { transactions } };
    sent = [];
    const r = await relay.fetch(new Request(`https://relay.test/coinbase/sell/status?${new URLSearchParams({ address, signedAt: String(s.signedAt), signature: s.signature })}`), configured);
    return { r, json: await r.json() };
  };
  const coinbaseAddress = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const started = { status: "TRANSACTION_STATUS_STARTED", asset: "USDC", network: "solana", sell_amount: "25.00", to_address: coinbaseAddress };
  let { r, json } = await status({ transactions: [started] });
  ok("Coinbase's waiting cash-out comes back as where and how much to send", r.status === 200 && json.send?.to === coinbaseAddress && json.send?.micros === 25_000_000, JSON.stringify(json));
  const call = sent[0];
  ok("  asked of Coinbase's sell transactions for this wallet's reference", /\/onramp\/v1\/sell\/user\/[0-9a-f]{40}\/transactions\?page_size=5$/.test(call?.url || ""), call?.url);
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
  reply = { status: 200, body: { token: "SESSION-TOKEN" } };
}

// ── the app and the relay agree ─────────────────────────────────────────────
{
  const app = await import("../app/src/topup.js");
  ok("the app signs exactly the words the relay checks", app.onrampMessage(address, 1234) === onrampMessage(address, 1234));
  ok("  and offers the same amounts", app.COINBASE_AMOUNTS.join() === (await (await call("/coinbase/status", { method: "GET" })).json()).amounts.join());
  let asked = null;
  const link = await app.coinbaseLink(address, 30, (text) => signFor(text), {
    fetchFn: async (url, init) => { asked = { url, body: JSON.parse(init.body) }; return relay.fetch(new Request(url.replace(app.RELAY, "https://relay.test"), { ...init, headers: { ...init.headers, Origin: ORIGIN } }), configured); },
  });
  ok("a link made by the app's own code is accepted by the relay", link.startsWith("https://pay.coinbase.com/"), link);
  ok("  and the app sends nothing but address, amount, time and signature", Object.keys(asked.body).sort().join() === "address,amount,signature,signedAt");
}

// ── the pieces ──────────────────────────────────────────────────────────────
ok("base58 reads a Solana address as 32 bytes", unbase58(address)?.length === 32);
ok("and refuses what isn't base58", unbase58("0OIl") === null);
ok("a malformed address is refused", (await onrampProblem(await request({ extra: { address: "not-an-address" } }))) === "not a Solana address");
let threw = false;
try { await coinbaseJwt("k", btoa("short"), "POST", "/x"); } catch { threw = true; }
ok("a key secret of the wrong shape is refused, not used", threw);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
