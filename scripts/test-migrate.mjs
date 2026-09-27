/**
 * Does a rebuild actually bring an artist's database up to date?
 *
 * Creating a table is idempotent; altering one is not. So a change to an
 * existing table carries an id, and the highest id applied is recorded in the
 * artist's own settings table. This is the part that runs unattended inside
 * somebody else's account, where nobody can go and look at what happened, so
 * it is tested with migrations that do not exist yet.
 *
 *   node scripts/test-migrate.mjs
 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { provision, ProvisionError } = await import("../site/js/provision.js");

const ACC = "0123456789abcdef0123456789abcdef";
const ok = (result) => ({ success: true, errors: [], result });

/**
 * A fake Cloudflare that remembers what was run against the database.
 *
 * `applied` is what the artist's settings table already says, and `breaks` is
 * the id of a change that fails, for the half-finished case.
 */
function cloudflare({ migrations, applied = null, breaks = null }) {
  const ran = [];
  let recorded = applied;

  globalThis.fetch = async (url, init = {}) => {
    if (!/^https?:/.test(url)) {
      const body = url.includes("node-version")
        ? JSON.stringify({
            version: "test",
            schema: ["CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)"],
            migrations,
          })
        : "export default {}";
      return new Response(body, { status: 200 });
    }

    const path = new URL(url).pathname.replace(/^\/api/, "");
    const method = init.method || "GET";

    if (path.endsWith("/query")) {
      const { sql, params } = JSON.parse(init.body);

      if (/^SELECT value FROM settings/.test(sql)) {
        return new Response(JSON.stringify(ok(
          recorded === null ? [{ results: [] }] : [{ results: [{ value: String(recorded) }] }],
        )), { status: 200 });
      }
      if (/^INSERT INTO settings/.test(sql) && params?.[0] === "schema-version") {
        recorded = Number(params[1]);
        return new Response(JSON.stringify(ok([])), { status: 200 });
      }
      if (/CREATE TABLE/.test(sql)) return new Response(JSON.stringify(ok([])), { status: 200 });

      const step = migrations.find((m) => m.sql === sql);
      if (step && step.id === breaks) {
        return new Response(JSON.stringify({
          success: false, errors: [{ code: 7500, message: "duplicate column name: mood" }], result: null,
        }), { status: 200 });
      }
      ran.push(step ? step.id : sql);
      return new Response(JSON.stringify(ok([])), { status: 200 });
    }

    const body = path === "/accounts" ? ok([{ id: ACC, name: "Test" }])
      : path.endsWith("/r2/buckets") && method === "GET" ? ok({ buckets: [] })
      : path.includes("/d1/database") && method === "GET" ? ok([])
      : path.endsWith("/d1/database") && method === "POST" ? ok({ uuid: "11111111-2222-3333-4444-555555555555" })
      : ok({ id: "fedcba9876543210fedcba9876543210" });
    return new Response(JSON.stringify(body), { status: 200 });
  };

  return { ran, recorded: () => recorded };
}

async function rebuild(setup) {
  store.clear();
  const fake = cloudflare(setup);
  let error = null;
  try {
    await provision({
      token: "t", relay: "https://relay.test", artistName: "Test", slug: "test",
      mode: "repair", withAccess: false,
    });
  } catch (e) {
    error = e instanceof ProvisionError ? e.kind : String(e);
  }
  return { ...fake, error };
}

let pass = 0, fail = 0;
const is = (name, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  good ? pass++ : fail++;
  console.log(`${good ? "ok  " : "FAIL"}  ${name}${good ? "" : ` — expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`}`);
};

const THREE = [
  { id: 1, sql: "ALTER TABLE listeners ADD COLUMN mood TEXT" },
  { id: 2, sql: "CREATE INDEX IF NOT EXISTS by_seen ON listeners (last_seen)" },
  { id: 3, sql: "ALTER TABLE settings ADD COLUMN changed INTEGER" },
];

// A service that has never had one: everything runs, in order.
let r = await rebuild({ migrations: THREE });
is("a database that has never been changed gets every change", r.ran, [1, 2, 3]);
is("  and remembers how far it got", r.recorded(), 3);
is("  without failing", r.error, null);

// Part way along: only what is newer.
r = await rebuild({ migrations: THREE, applied: 1 });
is("one already applied means only the rest run", r.ran, [2, 3]);
is("  and the record moves forward", r.recorded(), 3);

// Already current: nothing runs at all. This is the ordinary rebuild, and it
// must not touch the database.
r = await rebuild({ migrations: THREE, applied: 3 });
is("an up-to-date database is left alone", r.ran, []);
is("  and its record is unchanged", r.recorded(), 3);

// Today's case, and the one that must not break: no migrations published.
r = await rebuild({ migrations: [] });
is("no changes to make means nothing is asked of the database", r.ran, []);
is("  and no version is recorded where there is nothing to record", r.recorded(), null);

// One fails. Later ones must not run on top of it, and the record must say
// what is actually true rather than what was hoped for.
r = await rebuild({ migrations: THREE, breaks: 2 });
is("a change that fails stops the ones after it", r.ran, [1]);
is("  the record shows only what worked", r.recorded(), 1);
is("  and the artist is told", r.error, "migration");

// Then they run it again, and it picks up from where it stopped.
r = await rebuild({ migrations: THREE, applied: 1 });
is("running it again after a failure resumes", r.ran, [2, 3]);

// Out of order in the file is still applied in order.
r = await rebuild({ migrations: [THREE[2], THREE[0], THREE[1]] });
is("changes are applied in id order however they are listed", r.ran, [1, 2, 3]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
