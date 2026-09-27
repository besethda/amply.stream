/**
 * Setup against a fake Cloudflare: does each refusal reach the right fix?
 *
 * A brand-new account refuses some services until their dashboard page has
 * been opened once. Setup cannot switch them on, so all it can do is send the
 * artist to the right page. It used to decide which page from the wording of
 * Cloudflare's message, and a KV refusal on a fresh account sent the artist
 * to switch on R2, which they had already done.
 *
 *   node scripts/test-provision.mjs
 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { provision, ProvisionError } = await import("../site/js/provision.js");

const ACC = "0123456789abcdef0123456789abcdef";
const LIMITS = [
  { binding: "LIMIT_LISTEN", limit: 40, period: 60, namespace: "7101" },
  { binding: "LIMIT_NEW", limit: 20, period: 60, namespace: "7104" },
];
/** The bindings a Worker upload asked for. */
const bindingsOf = async (init) => JSON.parse(await init.body.get("metadata").text()).bindings;
const ok = (result) => ({ success: true, errors: [], result });
const no = (message, code = 10000) => ({ success: false, errors: [{ code, message }], result: null });

/** A fake relay: `refuse` picks which request fails and how. */
function cloudflare(refuse) {
  globalThis.fetch = async (url, init = {}) => {
    // Setup also fetches its own payloads by relative path: the Worker script
    // and the editor, served from the same site as the page.
    if (!/^https?:/.test(url)) {
      // Setup fetches its own payloads by relative path: the Worker script, the
      // editor, and the schema its database needs.
      const body = url.includes("node-version")
        ? JSON.stringify({ version: "test", schema: ["CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)"], limits: LIMITS })
        : "export default {}";
      return new Response(body, { status: 200 });
    }
    const path = new URL(url).pathname.replace(/^\/api/, "");
    const method = init.method || "GET";
    const body =
      (await refuse(method, path, init)) ??
      (path === "/accounts" ? ok([{ id: ACC, name: "Test" }])
        : path.endsWith("/r2/buckets") && method === "GET" ? ok({ buckets: [] })
        : path.includes("/d1/database") && method === "GET" ? ok([])
        : path.endsWith("/d1/database") && method === "POST" ? ok({ uuid: "11111111-2222-3333-4444-555555555555" })
        : path.endsWith("/query") ? ok([])
        : ok({ id: "fedcba9876543210fedcba9876543210" }));
    return new Response(JSON.stringify(body), { status: 200 });
  };
}

async function kindOf(refuse) {
  store.clear();
  cloudflare(refuse);
  try {
    await provision({ token: "t", relay: "https://relay.test", artistName: "Test", slug: "test" });
    return "(no error)";
  } catch (e) {
    return e instanceof ProvisionError ? e.kind : `threw ${e}`;
  }
}

const cases = [
  ["the database is off, message mentions a subscription", "d1_disabled",
    (m, p) => (p.includes("/d1/") ? no("A subscription is required to use this service") : null)],
  ["the database is off, message says not enabled", "d1_disabled",
    (m, p) => (p.includes("/d1/") ? no("D1 is not enabled for this account") : null)],
  ["the database refuses in words nobody predicted", "d1_disabled",
    (m, p) => (p.includes("/d1/") ? no("", 10042) : null)],
  ["R2 off still gets the R2 fix", "r2_disabled",
    (m, p) => (p.includes("/r2/") && m === "POST" ? no("Please enable R2 through the Cloudflare Dashboard.") : null)],
  ["a name clash is still a name clash", "name_taken",
    (m, p) => (p.includes("/r2/") && m === "POST" ? no("The bucket you tried to create already exists") : null)],
  ["no workers.dev address, reported while uploading the Worker", "no_subdomain",
    (m, p) => (p.includes("/workers/scripts/") && m === "PUT"
      ? no("You do not have a workers.dev subdomain. Please go to https://dash.cloudflare.com/?to=/:account/workers/workers-and-pages.")
      : null)],
  ["no address yet: setup claims one and carries on", "(no error)",
    (m, p) => (p.endsWith("/workers/subdomain") && m === "GET" ? ok({ subdomain: null }) : null)],
  ["the name is taken, so the next candidate is used", "(no error)",
    (() => {
      let claims = 0;
      return (m, p) => {
        if (p.endsWith("/workers/subdomain") && m === "GET") return ok({ subdomain: null });
        if (p.endsWith("/workers/subdomain") && m === "PUT") {
          return ++claims === 1 ? no("already exists") : ok({ subdomain: "test-music" });
        }
        return null;
      };
    })()],
  ["claiming refused outright still asks the artist", "no_subdomain",
    (m, p) => {
      if (p.endsWith("/workers/subdomain") && m === "GET") return ok({ subdomain: null });
      if (p.endsWith("/workers/subdomain") && m === "PUT") return no("workers.dev is not available");
      return null;
    }],
  ["the real sequence: upload refuses until a name exists, so one is claimed first", "(no error)",
    (() => {
      let claimed = false;
      return (m, p) => {
        if (p.endsWith("/workers/subdomain") && m === "GET") {
          return ok({ subdomain: claimed ? "test" : null });
        }
        if (p.endsWith("/workers/subdomain") && m === "PUT") { claimed = true; return ok({ subdomain: "test" }); }
        if (p.includes("/workers/scripts/") && m === "PUT" && !claimed) {
          return no("You do not have a workers.dev subdomain. Please go to https://dash.cloudflare.com/?to=/:account/workers/workers-and-pages.");
        }
        return null;
      };
    })()],
  ["an account that refuses the rate limiters still gets its service", "(no error)",
    async (m, p, init) => {
      if (!(p.includes("/workers/scripts/") && m === "PUT")) return null;
      const b = await bindingsOf(init);
      return b.some((x) => x.type === "ratelimit") ? no("Unknown binding type: ratelimit") : null;
    }],
  ["a network drop is not mistaken for the database being off", "network",
    (m, p) => { if (p.includes("/d1/")) throw new TypeError("fetch failed"); return null; }],
];

// The network case throws from fetch itself, which the fake needs to allow.
let pass = 0, fail = 0;
for (const [name, want, refuse] of cases) {
  const got = await kindOf(refuse);
  const good = got === want;
  good ? pass++ : fail++;
  console.log(`${good ? "ok  " : "FAIL"}  ${name}${good ? "" : ` — expected ${want}, got ${got}`}`);
}
// What the Worker is uploaded with.
{
  const uploads = [];
  store.clear();
  cloudflare(async (m, p, init) => { if (p.includes("/workers/scripts/") && m === "PUT") uploads.push(await bindingsOf(init)); return null; });
  await provision({ token: "t", relay: "https://relay.test", artistName: "Test", slug: "test" });
  const limiters = (uploads[0] || []).filter((b) => b.type === "ratelimit");
  const good = uploads.length === 1 && limiters.length === 2
    && limiters.every((l) => /^LIMIT_/.test(l.name) && l.namespace_id && l.simple?.limit > 0 && l.simple?.period === 60)
    && uploads[0].some((b) => b.type === "d1") && uploads[0].some((b) => b.type === "r2_bucket");
  good ? pass++ : fail++;
  console.log(`${good ? "ok  " : "FAIL"}  the Worker is uploaded with its storage and the rate limiters, as Cloudflare's tool writes them${good ? "" : ` — ${JSON.stringify(uploads)}`}`);

  const refused = [];
  store.clear();
  cloudflare(async (m, p, init) => {
    if (!(p.includes("/workers/scripts/") && m === "PUT")) return null;
    const b = await bindingsOf(init); refused.push(b);
    return b.some((x) => x.type === "ratelimit") ? no("Unknown binding type: ratelimit") : null;
  });
  await provision({ token: "t", relay: "https://relay.test", artistName: "Test", slug: "test" });
  const fine = refused.length === 2 && !refused[1].some((b) => b.type === "ratelimit") && refused[1].length === 2;
  fine ? pass++ : fail++;
  console.log(`${fine ? "ok  " : "FAIL"}  refused, it's uploaded again without them — storage intact${fine ? "" : ` — ${JSON.stringify(refused)}`}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
