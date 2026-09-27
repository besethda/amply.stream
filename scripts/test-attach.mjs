/**
 * Putting an artist's service on their own domain, against a fake Cloudflare.
 *
 * The real attach is one call. What is tested is everything around it: what
 * is refused before it is made, what is said when Cloudflare says no, and that
 * nothing ever asks to overwrite a record — which is how an artist's website
 * would be replaced.
 *
 *   node scripts/test-attach.mjs
 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { attachDomain, domainProblem, ProvisionError } = await import("../site/js/provision.js");

const A1 = "0123456789abcdef0123456789abcdef";
const A2 = "fedcba9876543210fedcba9876543210";
const ok = (result) => ({ success: true, errors: [], result });
const no = (message, code = 10000) => ({ success: false, errors: [{ code, message }], result: null });

function cloudflare({ accounts = [A1], attach = () => ok({}) } = {}) {
  const seen = { attached: [], settings: {} };
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname.replace(/^\/api/, "");
    const method = init.method || "GET";
    const send = (b, status = 200) => new Response(JSON.stringify(b), { status });
    if (path === "/accounts") return send(ok(accounts.map((id) => ({ id, name: id }))));
    const m = path.match(/^\/accounts\/([0-9a-f]{32})\/workers\/domains$/);
    if (m && method === "PUT") {
      const body = JSON.parse(init.body);
      seen.attached.push({ account: m[1], ...body });
      const r = attach(m[1], body);
      return r instanceof Response ? r : send(r);
    }
    if (path.includes("/d1/database") && method === "GET") return send(ok([{ name: "someone-amply", uuid: "db-1" }]));
    if (path.endsWith("/query")) {
      const { sql, params } = JSON.parse(init.body);
      if (/^INSERT INTO settings/.test(sql)) seen.settings[params[0]] = params[1];
      return send(ok([]));
    }
    return send(ok({}));
  };
  return seen;
}

async function attempt(setup, hostname = "listen.someone.com") {
  const seen = cloudflare(setup);
  let kind = null, result = null;
  try {
    result = await attachDomain({ token: "t", relay: "https://relay.test", slug: "someone", hostname });
  } catch (e) {
    kind = e instanceof ProvisionError ? e.kind : `threw ${e}`;
  }
  return { ...seen, kind, result };
}

let pass = 0, fail = 0;
const is = (name, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  good ? pass++ : fail++;
  console.log(`${good ? "ok  " : "FAIL"}  ${name}${good ? "" : ` — expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`}`);
};

// ── refused before anything is asked of Cloudflare ──────────────────────────

is("a new subdomain is fine", domainProblem("listen.someone.com"), null);
is("the bare domain is refused — it is their website", typeof domainProblem("someone.com"), "string");
is("so is www", typeof domainProblem("www.someone.com"), "string");
is("a workers.dev address is not their own domain", typeof domainProblem("x.sub.workers.dev"), "string");
is("nonsense is refused", typeof domainProblem("not a domain"), "string");

{
  const r = await attempt({}, "someone.com");
  is("attaching the bare domain never reaches Cloudflare", r.attached.length, 0);
  is("  and says why", r.kind, "bad_hostname");
}

// ── the ordinary case ───────────────────────────────────────────────────────

{
  const r = await attempt({});
  is("it attaches the Worker to the hostname", r.attached[0]?.hostname, "listen.someone.com");
  is("  by the Worker's name", r.attached[0]?.service, "someone");
  is("  never asking to overwrite what is already there", "override_existing_dns_record" in (r.attached[0] || {}), false);
  is("  and tells the editor the new address", r.settings.home, "https://listen.someone.com");
  is("  and hands it back", r.result?.url, "https://listen.someone.com");
}

// ── when Cloudflare says no ─────────────────────────────────────────────────

is("a domain not on Cloudflare is named as such",
  (await attempt({ attach: () => no("Could not find zone for hostname listen.someone.com") })).kind,
  "domain_not_on_cloudflare");
is("a zone still waiting for its nameservers is named as such",
  (await attempt({ attach: () => no("Zone is pending activation") })).kind, "domain_pending");
is("a hostname already in use is named as such",
  (await attempt({ attach: () => no("Hostname already has externally managed DNS records") })).kind, "hostname_in_use");
is("a refusal of permission is named as such",
  (await attempt({ attach: () => new Response("{}", { status: 403 }) })).kind, "domain_permission");
is("anything else comes through with Cloudflare's own words",
  (await attempt({ attach: () => no("Something nobody predicted") })).kind, "cloudflare");

// ── several accounts: the one that holds the Worker ─────────────────────────

{
  const r = await attempt({
    accounts: [A1, A2],
    attach: (account) => (account === A1 ? no("Worker script not found") : ok({})),
  });
  is("with two accounts, the one without the Worker is passed over", r.kind, null);
  is("  and it is attached in the one that has it", r.attached.at(-1)?.account, A2);
}

{
  const r = await attempt({ accounts: [A1, A2], attach: () => no("Worker script not found") });
  is("if no account has it, the artist is told so", r.kind, "no_worker");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
