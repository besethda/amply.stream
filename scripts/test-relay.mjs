/**
 * The relay's new routes: a temporary account, and KV.
 *
 * The relay is what stands between "Amply forwards a few setup calls" and
 * "Amply runs an open proxy to the Cloudflare API". These hold the new routes
 * to the same line as the old ones: exactly the calls setup makes, with
 * exactly the bodies it sends.
 *
 *   node --experimental-strip-types scripts/test-relay.mjs
 */
const { default: relay, temporaryAccountProblem } = await import("../relay/src/index.ts");

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

const good = {
  termsOfService: "https://www.cloudflare.com/terms/",
  privacyPolicy: "https://www.cloudflare.com/privacypolicy/",
  acceptTermsOfService: "yes",
  challengeToken: "tok.en",
  solution: { checkpoints: "AAAA" },
};

// ── the challenge ───────────────────────────────────────────────────────────
{
  const res = await call("/preview/challenge", { body: JSON.stringify({ anything: "at all" }) });
  ok("a challenge is fetched", res.status === 200);
  ok("  from Cloudflare's provisioning endpoint", sent[0]?.url === "https://api.cloudflare.com/client/v4/provisioning/previews/challenge");
  ok("  with an empty body, whatever was sent", sent[0]?.init.body === "{}");
  ok("  and no credential", !new Headers(sent[0]?.init.headers).has("Authorization"));
  ok("  and the browser may read the answer", res.headers.get("Access-Control-Allow-Origin") === ORIGIN);
  ok("a GET is not a challenge", (await call("/preview/challenge", { method: "GET" })).status === 404);
  ok("another site may not ask", (await call("/preview/challenge", { origin: "https://evil.test" })).status === 403);
}

// ── making the account ──────────────────────────────────────────────────────
{
  const res = await call("/preview/account", { body: JSON.stringify(good) });
  ok("an account request with accepted terms is forwarded", res.status === 200 && sent[0]?.url.endsWith("/provisioning/previews"));
  ok("  exactly as sent", sent[0]?.init.body === JSON.stringify(good));
  ok("  with no credential", !new Headers(sent[0]?.init.headers).has("Authorization"));

  const refused = async (name, body) => {
    const r = await call("/preview/account", { body: typeof body === "string" ? body : JSON.stringify(body) });
    ok(name, r.status >= 400 && sent.length === 0, `HTTP ${r.status}`);
  };
  await refused("terms not accepted: refused, and nothing reaches Cloudflare", { ...good, acceptTermsOfService: "no" });
  await refused("someone else's terms: refused", { ...good, termsOfService: "https://evil.test/terms" });
  await refused("an extra field: refused", { ...good, accountName: "mine" });
  await refused("a solution with more in it: refused", { ...good, solution: { checkpoints: "AAAA", extra: 1 } });
  await refused("checkpoints that aren't Base64: refused", { ...good, solution: { checkpoints: "<script>" } });
  await refused("no challenge token: refused", { ...good, challengeToken: "" });
  await refused("not JSON: refused", "terms=yes");
  ok("the same rules, directly", temporaryAccountProblem(good) === null && temporaryAccountProblem([]) !== null);
}

// ── KV, for a node with no R2 ───────────────────────────────────────────────
{
  const acc = "0123456789abcdef0123456789abcdef";
  const ns = "fedcba9876543210fedcba9876543210";
  const auth = { Authorization: "Bearer t" };
  const status = async (method, path) => (await call(`/api${path}`, { method, headers: auth, body: method === "GET" ? undefined : "x" })).status;

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
