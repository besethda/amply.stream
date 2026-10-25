/**
 * Setup before signup: a node in a temporary account, then finishing it.
 *
 * Against a fake Cloudflare. What matters here:
 *   - the account is only asked for with Cloudflare's terms accepted, and a
 *     proof-of-work Cloudflare would check;
 *   - the node is built on KV (temporary accounts have no R2) and has no
 *     Access, so it is live and read-only;
 *   - finishing setup after the claim adds the editor lock and nothing else,
 *     and never makes an R2 bucket or rebinds the node to an empty one;
 *   - finishing from another browser finds the node's KV and keeps its music;
 *   - a starter page never replaces a track list that exists.
 *
 *   node scripts/test-instant.mjs
 */
import { createHash } from "node:crypto";

const local = new Map(), session = new Map();
const storage = (m) => ({
  getItem: (k) => (m.has(k) ? m.get(k) : null),
  setItem: (k, v) => m.set(k, String(v)),
  removeItem: (k) => m.delete(k),
});
globalThis.localStorage = storage(local);
globalThis.sessionStorage = storage(session);

const { provisionInstant, provision, claimLink, pendingPreview, clearProgress, ProvisionError } =
  await import("../site/js/provision.js");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

const ACC = "0123456789abcdef0123456789abcdef";
const KV = "fedcba9876543210fedcba9876543210";
const DB = "11111111-2222-3333-4444-555555555555";
const SEED = Buffer.alloc(32, 9);
const ok_ = (result) => ({ success: true, errors: [], result });

function expectedCheckpoints(k, g) {
  const out = [createHash("sha256").update(SEED).digest()];
  let h = out[0];
  for (let j = 0; j < k; j++) { for (let i = 0; i < g; i++) h = createHash("sha256").update(h).digest(); out.push(h); }
  return Buffer.concat(out).toString("base64");
}

/**
 * A fake Cloudflare behind a fake relay. `world` is what exists in the
 * account; every request is logged with the token it carried.
 */
function cloudflare(world) {
  const log = [];
  globalThis.fetch = async (url, init = {}) => {
    if (!/^https?:/.test(url)) {
      const body = url.includes("node-version")
        ? JSON.stringify({ schema: ["CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)"], limits: [] })
        : url.includes("manage") ? "<!doctype html><title>editor</title>" : "export default {}";
      return new Response(body);
    }
    const u = new URL(url);
    const method = init.method || "GET";
    const token = new Headers(init.headers).get("Authorization");
    const body = init.body;
    log.push({ method, path: u.pathname, token, body });
    const reply = (x) => new Response(JSON.stringify(x), { status: 200 });

    if (u.pathname === "/preview/challenge") return reply(ok_({ challengeToken: "ct", seed: SEED.toString("base64url"), k: 3, g: 4 }));
    if (u.pathname === "/preview/account") {
      const b = JSON.parse(body);
      world.asked = b;
      if (b.acceptTermsOfService !== "yes" || b.solution?.checkpoints !== expectedCheckpoints(3, 4)) {
        return reply({ success: false, errors: [{ message: "bad proof" }] });
      }
      return reply(ok_({
        account: { id: ACC, name: "temp", apiToken: "temporary-token", expiresAt: new Date(Date.now() + 3600e3).toISOString() },
        claim: { url: "https://dash.cloudflare.com/claim/abc", expiresAt: new Date(Date.now() + 3600e3).toISOString() },
      }));
    }

    const path = u.pathname.replace(/^\/api/, "");
    if (path === "/accounts") return reply(ok_(world.accounts));
    if (path.endsWith("/storage/kv/namespaces") && method === "GET") return reply(ok_(world.kv));
    if (path.endsWith("/storage/kv/namespaces") && method === "POST") { world.kv.push({ id: KV, title: JSON.parse(body).title }); return reply(ok_({ id: KV })); }
    if (path.includes("/storage/kv/namespaces/") && method === "PUT") { world.kvWrites.push(path); return reply(ok_(null)); }
    if (path.includes("/r2/")) { world.r2 = true; return reply(ok_({ buckets: [] })); }
    if (path.includes("/d1/database") && method === "GET") return reply(ok_(world.dbs));
    if (path.endsWith("/d1/database") && method === "POST") { world.dbs.push({ uuid: DB, name: JSON.parse(body).name }); return reply(ok_({ uuid: DB })); }
    if (path.endsWith("/query")) {
      const { sql, params } = JSON.parse(body);
      if (/^SELECT value FROM settings WHERE key = \?/.test(sql)) {
        const v = world.settings[params[0]];
        return reply(ok_([{ results: v === undefined ? [] : [{ value: v }] }]));
      }
      if (/^INSERT INTO settings/.test(sql)) { world.settings[params[0]] = params[1]; }
      return reply(ok_([{ results: [] }]));
    }
    if (path.endsWith("/workers/subdomain") && method === "GET") return reply(ok_({ subdomain: world.subdomain }));
    if (path.endsWith("/workers/subdomain") && method === "PUT") { world.subdomain = JSON.parse(body).subdomain; return reply(ok_({ subdomain: world.subdomain })); }
    if (/\/workers\/scripts\/[^/]+$/.test(path) && method === "PUT") {
      world.uploads.push(JSON.parse(await body.get("metadata").text()).bindings);
      return reply(ok_({}));
    }
    if (path.includes("/access/organizations") && method === "GET") return reply(ok_(null));
    if (path.includes("/access/organizations") && method === "POST") return reply(ok_({ auth_domain: "test.cloudflareaccess.com" }));
    if (path.includes("/access/identity_providers") && method === "GET") return reply(ok_([]));
    if (path.includes("/access/apps") && path.endsWith("/policies")) return reply(ok_([]));
    if (path.endsWith("/access/apps") && method === "GET") return reply(ok_([]));
    if (path.endsWith("/access/apps") && method === "POST") { world.accessApp = true; return reply(ok_({ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", aud: "aud-tag" })); }
    return reply(ok_({}));
  };
  return log;
}

const fresh = () => ({ accounts: [{ id: ACC, name: "Mine" }], kv: [], kvWrites: [], dbs: [], settings: {}, uploads: [], subdomain: null, r2: false });

// ── a node before signup ────────────────────────────────────────────────────
const world = fresh();
let log = cloudflare(world);
const steps = [];
const made = await provisionInstant({
  relay: "https://relay.test", artistName: "Hollow Coast", slug: "hollow-coast",
  onStep: (id, state) => steps.push(`${id}:${state}`),
});

ok("the account is asked for with Cloudflare's terms accepted", world.asked?.acceptTermsOfService === "yes"
  && world.asked?.termsOfService === "https://www.cloudflare.com/terms/");
ok("  and a proof-of-work Cloudflare would check", world.asked?.solution?.checkpoints === expectedCheckpoints(3, 4));
ok("the node goes live at its address", made.url === "https://hollow-coast.hollow-coast.workers.dev", made.url);
ok("the claim link comes back", made.claimUrl === "https://dash.cloudflare.com/claim/abc");
ok("  and is kept only for this tab", claimLink()?.url === made.claimUrl && !JSON.stringify([...local]).includes("claim/abc"));
ok("  as is the temporary token", !JSON.stringify([...local]).includes("temporary-token"));
ok("every call to the account carries the temporary token",
  log.filter((r) => r.path.startsWith("/api/")).every((r) => r.token === "Bearer temporary-token"));
ok("audio lives in KV", world.uploads[0]?.some((b) => b.type === "kv_namespace" && b.name === "MEDIA_KV" && b.namespace_id === KV));
ok("  and nothing touches R2", !world.r2);
ok("the editor is stored in KV, its key encoded", world.kvWrites.some((p) => p.endsWith("/values/manage%2Findex.html")));
ok("no Access yet: temporary accounts can't have it", !world.accessApp && !("access" in world.settings));
ok("a starter page is published", JSON.parse(world.settings.manifest || "{}").artist?.name === "Hollow Coast");
ok("every step reports in", ["preview", "bucket", "database", "worker", "subdomain", "editor", "manifest"]
  .every((id) => steps.includes(`${id}:done`)), steps.join(" "));
ok("this browser remembers there's one to finish", pendingPreview()?.accountId === ACC);

// ── running it again in the same tab ────────────────────────────────────────
{
  const asked = world.asked;
  world.asked = null;
  await provisionInstant({ relay: "https://relay.test", artistName: "Hollow Coast", slug: "hollow-coast" });
  ok("a second run reuses the account rather than making another", world.asked === null);
  ok("  and the same storage", world.kv.length === 1);
  world.asked = asked;
}

// ── finishing, after the claim ──────────────────────────────────────────────
{
  world.settings.manifest = JSON.stringify({ amply: 1, artist: { name: "Hollow Coast" }, releases: [{ id: "a" }] });
  const before = world.uploads.length;
  log = cloudflare(world);
  const done = await provision({
    token: "oauth-token", relay: "https://relay.test", artistName: "Hollow Coast", slug: "hollow-coast",
    email: "artist@example.com",
  });
  ok("finishing locks the editor to the artist", world.accessApp && JSON.parse(world.settings.access || "{}").aud === "aud-tag");
  ok("  and says where it is", done.editorUrl === "https://hollow-coast.hollow-coast.workers.dev/manage");
  ok("  with the artist's own login", log.filter((r) => r.path.startsWith("/api/")).every((r) => r.token === "Bearer oauth-token"));
  ok("  without making an R2 bucket", !world.r2);
  ok("  or redeploying the node", world.uploads.length === before);
  ok("  and the track list is left exactly as it was", JSON.parse(world.settings.manifest).releases.length === 1);
}

// ── finishing before the claim ──────────────────────────────────────────────
{
  clearProgress();
  local.clear(); session.clear();
  const w = fresh();
  cloudflare(w);
  await provisionInstant({ relay: "https://relay.test", artistName: "Hollow Coast", slug: "hollow-coast" });
  w.accounts = [{ id: "99999999999999999999999999999999", name: "Someone else's" }];
  let kind = null;
  try {
    await provision({ token: "oauth-token", relay: "https://relay.test", artistName: "Hollow Coast", slug: "hollow-coast", email: "a@b.co" });
  } catch (e) { kind = e instanceof ProvisionError ? e.kind : String(e); }
  ok("finishing before claiming says to claim it first", kind === "not_claimed", kind);
  ok("  and changes nothing", !w.accessApp);
}

// ── finishing from another browser ──────────────────────────────────────────
{
  local.clear(); session.clear();
  const w = fresh();
  w.kv = [{ id: KV, title: "hollow-coast-media" }];
  w.dbs = [{ uuid: DB, name: "hollow-coast-amply" }];
  w.subdomain = "hollow-coast";
  w.settings.manifest = JSON.stringify({ amply: 1, artist: { name: "Hollow Coast" }, releases: [{ id: "a" }] });
  cloudflare(w);
  await provision({ token: "oauth-token", relay: "https://relay.test", artistName: "Hollow Coast", slug: "hollow-coast", email: "a@b.co" });
  ok("another browser finds the node's KV and keeps using it",
    w.uploads.at(-1)?.some((b) => b.name === "MEDIA_KV" && b.namespace_id === KV) && !w.r2);
  ok("  writes the editor there", w.kvWrites.some((p) => p.endsWith("/values/manage%2Findex.html")));
  ok("  locks it", w.accessApp);
  ok("  and doesn't replace the track list", JSON.parse(w.settings.manifest).releases.length === 1);
}

// ── an ordinary setup is unchanged ──────────────────────────────────────────
{
  local.clear(); session.clear();
  const w = fresh();
  cloudflare(w);
  await provision({ token: "oauth-token", relay: "https://relay.test", artistName: "Hollow Coast", slug: "hollow-coast", email: "a@b.co" });
  ok("an account with no KV node still gets R2, as before",
    w.r2 && w.uploads.at(-1)?.some((b) => b.type === "r2_bucket" && b.name === "MEDIA"));
  ok("  and a starter page", JSON.parse(w.settings.manifest || "{}").releases?.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
