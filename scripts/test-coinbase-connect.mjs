/**
 * "Connect Coinbase": the relay sends an artist to Coinbase's sign-in, then
 * turns the answer into a Solana USDC deposit address for their editor. A fake
 * Coinbase answers the calls; the state, PKCE and redirects are the real ones.
 *
 *   node --experimental-strip-types scripts/test-coinbase-connect.mjs
 */
const { default: relay } = await import("../relay/src/index.ts");
const { readState, makeState, isSolanaAddress, CONNECT_SCOPES } = await import("../relay/src/coinbase-connect.ts");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

const env = { ALLOWED_ORIGINS: "https://amply.stream", COINBASE_CLIENT_ID: "client-1", COINBASE_CLIENT_SECRET: "secret-1" };
const HOST = "amply-node.someone.workers.dev";
const NONCE = "n0nce-abcdefghijklmnop";
const SOL_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const RELAY = "https://relay.test";

// ── a fake Coinbase ─────────────────────────────────────────────────────────
let calls = [];
let coinbase = {};
const reset = (over = {}) => {
  calls = [];
  coinbase = {
    token: { status: 200, body: { access_token: "ACCESS", token_type: "bearer", expires_in: 3600 } },
    accounts: [{ data: [{ id: "btc-1", currency: { code: "BTC" } }], pagination: { next_uri: "/v2/accounts?starting_after=btc-1" } },
      { data: [{ id: "usdc-1", currency: { code: "USDC" }, type: "wallet" }], pagination: { next_uri: null } }],
    address: { status: 201, body: { data: { address: SOL_ADDRESS, network: "solana" } } },
    ...over,
  };
};
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = init.body ? String(init.body) : "";
  calls.push({ url: u, method: init.method || "GET", headers: new Headers(init.headers), body });
  const json = (status, b) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  if (u === "https://login.coinbase.com/oauth2/token") return json(coinbase.token.status, coinbase.token.body);
  if (u === "https://login.coinbase.com/oauth2/revoke") return json(200, {});
  if (u.startsWith("https://api.coinbase.com/v2/accounts?") || u === "https://api.coinbase.com/v2/accounts?limit=100") {
    const page = u.includes("starting_after") ? 1 : 0;
    return json(200, coinbase.accounts[page] || { data: [] });
  }
  if (u === "https://api.coinbase.com/v2/accounts/usdc-1/addresses") return json(coinbase.address.status, coinbase.address.body);
  return json(404, {});
};

const get = (path, e = env) => relay.fetch(new Request(`${RELAY}${path}`, { headers: { "CF-Connecting-IP": "203.0.113.5" } }), e);
const fragment = (res) => {
  const to = new URL(res.headers.get("Location"));
  return { to, f: new URLSearchParams(to.hash.slice(1)) };
};

// ── the start ───────────────────────────────────────────────────────────────
let state;
{
  reset();
  const res = await get(`/coinbase/connect?host=${HOST}&nonce=${NONCE}`);
  ok("Connect Coinbase goes to Coinbase's sign-in", res.status === 303);
  const to = new URL(res.headers.get("Location"));
  ok("  at login.coinbase.com", to.origin === "https://login.coinbase.com" && to.pathname === "/oauth2/auth");
  ok("  as Amply's app, coming back to the relay", to.searchParams.get("client_id") === "client-1"
    && to.searchParams.get("redirect_uri") === `${RELAY}/coinbase/connected`);
  ok("  asking only to read accounts and make an address", to.searchParams.get("scope") === CONNECT_SCOPES
    && !/send|offline_access|withdraw|sell|buy/.test(CONNECT_SCOPES));
  ok("  with PKCE", to.searchParams.get("code_challenge_method") === "S256" && to.searchParams.get("code_challenge")?.length === 43);
  state = to.searchParams.get("state");
  const read = await readState("secret-1", state);
  ok("  and a signed state naming this editor and nonce", read?.host === HOST && read?.nonce === NONCE);
  ok("  that no other secret accepts", (await readState("secret-2", state)) === null);
  ok("nothing is asked of Coinbase yet", calls.length === 0);

  ok("a host that isn't an artist's editor is refused", (await get(`/coinbase/connect?host=evil.test&nonce=${NONCE}`)).status === 400);
  ok("  nor a lookalike", (await get(`/coinbase/connect?host=a.b.workers.dev.evil.test&nonce=${NONCE}`)).status === 400);
  ok("a missing nonce is refused", (await get(`/coinbase/connect?host=${HOST}`)).status === 400);
  ok("without Amply's OAuth app, it says so", (await get(`/coinbase/connect?host=${HOST}&nonce=${NONCE}`, { ALLOWED_ORIGINS: "x" })).status === 503);
}

// ── Coinbase's answer ───────────────────────────────────────────────────────
{
  reset();
  const res = await get(`/coinbase/connected?code=CODE&state=${encodeURIComponent(state)}`);
  ok("an approved sign-in comes back to the editor", res.status === 303, String(res.status));
  const { to, f } = fragment(res);
  ok("  the same editor, at /manage", to.origin === `https://${HOST}` && to.pathname === "/manage");
  ok("  with the new Solana USDC address and the editor's nonce", f.get("coinbase") === SOL_ADDRESS && f.get("nonce") === NONCE);
  ok("  in the fragment, which never reaches a server", to.search === "");

  const tokenCall = calls.find((c) => c.url.endsWith("/oauth2/token"));
  const sent = new URLSearchParams(tokenCall?.body || "");
  ok("the code is exchanged with the PKCE verifier", sent.get("grant_type") === "authorization_code" && sent.get("code") === "CODE"
    && sent.get("code_verifier")?.length === 43 && sent.get("redirect_uri") === `${RELAY}/coinbase/connected`);
  const made = calls.find((c) => c.url.endsWith("/addresses"));
  ok("an address is made in the USDC account, on Solana", made?.method === "POST" && JSON.parse(made.body).network === "solana");
  ok("  found on the second page of accounts", calls.filter((c) => c.url.includes("/v2/accounts?")).length === 2);
  ok("  calls carry the access token and API version", made?.headers.get("Authorization") === "Bearer ACCESS" && !!made?.headers.get("CB-VERSION"));
  ok("the access is revoked straight after", calls.at(-1)?.url === "https://login.coinbase.com/oauth2/revoke"
    && new URLSearchParams(calls.at(-1).body).get("token") === "ACCESS");
  ok("only Coinbase was called", calls.every((c) => /^https:\/\/(login|api)\.coinbase\.com\//.test(c.url)));
}

// ── things going wrong ──────────────────────────────────────────────────────
const back = async (query, over) => {
  reset(over);
  const res = await get(`/coinbase/connected?${query}`);
  return { res, ...(res.status === 303 ? fragment(res) : {}) };
};
{
  const q = `code=CODE&state=${encodeURIComponent(state)}`;
  let r = await back(`error=access_denied&state=${encodeURIComponent(state)}`);
  ok("declining comes back saying nothing changed", /didn't approve/.test(r.f.get("coinbase-error")) && !r.f.has("coinbase") && calls.length === 0);
  r = await back(q, { accounts: [{ data: [{ id: "btc-1", currency: { code: "BTC" } }], pagination: {} }] });
  ok("no USDC wallet: says how to open one", /no USDC wallet/.test(r.f.get("coinbase-error")) && calls.at(-1).url.endsWith("/revoke"));
  r = await back(q, { address: { status: 201, body: { data: { address: "0x1234567890abcdef1234567890abcdef12345678", network: "ethereum" } } } });
  ok("an address that isn't Solana's is never passed on", !r.f.has("coinbase") && !!r.f.get("coinbase-error"));
  r = await back(q, { token: { status: 401, body: { error: "invalid_grant" } } });
  ok("a code Coinbase won't exchange: an error, nothing more asked", !!r.f.get("coinbase-error") && calls.length === 1);
  r = await back(`code=CODE&state=${encodeURIComponent(state.replace(/.$/, (c) => (c === "A" ? "B" : "A")))}`);
  ok("a tampered state goes nowhere", r.res.status === 400 && calls.length === 0);
  const old = await makeState("secret-1", HOST, NONCE, Date.now() - 20 * 60_000);
  r = await back(`code=CODE&state=${encodeURIComponent(old)}`);
  ok("an old state goes nowhere", r.res.status === 400 && calls.length === 0);
  const elsewhere = await makeState("secret-1", "evil.test", NONCE);
  ok("  nor one naming a host that isn't an editor", (await readState("secret-1", elsewhere)) === null);
}

// ── the editor's half, end to end ──────────────────────────────────────────
{
  const editor = await import("../manage/src/coinbase.js");
  const { RELAY: LIVE_RELAY } = await import("../app/src/topup.js");
  const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  const store = memory();
  const link = editor.connectLink({ host: HOST, store });
  ok("the editor opens the relay's connect page for itself", link.startsWith(`${LIVE_RELAY}/coinbase/connect?`) && new URL(link).searchParams.get("host") === HOST);
  reset();
  const start = await get(new URL(link).pathname + new URL(link).search);
  const st = new URL(start.headers.get("Location")).searchParams.get("state");
  reset();
  const done = await get(`/coinbase/connected?code=CODE&state=${encodeURIComponent(st)}`);
  const landed = new URL(done.headers.get("Location"));
  let cleared = false;
  ok("back in the editor, the answer is taken", editor.takeCoinbaseAnswer({ hash: landed.hash, store, clear: () => { cleared = true; } }) === true && cleared);
  const answer = editor.readCoinbaseAnswer({ store });
  ok("  and handed over once: the new address", answer?.address === SOL_ADDRESS && editor.readCoinbaseAnswer({ store }) === null);
  ok("  remembered as the Coinbase address on this device", editor.isCoinbaseAddress(SOL_ADDRESS, { store }) && !editor.isCoinbaseAddress("other", { store }));
  ok("  and the same answer can't be used twice", editor.takeCoinbaseAnswer({ hash: landed.hash, store, clear: () => {} }) === false);

  const victim = memory();
  editor.connectLink({ host: HOST, store: victim });
  const forged = `#coinbase=${SOL_ADDRESS}&nonce=guessed-nonce-123456`;
  ok("a link someone sends the artist, without their nonce, is ignored", editor.takeCoinbaseAnswer({ hash: forged, store: victim, clear: () => {} }) === false
    && editor.readCoinbaseAnswer({ store: victim }) === null && !editor.isCoinbaseAddress(SOL_ADDRESS, { store: victim }));
  const nobody = memory();
  ok("  and so is any answer nobody here asked for", editor.takeCoinbaseAnswer({ hash: forged, store: nobody, clear: () => {} }) === false);
}

// ── the pieces ──────────────────────────────────────────────────────────────
ok("a Solana address is 32 bytes of base58", isSolanaAddress(SOL_ADDRESS) && !isSolanaAddress("111") && !isSolanaAddress("0x12") && !isSolanaAddress(5));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
