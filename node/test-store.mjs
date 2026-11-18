/**
 * The rules the listener database has to keep, against a real SQLite.
 *
 * Two of these are security properties rather than features:
 *
 *   - a wallet an artist has stopped serving cannot lift its own ban by
 *     exercising its right to erasure;
 *   - saying hello, which is unauthenticated and free to do, cannot create
 *     rows, or a stranger could spend an artist's whole daily write budget
 *     and fill their database for the price of a signature.
 *
 * Run via `npm run test:store`. Uses node:sqlite, wrapped to look like D1.
 */
import { DatabaseSync } from "node:sqlite";
import { SCHEMA, seen, counted, listener, listeners, setBlocked, forget, signingKey, pruneStale, pruneHourly, remove, heard, playsToday } from "./src/store.ts";

/** The slice of D1's interface store.ts actually uses. */
function d1(db) {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        async run() { stmt.run(...args); },
        async first() { return stmt.get(...args) ?? null; },
        async all() { return { results: stmt.all(...args) }; },
      };
      return api;
    },
  };
}

const db = new DatabaseSync(":memory:");
for (const table of SCHEMA) db.exec(table);
const DB = d1(db);

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

const A = "WalletAAAA1111111111111111111111111111111111";
const B = "WalletBBBB2222222222222222222222222222222222";

// ── saying hello is free, and must stay cheap for the artist ────────────────

await seen(DB, A);
ok("hello from an unknown wallet creates no row", (await listener(DB, A)) === null);

await counted(DB, A, 200);
ok("playing something does create one", (await listener(DB, A))?.plays === 1);

const before = (await listener(DB, A)).last_seen;
await seen(DB, A, before + 5000);
ok("hello from a known wallet updates when they were last here",
  (await listener(DB, A)).last_seen === before + 5000);

// ── what a play records ─────────────────────────────────────────────────────

await counted(DB, A, 300);
const twice = await listener(DB, A);
ok("plays add up", twice.plays === 2);
ok("so do seconds", twice.seconds === 500);
await counted(DB, A, 99999);
ok("an absurd claim is clamped to three hours (a long mix, not a day)", (await listener(DB, A)).seconds === 500 + 3 * 3600);
await counted(DB, A, -50);
ok("a negative one counts as nothing", (await listener(DB, A)).seconds === 500 + 3 * 3600);

// ── the ban, and the hole that used to be in it ─────────────────────────────

await setBlocked(DB, A, true);
ok("an artist can stop serving a wallet", (await listener(DB, A)).blocked === 1);

await forget(DB, A);
const after = await listener(DB, A);
ok("a blocked wallet asking to be forgotten stays blocked", after?.blocked === 1);
ok("  and everything about their listening is erased",
  after.plays === 0 && after.seconds === 0 && after.first_seen === 0 && after.last_seen === 0);

await counted(DB, A, 100);
ok("if they come back, counting starts again from nothing",
  (await listener(DB, A)).seconds === 100 && (await listener(DB, A)).blocked === 1);

// ── erasure for everybody else is a deletion, as it says ────────────────────

await counted(DB, B, 60);
await forget(DB, B);
ok("a wallet nobody blocked is deleted outright", (await listener(DB, B)) === null);

// ── blocking a wallet that has no row yet still sticks ──────────────────────

const C = "WalletCCCC3333333333333333333333333333333333";
await setBlocked(DB, C, true);
ok("blocking an unseen wallet is remembered", (await listener(DB, C))?.blocked === 1);
await setBlocked(DB, C, false);
ok("and can be undone", (await listener(DB, C))?.blocked === 0);

// ── the token secret ────────────────────────────────────────────────────────

const first = await signingKey(DB);
ok("a signing key is made on demand", /^[0-9a-f]{64}$/.test(first));
ok("and is the same one next time", (await signingKey(DB)) === first);

// ── not keeping it forever ──────────────────────────────────────────────────
//
// Storage limitation: a record should not outlive its use. A year after a
// wallet was last heard from, its totals go — except the bare record of a
// wallet the artist has barred, which exists only to keep the bar standing.

{
  const NOW = Date.UTC(2027, 0, 1);
  const YEAR = 365 * 86400_000;
  const OLD = "WalletOLD0000000000000000000000000000000000";
  const RECENT = "WalletNEW0000000000000000000000000000000000";
  const BARRED = "WalletBAR0000000000000000000000000000000000";

  await counted(DB, OLD, 60, NOW - YEAR - 86400_000);        // a year and a day ago
  await counted(DB, RECENT, 60, NOW - 30 * 86400_000);        // last month
  await counted(DB, BARRED, 60, NOW - 2 * YEAR);              // long ago, and barred
  await setBlocked(DB, BARRED, true);

  await pruneStale(DB, NOW);
  ok("a wallet not heard from in over a year is deleted", (await listener(DB, OLD)) === null);
  ok("  one heard from last month is kept", (await listener(DB, RECENT)) !== null);
  ok("  and a barred one stays barred however old", (await listener(DB, BARRED))?.blocked === 1);

  // From plays, at most hourly: the clean-up reads the whole table.
  const STALE1 = "WalletST10000000000000000000000000000000000";
  const STALE2 = "WalletST20000000000000000000000000000000000";
  await counted(DB, STALE1, 60, NOW - 2 * YEAR);
  ok("pruning from plays runs when it hasn't lately", (await pruneHourly(DB, NOW)) && (await listener(DB, STALE1)) === null);
  await counted(DB, STALE2, 60, NOW - 2 * YEAR);
  ok("  but not again within the hour", !(await pruneHourly(DB, NOW + 59 * 60_000)) && (await listener(DB, STALE2)) !== null);
  ok("  and an hour on, it does", (await pruneHourly(DB, NOW + 61 * 60_000)) && (await listener(DB, STALE2)) === null);
  ok("  a time recorded in the future doesn't stop it for ever", (await pruneHourly(DB, NOW)));
  ok("finding stale wallets uses an index on last_seen",
    /listeners_by_last_seen/.test(JSON.stringify(db.prepare("EXPLAIN QUERY PLAN DELETE FROM listeners WHERE blocked = 0 AND last_seen < ?").all(0))));
}

// ── the artist deleting a record themselves ─────────────────────────────────

{
  const ASKED = "WalletASK0000000000000000000000000000000000";
  await counted(DB, ASKED, 120);
  await setBlocked(DB, ASKED, true);
  await remove(DB, ASKED);
  ok("an artist can delete a record outright, bar and all", (await listener(DB, ASKED)) === null);
}

// ── the artist's own view ───────────────────────────────────────────────────

const rows = await listeners(DB);
ok("the listeners list is ordered by how much they listened",
  rows.length >= 2 && rows[0].seconds >= rows[rows.length - 1].seconds);

// ── the schema as artists receive it ────────────────────────────────────────
// Setup and updates run site/node-version.json, not this file. Its statements
// are lifted out of store.ts by a script, which once published a word from a
// comment as a statement and broke every artist's update. So: run exactly
// what's published, on a fresh database, and on one that already has it.
{
  const { readFileSync } = await import("node:fs");
  const published = JSON.parse(readFileSync(new URL("../site/node-version.json", import.meta.url), "utf8"));
  const fresh = new DatabaseSync(":memory:");
  let broke = null;
  for (const sql of published.schema) { try { fresh.exec(sql); } catch (e) { broke = `${sql.slice(0, 60)} — ${e.message}`; break; } }
  ok("every published statement runs on a new database", !broke, broke);
  broke = null;
  for (const sql of published.schema) { try { fresh.exec(sql); } catch (e) { broke = `${sql.slice(0, 60)} — ${e.message}`; break; } }
  ok("  and again on one that already has them (an update)", !broke, broke);
  ok("  and they're the same statements store.ts declares", published.schema.length === SCHEMA.length, `${published.schema.length} vs ${SCHEMA.length}`);
}

// ── plays per day, for the editor's "free streams" bar ──────────────────────
{
  const NOON = Date.parse("2026-11-17T12:00:00Z");
  const before = await playsToday(DB, NOON);
  await heard(DB, "t1", 200, NOON);
  await heard(DB, "t2", 200, NOON);
  await heard(DB, "t1", 200, NOON + 11 * 3_600_000);   // 23:00 UTC, still today
  ok("today's plays are counted, every song together", (await playsToday(DB, NOON)) === before + 3, String(await playsToday(DB, NOON)));
  ok("  and start again after midnight UTC", (await playsToday(DB, NOON + 13 * 3_600_000)) === 0);
  ok("  while each song's own total still counts too",
    db.prepare("SELECT plays FROM track_plays WHERE track = 't1'").get().plays === 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
