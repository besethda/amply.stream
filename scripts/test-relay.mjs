/**
 * The relay's KV routes.
 *
 * The relay is what stands between "Amply forwards a few setup calls" and
 * "Amply runs an open proxy to the Cloudflare API". These hold the new routes
 * to the same line as the old ones: exactly the calls setup makes, with
 * exactly the bodies it sends.
 *
 *   node --experimental-strip-types scripts/test-relay.mjs
 */
const { default: relay } = await import("../relay/src/index.ts");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

const ORIGIN = "https://amply.stream";
const env = { ALLOWED_ORIGINS: ORIGIN };
let sent = [];
globalThis.fetch = async (url, init = {}) => {
  sent.push({ url: String(url), init });
  return new Response(JSON.stringify({ success: true, result: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
};
const call = (path, { method = "POST", body, headers = {}, origin = ORIGIN } = {}) => {
  sent = [];
  return relay.fetch(new Request(`https://relay.test${path}`, {
    method, body, headers: { ...(origin ? { Origin: origin } : {}), ...headers },
  }), env);
};

// ── is a new editor's sign-in working yet? ──────────────────────────────────
{
  const HOST = "hollow.coast.workers.dev";
  const LOGIN = `https://hollow-x1.cloudflareaccess.com/cdn-cgi/access/login/${HOST}?kid=k&redirect_url=%2Fmanage`;
  const real = globalThis.fetch;
  const world = (gate, login) => {
    globalThis.fetch = async (u) => {
      sent.push({ url: String(u) });
      if (String(u) === `https://${HOST}/manage`) return new Response(null, gate);
      return new Response("", { status: login });
    };
  };
  const ready = async (host = HOST, origin = ORIGIN) => {
    sent = [];
    const res = await relay.fetch(new Request(`https://relay.test/ready?host=${encodeURIComponent(host)}`, { headers: origin ? { Origin: origin } : {} }), env);
    return res.status === 200 ? (await res.json()).ready : `HTTP ${res.status}`;
  };
  world({ status: 302, headers: { Location: LOGIN } }, 200);
  ok("ready once the editor sends to a login page that's there", await ready() === true);
  ok("  having asked only the editor and its login page", sent.length === 2 && sent[1].url === LOGIN);
  world({ status: 302, headers: { Location: LOGIN } }, 404);
  ok("not while Cloudflare can't find the application yet", await ready() === false);
  world({ status: 503 }, 200);
  ok("not while the editor isn't behind a sign-in yet", await ready() === false);
  world({ status: 302, headers: { Location: `https://evil.test/cdn-cgi/access/login/${HOST}` } }, 200);
  ok("a redirect anywhere but Cloudflare Access isn't followed", await ready() === false && sent.length === 1);
  world({ status: 302, headers: { Location: "https://hollow-x1.cloudflareaccess.com/cdn-cgi/access/login/other.host.workers.dev" } }, 200);
  ok("  nor a login page for some other host", await ready() === false && sent.length === 1);
  ok("only a node on workers.dev is asked about", await ready("example.com") === false && sent.length === 0);
  ok("  not one dressed up as one", await ready("a.b.workers.dev.evil.test") === false && sent.length === 0);
  ok("another site may not ask", await ready(HOST, "https://evil.test") === "HTTP 403");
  globalThis.fetch = real;
}

// ── KV, for a node with no R2 ───────────────────────────────────────────────
{
  const acc = "0123456789abcdef0123456789abcdef";
  const ns = "fedcba9876543210fedcba9876543210";
  const auth = { Authorization: "Bearer t" };
  const status = async (method, path) => (await call(`/api${path}`, { method, headers: auth, body: method === "GET" ? undefined : "x" })).status;

  ok("a rebuild may read what a service is wired to", await status("GET", `/accounts/${acc}/workers/scripts/hollow/settings`) === 200);
  ok("  but not change it", await status("PATCH", `/accounts/${acc}/workers/scripts/hollow/settings`) === 403
    && await status("PUT", `/accounts/${acc}/workers/scripts/hollow/settings`) === 403);
  ok("KV namespaces can be listed", await status("GET", `/accounts/${acc}/storage/kv/namespaces`) === 200);
  ok("  and made", await status("POST", `/accounts/${acc}/storage/kv/namespaces`) === 200);
  ok("a file can be written, its key encoded", await status("PUT", `/accounts/${acc}/storage/kv/namespaces/${ns}/values/manage%2Findex.html`) === 200);
  ok("  but not with traversal", await status("PUT", `/accounts/${acc}/storage/kv/namespaces/${ns}/values/..%2Fsecret`) === 403);
  ok("  nor encoded traversal", await status("PUT", `/accounts/${acc}/storage/kv/namespaces/${ns}/values/%2e%2e%2Fsecret`) === 403);
  ok("  nor encoded dots in mixed case", await status("PUT", `/accounts/${acc}/storage/kv/namespaces/${ns}/values/%2e%2E`) === 403);
  ok("  nor a key that is only a dot", await status("PUT", `/accounts/${acc}/storage/kv/namespaces/${ns}/values/.`) === 403);
  ok("KV can't be read back through here", await status("GET", `/accounts/${acc}/storage/kv/namespaces/${ns}/values/manage%2Findex.html`) === 403);
  ok("  nor deleted", await status("DELETE", `/accounts/${acc}/storage/kv/namespaces/${ns}/values/x`) === 403);
  ok("  nor a namespace removed", await status("DELETE", `/accounts/${acc}/storage/kv/namespaces/${ns}`) === 403);
}

// ── the card top-up page ────────────────────────────────────────────────────
{
  const ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  const page = (q) => relay.fetch(new Request(`https://relay.test/topup?${q}`), env);

  const res = await page(`address=${ADDR}&currency=usdc&amount=20`);
  const html = await res.text();
  ok("the top-up page opens with no Origin, as a page does", res.status === 200);
  ok("  shows the address to paste", html.includes(ADDR));
  ok("  says how much, and in what", html.includes("$20 of USDC"));
  const csp = res.headers.get("Content-Security-Policy") || "";
  ok("  allows only its own script and Stripe's", /script-src 'self' https:\/\/crypto-js\.stripe\.com\/crypto-onramp-outer\.js(;|$)/.test(csp), csp);
  ok("  and no inline script at all", !/unsafe-inline[^;]*;?/.test(csp.split("; ").find((d) => d.startsWith("script-src")) || ""));
  ok("  sends no referrer to Stripe", res.headers.get("Referrer-Policy") === "no-referrer");
  ok("  and can't be framed", csp.includes("frame-ancestors 'none'"));
  ok("  and isn't cached", res.headers.get("Cache-Control") === "no-store");

  const refused = async (name, q) => ok(name, (await page(q)).status === 400);
  await refused("an address that isn't one is refused", "address=not-an-address");
  await refused("  as is markup posing as one", `address=${encodeURIComponent('<script>x</script>')}`);
  await refused("an amount that isn't offered is refused", `address=${ADDR}&amount=1000000`);
  await refused("a currency that isn't USDC or SOL is refused", `address=${ADDR}&currency=btc`);
  ok("SOL can be bought too, in any amount", (await page(`address=${ADDR}&currency=sol`)).status === 200);

  // Run the page's script against a stand-in for Stripe's, in a fake page.
  const js = await (await relay.fetch(new Request("https://relay.test/topup.js"), env)).text();
  const params = JSON.parse(html.match(/<script id="params" type="application\/json">(.*?)<\/script>/s)[1]);
  const run = (getUrl, given = params) => {
    const els = {
      params: { textContent: JSON.stringify(given) },
      go: { disabled: true, listeners: {}, addEventListener(t, f) { this.listeners[t] = f; } },
      said: { textContent: "Loading" },
    };
    let asked = null, went = null, copied = null;
    const window = { StripeOnramp: { Standalone: (o) => { asked = o; return { getUrl }; } } };
    const document = { getElementById: (id) => els[id] };
    const location = { assign: (u) => { went = u; } };
    const navigator = { clipboard: { writeText: (t) => { copied = t; return Promise.resolve(); } } };
    new Function("window", "document", "location", "navigator", js)(window, document, location, navigator);
    return { els, asked: () => asked, went: () => went, copied: () => copied };
  };

  const good = run(() => "https://crypto.link.com/?ref=x");
  ok("the script asks Stripe for USDC on Solana only", JSON.stringify(good.asked()?.supported_destination_networks) === '["solana"]'
    && good.asked()?.destination_currency === "usdc" && good.asked()?.amount?.source_amount === "20");
  ok("  and enables the button once it has a link", good.els.go.disabled === false);
  await good.els.go.listeners.click();
  await new Promise((r) => setTimeout(r, 0));
  ok("  which copies the address", good.copied() === ADDR);
  ok("  and goes to Stripe", good.went() === "https://crypto.link.com/?ref=x");

  const fees = run(() => "https://crypto.link.com/?ref=x", { address: ADDR, currency: "sol", amount: null });
  ok("a fees account opens Stripe at $5 of SOL, not Stripe's own $10", fees.asked()?.destination_currency === "sol" && fees.asked()?.amount?.source_amount === "5");
  ok("  and the page says what $1 covers, not \"months\"", /covers ~1,000 payments/.test(await (await page(`address=${ADDR}&currency=sol`)).text()));

  const bare = run(() => "https://crypto.link.com?ref=x");
  ok("  a link with no path is still Stripe's", bare.els.go.disabled === false);
  const lookalike = run(() => "https://link.com.evil.test/");
  ok("  but one that only starts like it isn't", lookalike.els.go.disabled === true);
  const bad = run(() => "https://evil.test/phish");
  ok("a link that isn't Stripe's is never followed", bad.els.go.disabled === true && /didn't load/.test(bad.els.said.textContent));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
