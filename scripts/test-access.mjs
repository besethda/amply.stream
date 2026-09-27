/**
 * Locking the editor to the artist, and the ways that can go wrong.
 *
 * This step is allowed to fail softly, so anything it throws costs the artist
 * their editor: the setting the node checks is written at the end, and a throw
 * before it leaves a rebuilt service answering "this streaming service has no
 * sign-in set up". That happened, so the rules are pinned here.
 *
 *   only a rule admitting everybody is fatal
 *   a rule admitting nobody is fixed by adding one
 *   policies that cannot be read are not evidence of anything
 *
 *   node scripts/test-access.mjs
 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { provision, ProvisionError } = await import("../site/js/provision.js");

const ACC = "0123456789abcdef0123456789abcdef";
const APP = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const EMAIL = "artist@example.com";
const ok = (result) => ({ success: true, errors: [], result });

/**
 * A fake Cloudflare that already has a Zero Trust organisation and an Access
 * application for this address — the rebuild case, which is the one where an
 * existing rule is adopted.
 */
function cloudflare({ policies, readFails = false }) {
  const seen = { policiesCreated: [], settings: {} };

  globalThis.fetch = async (url, init = {}) => {
    if (!/^https?:/.test(url)) {
      const body = url.includes("node-version")
        ? JSON.stringify({ version: "test", schema: [], migrations: [] })
        : "export default {}";
      return new Response(body, { status: 200 });
    }

    const path = new URL(url).pathname.replace(/^\/api/, "");
    const method = init.method || "GET";
    const send = (body, status = 200) => new Response(JSON.stringify(body), { status });

    if (path.endsWith("/access/organizations") && method === "GET") {
      return send(ok({ auth_domain: "test.cloudflareaccess.com" }));
    }
    if (path.endsWith("/access/identity_providers")) return send(ok([{ type: "onetimepin" }]));
    if (path.endsWith("/access/apps") && method === "GET") {
      return send(ok([{ id: APP, domain: "test.someone.workers.dev/manage", aud: "the-aud" }]));
    }
    if (path.endsWith(`/access/apps/${APP}/policies`)) {
      if (method === "GET") {
        return readFails ? send({ success: false, errors: [{ code: 1, message: "nope" }] }, 200)
                         : send(ok(policies));
      }
      seen.policiesCreated.push(JSON.parse(init.body));
      return send(ok({ id: "new-policy" }));
    }
    if (path.endsWith("/query")) {
      const { sql, params } = JSON.parse(init.body);
      if (/^INSERT INTO settings/.test(sql)) seen.settings[params[0]] = params[1];
      return send(ok([{ results: [] }]));
    }
    if (path === "/accounts") return send(ok([{ id: ACC, name: "Test" }]));
    if (path.endsWith("/r2/buckets") && method === "GET") return send(ok({ buckets: [] }));
    if (path.includes("/d1/database") && method === "GET") return send(ok([]));
    if (path.endsWith("/d1/database") && method === "POST") return send(ok({ uuid: APP }));
    if (path.endsWith("/workers/subdomain")) return send(ok({ subdomain: "someone" }));
    return send(ok({ id: "whatever" }));
  };

  return seen;
}

async function rebuild(setup) {
  store.clear();
  const seen = cloudflare(setup);
  let kind = null;
  try {
    await provision({
      token: "t", relay: "https://relay.test", artistName: "Test", slug: "test",
      email: EMAIL, mode: "repair",
    });
  } catch (e) {
    kind = e instanceof ProvisionError ? e.kind : `threw ${e}`;
  }
  return { ...seen, kind };
}

let pass = 0, fail = 0;
const ok_ = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

const allowing = (include) => [{ decision: "allow", include }];

// The ordinary rebuild: the rule already admits this artist and nothing else.
let r = await rebuild({ policies: allowing([{ email: { email: EMAIL } }]) });
ok_("a rule that already admits the artist is left alone", r.policiesCreated.length === 0);
ok_("  and the node is told what to verify against", !!r.settings.access, JSON.stringify(r.settings));
ok_("  without an error", r.kind === null, String(r.kind));

// Dangerous: anybody could sign in and take over the account.
r = await rebuild({ policies: allowing([{ everyone: {} }]) });
ok_("a rule admitting everybody stops the rebuild", r.kind === "zt_policy_open", String(r.kind));
ok_("  and the node is not pointed at it", !r.settings.access);

// A lockout, not a risk: fix it instead of refusing.
r = await rebuild({ policies: allowing([{ email: { email: "someone-else@example.com" } }]) });
ok_("a rule that admits somebody else gets one added for the artist",
  r.policiesCreated.length === 1 && r.policiesCreated[0].include[0].email.email === EMAIL,
  JSON.stringify(r.policiesCreated));
ok_("  and the rebuild finishes", r.kind === null, String(r.kind));
ok_("  with the editor configured", !!r.settings.access);

// An app with no rules at all admits nobody, which is safe. Add one.
r = await rebuild({ policies: [] });
ok_("an application with no rules gets one", r.policiesCreated.length === 1);
ok_("  and still finishes", r.kind === null && !!r.settings.access, String(r.kind));

// Unknown is not evidence. Carrying on is right: the node checks the token's
// audience itself, and refusing here would lock the artist out of their editor
// to protect them from something we never established.
r = await rebuild({ policies: null, readFails: true });
ok_("policies that cannot be read do not stop the rebuild", r.kind === null, String(r.kind));
ok_("  and the editor is still configured", !!r.settings.access);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
