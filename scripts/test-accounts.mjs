/**
 * accounts/: the temporary Cloudflare account, made off Cloudflare.
 *
 * Cloudflare refuses to make these accounts for a Worker, so this one route
 * lives on another host. It is held to the line the relay held it to:
 * exactly the two calls setup makes, with exactly the bodies it sends, and
 * nothing for any other site.
 *
 *   node scripts/test-accounts.mjs
 */
import { handle, temporaryAccountProblem } from "../accounts/preview.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

const ORIGIN = "https://amply.stream";
let sent = [];
globalThis.fetch = async (url, init = {}) => {
  sent.push({ url: String(url), init });
  return new Response(JSON.stringify({ success: true, result: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
};
const call = (path, { method = "POST", body, headers = {}, origin = ORIGIN } = {}) => {
  sent = [];
  return handle(new Request(`https://accounts.test${path}`, {
    method, body, headers: { ...(origin ? { Origin: origin } : {}), ...headers },
  }), {});
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
  ok("  and nothing caches it", res.headers.get("Cache-Control") === "no-store");
  ok("a GET is not a challenge", (await call("/preview/challenge", { method: "GET" })).status === 405 && sent.length === 0);
  ok("another site may not ask", (await call("/preview/challenge", { origin: "https://evil.test" })).status === 403 && sent.length === 0);
  ok("nor a request with no origin", (await call("/preview/challenge", { origin: null })).status === 403);
  ok("a preflight from amply.stream is answered", (await call("/preview/account", { method: "OPTIONS" })).status === 204);
  ok("  and one from anywhere else is not", (await call("/preview/account", { method: "OPTIONS", origin: "https://evil.test" })).status === 403);
  ok("any other path is nothing", (await call("/preview/other", { body: "{}" })).status === 404 && sent.length === 0);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
