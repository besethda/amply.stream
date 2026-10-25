/**
 * Prove a node can start life in a temporary Cloudflare account.
 *
 * Cloudflare can now create an account before anyone has signed up: the
 * caller solves a proof-of-work, the person accepts Cloudflare's terms, and a
 * temporary account comes back with a token and a claim link. Whoever opens
 * the link within the hour and signs in owns it; claiming leaves the platform
 * no access. If that holds for everything a node needs, setup could show an
 * artist their own page before asking them to sign up for anything.
 *
 * This runs the real thing against Cloudflare's public API and reports what
 * works. It answers:
 *   1. Can the account be created with no key of Amply's? (It should.)
 *   2. How long does the proof-of-work take? Setup would solve it in a browser.
 *   3. Can a browser call these endpoints directly, or must the relay carry them?
 *   4. What can the temporary token do: KV, D1, R2, Access, workers.dev?
 *   5. Does a Worker with KV and D1 bindings deploy and serve?
 *   6. After claiming: does the Worker survive, and is the token dead?
 *
 * The request format follows Wrangler's own implementation (4.134.0).
 *
 * Nothing here is part of `npm run check`: it creates a real account. Run it
 * deliberately, then claim the account (or let it expire in an hour):
 *
 *   node scripts/prove-temporary-account.mjs --accept-terms
 *   node scripts/prove-temporary-account.mjs --after-claim
 *
 * --accept-terms is you accepting Cloudflare's Terms of Service and Privacy
 * Policy, which creating the account requires:
 *   https://www.cloudflare.com/terms/
 *   https://www.cloudflare.com/privacypolicy/
 *
 * The token and claim link are kept in .build/temporary-account.json, which
 * is gitignored, so the second step can check them. The claim link is a
 * bearer credential: anyone holding it can take the account. Don't share it.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const API = "https://api.cloudflare.com/client/v4";
const TERMS = {
  termsOfService: "https://www.cloudflare.com/terms/",
  privacyPolicy: "https://www.cloudflare.com/privacypolicy/",
};
const POW_MAX_ITERATIONS = 64_000_000;   // Wrangler refuses anything harder
const STATE = ".build/temporary-account.json";
const NAME = "amply-proof";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  return cond;
};
const note = (text) => console.log(`      ${text}`);

// ── the proof-of-work, exactly as Wrangler solves it ────────────────────────

/** SHA-256 the seed, then chain k checkpoints of g hashes each. */
export function solvePow(seed, k, g) {
  const checkpoints = [createHash("sha256").update(seed).digest()];
  let h = checkpoints[0];
  for (let j = 0; j < k; j++) {
    for (let i = 0; i < g; i++) h = createHash("sha256").update(h).digest();
    checkpoints.push(h);
  }
  return Buffer.concat(checkpoints).toString("base64");
}

async function cf(path, { token, method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined && !(body instanceof FormData) && typeof body !== "string"
        ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined
      : body instanceof FormData || typeof body === "string" ? body : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  const why = json?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") || "";
  return { status: res.status, ok: res.ok && json?.success !== false, json, why, headers: res.headers };
}

// ── step one: create, deploy, probe ─────────────────────────────────────────

async function create() {
  if (!process.argv.includes("--accept-terms")) {
    console.log("Creating a temporary account means accepting Cloudflare's terms:");
    console.log(`  ${TERMS.termsOfService}\n  ${TERMS.privacyPolicy}`);
    console.log("Read them, then run again with --accept-terms.");
    process.exit(2);
  }

  // 3. Could a browser do this itself? Ask the way a browser would.
  const pre = await fetch(`${API}/provisioning/previews/challenge`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://amply.stream",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  }).catch(() => null);
  const allowed = pre?.headers.get("access-control-allow-origin");
  ok("a browser may call the challenge endpoint directly", !!allowed && (allowed === "*" || allowed === "https://amply.stream"),
    allowed ? `allows ${allowed}` : "no CORS, so setup would go through the relay (as it does today)");

  // 1. The challenge, with no credential at all.
  const challenge = await cf("/provisioning/previews/challenge", { method: "POST", body: {} });
  if (!ok("a challenge is given without any key", challenge.ok, challenge.why || `HTTP ${challenge.status}`)) return;
  const { challengeToken, seed, k, g } = challenge.json.result ?? {};
  const seedBytes = Buffer.from(seed ?? "", "base64url");
  if (!ok("  and it is one Wrangler would accept",
    Number.isInteger(k) && Number.isInteger(g) && k > 0 && g > 0 && k * g <= POW_MAX_ITERATIONS && seedBytes.length === 32,
    `k=${k}, g=${g}, ${k * g} hashes`)) return;

  // 2. How long a browser would be busy. Node's SHA-256 is native; WebCrypto
  //    in a page is slower per call, so treat this as a lower bound.
  const t0 = performance.now();
  const checkpoints = solvePow(seedBytes, k, g);
  const ms = Math.round(performance.now() - t0);
  ok("the proof-of-work is solved", true, `${ms} ms here (a browser will be slower)`);

  const made = await cf("/provisioning/previews", {
    method: "POST",
    body: { ...TERMS, acceptTermsOfService: "yes", challengeToken, solution: { checkpoints } },
  });
  if (!ok("a temporary account is created", made.ok, made.why || `HTTP ${made.status}`)) return;
  const { account, claim } = made.json.result ?? {};
  if (!ok("  with an id, a token and a claim link",
    !!(account?.id && account?.apiToken && claim?.url && account?.expiresAt && claim?.expiresAt))) return;
  note(`account ${account.id} (${account.name}), claim by ${claim.expiresAt}`);

  mkdirSync(".build", { recursive: true });
  const state = { account, claim, createdAt: new Date().toISOString() };
  writeFileSync(STATE, JSON.stringify(state, null, 2), { mode: 0o600 });

  const token = account.apiToken;
  const acct = `/accounts/${account.id}`;

  // 4. What the token can reach. Each is something a node uses today.
  const kv = await cf(`${acct}/storage/kv/namespaces`, { token, method: "POST", body: { title: `${NAME}-media` } });
  ok("KV: a namespace can be made (where audio would live)", kv.ok, kv.why);
  const kvId = kv.json?.result?.id;

  if (kvId) {
    // A song-sized value, to see that audio fits. 4 MB is a typical track.
    const song = Buffer.alloc(4 * 1024 * 1024, 7);
    const put = await fetch(`${API}${acct}/storage/kv/namespaces/${kvId}/values/song`, {
      method: "PUT", headers: { Authorization: `Bearer ${token}` }, body: song,
    });
    ok("  and holds a 4 MB value", put.ok, put.ok ? "" : `HTTP ${put.status}`);
    const hi = await fetch(`${API}${acct}/storage/kv/namespaces/${kvId}/values/hello`, {
      method: "PUT", headers: { Authorization: `Bearer ${token}` }, body: "hello from KV",
    });
    ok("  and a small one", hi.ok);
  }

  const d1 = await cf(`${acct}/d1/database`, { token, method: "POST", body: { name: `${NAME}-amply` } });
  ok("D1: a database can be made (listeners, plays, sales)", d1.ok, d1.why);
  const d1Id = d1.json?.result?.uuid;

  const r2 = await cf(`${acct}/r2/buckets`, { token, method: "POST", body: { name: `${NAME}-media` } });
  ok("R2: a bucket can be made", r2.ok, r2.ok ? "" : `${r2.why || `HTTP ${r2.status}`} (expected: R2 isn't listed for temporary accounts)`);

  const access = await cf(`${acct}/access/apps`, { token });
  ok("Access: applications can be read", access.ok, access.ok ? "" : `${access.why || `HTTP ${access.status}`} (expected: the editor would be locked until after claiming)`);

  // workers.dev needs an account subdomain before a script can be reached.
  let sub = await cf(`${acct}/workers/subdomain`, { token });
  let subdomain = sub.json?.result?.subdomain;
  if (!subdomain) {
    const want = `amply-proof-${Math.random().toString(36).slice(2, 8)}`;
    sub = await cf(`${acct}/workers/subdomain`, { token, method: "PUT", body: { subdomain: want } });
    subdomain = sub.json?.result?.subdomain;
  }
  ok("workers.dev: the account has a subdomain", !!subdomain, subdomain || sub.why);

  // 5. A Worker with the bindings a node needs, serving from both.
  const worker = `
export default {
  async fetch(request, env) {
    const hello = await env.MEDIA.get("hello");
    const song = await env.MEDIA.get("song", "arrayBuffer");
    let d1 = null;
    try { d1 = (await env.DB.prepare("select 1 as one").first()).one; } catch (e) { d1 = String(e); }
    return Response.json({ hello, songBytes: song ? song.byteLength : null, d1 });
  },
};`;
  const form = new FormData();
  const bindings = [];
  if (kvId) bindings.push({ type: "kv_namespace", name: "MEDIA", namespace_id: kvId });
  if (d1Id) bindings.push({ type: "d1", name: "DB", id: d1Id });
  form.set("metadata", new Blob([JSON.stringify({
    main_module: "worker.js", compatibility_date: "2026-09-01", bindings,
  })], { type: "application/json" }));
  form.set("worker.js", new Blob([worker], { type: "application/javascript+module" }), "worker.js");
  const up = await cf(`${acct}/workers/scripts/${NAME}`, { token, method: "PUT", body: form });
  ok("a Worker with KV and D1 bindings deploys", up.ok, up.why);

  const on = await cf(`${acct}/workers/scripts/${NAME}/subdomain`, { token, method: "POST", body: { enabled: true } });
  ok("  and is switched on at workers.dev", on.ok, on.why);

  if (subdomain && up.ok) {
    const url = `https://${NAME}.${subdomain}.workers.dev/`;
    state.workerUrl = url;
    writeFileSync(STATE, JSON.stringify(state, null, 2), { mode: 0o600 });
    // A fresh workers.dev name can take a little while to answer.
    let body = null;
    for (let i = 0; i < 10 && !body; i++) {
      try {
        const r = await fetch(url);
        if (r.ok) body = await r.json();
      } catch { /* not yet */ }
      if (!body) await new Promise((r) => setTimeout(r, 3000));
    }
    ok("  and serves, reading KV and D1", body?.hello === "hello from KV" && body?.d1 === 1,
      body ? JSON.stringify(body) : `no answer from ${url}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(`\nNow claim it, within the hour, by opening this link and signing up or in:`);
  console.log(`  ${claim.url}`);
  console.log(`Use a fresh email to see what a new artist would. Then run:`);
  console.log(`  node scripts/prove-temporary-account.mjs --after-claim`);
}

// ── step two: after claiming ────────────────────────────────────────────────

async function afterClaim() {
  let state;
  try { state = JSON.parse(readFileSync(STATE, "utf8")); }
  catch { console.log(`Nothing to check: run with --accept-terms first.`); process.exit(2); }

  if (state.workerUrl) {
    let body = null;
    try { const r = await fetch(state.workerUrl); if (r.ok) body = await r.json(); } catch { /* gone */ }
    ok("the Worker still serves after the claim", body?.hello === "hello from KV" && body?.d1 === 1,
      body ? JSON.stringify(body) : `no answer from ${state.workerUrl} (unclaimed accounts are deleted)`);
  }

  // The property Amply depends on: once it's theirs, the token Amply's setup
  // held must reach nothing.
  const probe = await cf(`/accounts/${state.account.id}/workers/scripts`, { token: state.account.apiToken });
  ok("the temporary token no longer reaches the account", !probe.ok,
    probe.ok ? "it still works: setup would keep standing access" : `refused (HTTP ${probe.status})`);

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(`\nThe account is yours now. Delete the "${NAME}" Worker, KV namespace and D1 database`);
  console.log(`from the dashboard when you're done, and delete ${STATE}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await (process.argv.includes("--after-claim") ? afterClaim() : create());
  process.exit(fail ? 1 : 0);
}
