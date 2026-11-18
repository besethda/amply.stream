/**
 * A rebuild replaces the code and nothing else.
 *
 * It finds the artist's Worker, reads which storage and database it is wired
 * to, and wires the new code to exactly those. It never creates storage or a
 * database: a rebuild that guessed wrong and made new, empty ones would leave
 * the artist's page looking empty. And if it can't find the service, or the
 * service isn't Amply's, it changes nothing at all.
 *
 *   node scripts/test-rebuild.mjs
 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { provision, REPAIR_STEPS, ProvisionError, fetchRelease, versionOfWorker, versionOfEditor } = await import("../site/js/provision.js");

let pass = 0, fail = 0;
const ok_ = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

const MINE = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const DB = "11111111-2222-3333-4444-555555555555";
const KV = "abcdefabcdefabcdefabcdefabcdef12";
const ok = (result) => ({ success: true, errors: [], result });

/**
 * A fake Cloudflare: `accounts` on the login, the Worker `hollow` in `MINE`
 * wired as `bindings` (or absent), and a log of every request made.
 */
function cloudflare({ accounts = [{ id: MINE, name: "Mine" }], bindings, workerIn = MINE }) {
  const log = [];
  globalThis.fetch = async (url, init = {}) => {
    if (!/^https?:/.test(url)) {
      const body = url.includes("node-version") ? JSON.stringify({ version: "test", schema: [], migrations: [] }) : 'export default {}; const VERSION = "test"; // <meta name="amply-version" content="test">';
      return new Response(body, { status: 200 });
    }
    const path = new URL(url).pathname.replace(/^\/api/, "");
    const method = init.method || "GET";
    log.push({ method, path, body: init.body });
    const send = (body, status = 200) => new Response(JSON.stringify(body), { status });

    if (path === "/accounts") return send(ok(accounts));
    const settings = path.match(/^\/accounts\/([0-9a-f]{32})\/workers\/scripts\/hollow\/settings$/);
    if (settings) {
      return settings[1] === workerIn && bindings
        ? send(ok({ bindings }))
        : send({ success: false, errors: [{ code: 10007, message: "This Worker does not exist on your account." }], result: null }, 404);
    }
    if (path.endsWith("/query")) return send(ok([{ results: [] }]));
    if (path.endsWith("/workers/subdomain")) return send(ok({ subdomain: "quiet-hill" }));
    return send(ok({ id: "whatever" }));
  };
  return log;
}

async function rebuild(world) {
  store.clear();
  const log = cloudflare(world);
  let kind = null;
  try {
    await provision({ token: "t", relay: "https://relay.test", artistName: "hollow", slug: "hollow", mode: "repair", withAccess: false });
  } catch (e) {
    kind = e instanceof ProvisionError ? e.kind : `threw ${e}`;
  }
  const upload = log.find((r) => r.method === "PUT" && /\/workers\/scripts\/hollow$/.test(r.path));
  const uploaded = upload ? JSON.parse(await upload.body.get("metadata").text()).bindings : null;
  return { log, kind, uploaded };
}

const creates = (log) => log.filter((r) => r.method === "POST" && /\/(r2\/buckets|storage\/kv\/namespaces|d1\/database)$/.test(r.path));
const writes = (log) => log.filter((r) => r.method !== "GET");

// ── an R2 service ───────────────────────────────────────────────────────────
{
  const r = await rebuild({ bindings: [
    { type: "d1", name: "DB", id: DB },
    { type: "r2_bucket", name: "MEDIA", bucket_name: "hollow-coast-media" },
  ] });
  ok_("a service on R2 is rebuilt", r.kind === null, String(r.kind));
  ok_("  nothing is created: no storage, no database", creates(r.log).length === 0, JSON.stringify(creates(r.log)));
  ok_("  the new code is wired to the very same bucket", r.uploaded?.some((b) => b.type === "r2_bucket" && b.bucket_name === "hollow-coast-media"),
    JSON.stringify(r.uploaded));
  ok_("  and the very same database", r.uploaded?.some((b) => b.type === "d1" && b.id === DB));
  ok_("  whose tables are brought up to date, and only those", r.log.filter((x) => x.path.endsWith("/query")).every((x) => x.path.includes(DB)));
}

// ── a KV service, from before signup ────────────────────────────────────────
{
  const r = await rebuild({ bindings: [
    { type: "d1", name: "DB", id: DB },
    { type: "kv_namespace", name: "MEDIA_KV", namespace_id: KV },
  ] });
  ok_("a service on KV is rebuilt on the same KV", r.kind === null && r.uploaded?.some((b) => b.type === "kv_namespace" && b.namespace_id === KV),
    `${r.kind} ${JSON.stringify(r.uploaded)}`);
  ok_("  not moved to an R2 bucket", !r.uploaded?.some((b) => b.type === "r2_bucket"));
  ok_("  and nothing created", creates(r.log).length === 0);
}

// ── found in whichever account it's in ──────────────────────────────────────
{
  const r = await rebuild({
    accounts: [{ id: OTHER, name: "Work" }, { id: MINE, name: "Mine" }],
    bindings: [{ type: "d1", name: "DB", id: DB }, { type: "r2_bucket", name: "MEDIA", bucket_name: "b" }],
  });
  ok_("with several accounts, the one holding the service is used", r.kind === null, String(r.kind));
  ok_("  and nothing is written to the others", writes(r.log).every((x) => !x.path.includes(OTHER)));
}

// ── nothing to rebuild ──────────────────────────────────────────────────────
{
  const r = await rebuild({ bindings: null });
  ok_("no such service: stops, saying so", r.kind === "service_not_found", String(r.kind));
  ok_("  having changed nothing at all", writes(r.log).length === 0, JSON.stringify(writes(r.log)));
}
{
  const r = await rebuild({ bindings: [{ type: "r2_bucket", name: "MEDIA", bucket_name: "b" }] });
  ok_("a Worker that isn't wired like Amply's: stops", r.kind === "service_unrecognised", String(r.kind));
  ok_("  having changed nothing at all", writes(r.log).length === 0, JSON.stringify(writes(r.log)));
}

// ── what the artist is shown ────────────────────────────────────────────────
ok_("no rebuild step says it's creating anything", REPAIR_STEPS.every((s) => !/creat/i.test(s.label)), REPAIR_STEPS.map((s) => s.label).join(" / "));

// ── never a mismatched editor ────────────────────────────────────────────────
//
// Just after a deploy, amply.stream serves old and new files side by side, and
// a rebuild once installed a new service with the old editor.
{
  const worker = (v) => `var VERSION = "${v}";`;
  const editor = (v) => `<!doctype html><meta name="amply-version" content="${v}">`;
  let served;   // what amply.stream hands out, call by call
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!/^https?:/.test(u)) {
      const now = served.shift() ?? served.last;
      served.last = now;
      if (u.includes("node-version")) return new Response(JSON.stringify({ version: now.version, schema: [], migrations: [] }));
      if (u.includes("manage")) return new Response(editor(now.editor));
      return new Response(worker(now.worker));
    }
    return new Response(JSON.stringify(ok({})));
  };
  const ctx = { versionUrl: "/node-version.json", workerUrl: "/node-worker.js", editorUrl: "/node-manage" };
  const same = { version: "2", worker: "2", editor: "2" };
  const halfway = { version: "2", worker: "2", editor: "1" };

  served = [halfway, halfway, halfway, same, same, same];
  const got = await fetchRelease(ctx, { tries: 3, wait: 0 });
  ok_("mid-deploy, it waits for the editor to catch up, then takes both",
    versionOfWorker(got.worker) === "2" && versionOfEditor(got.editor) === "2", JSON.stringify(got));

  served = [halfway];
  let kind = null;
  await fetchRelease(ctx, { tries: 3, wait: 0 }).catch((e) => { kind = e.kind; });
  ok_("  and if it never does, stops: amply.stream is mid-update", kind === "mid_update", String(kind));

  // A whole rebuild, caught mid-deploy: nothing in the account is touched.
  served = [halfway];
  const log = cloudflare({ bindings: [{ type: "d1", name: "DB", id: DB }, { type: "r2_bucket", name: "MEDIA", bucket_name: "b" }] });
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (/^https?:/.test(u)) return real(url, init);
    return new Response(u.includes("node-version") ? JSON.stringify({ version: "2" }) : u.includes("manage") ? editor("1") : worker("2"));
  };
  store.clear();
  let rebuilt = null;
  try {
    await provision({ token: "t", relay: "https://relay.test", artistName: "hollow", slug: "hollow", mode: "repair", withAccess: false,
      releaseCheck: { tries: 2, wait: 0 } });
  } catch (e) { rebuilt = e.kind; }
  ok_("  a rebuild caught mid-deploy changes nothing in the account", rebuilt === "mid_update" && log.length === 0, `${rebuilt}, ${log.length} requests`);
}

// The files this repo builds always agree, so a deploy is never half a release.
{
  const { readFile } = await import("node:fs/promises");
  const site = (f) => readFile(new URL(`../site/${f}`, import.meta.url), "utf8");
  const v = JSON.parse(await site("node-version.json")).version;
  const w = versionOfWorker(await site("node-worker.js"));
  const e = versionOfEditor(await site("node-manage.html"));
  ok_("the built service, editor and version list are one release", v && w === v && e === v, `${v} / ${w} / ${e}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
