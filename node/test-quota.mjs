/**
 * Cloudflare's free-plan limits, told to the artist plainly (quota.ts).
 *
 *   node --experimental-strip-types node/test-quota.mjs
 */
import { quotaFailure, hoursToReset } from "./src/quota.ts";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

const NOON = Date.parse("2026-11-17T12:00:00Z");
const said = (msg) => quotaFailure(new Error(msg), NOON);

ok("twelve hours from noon UTC to the reset", hoursToReset(NOON) === 12);
ok("  and never less than one", hoursToReset(Date.parse("2026-11-17T23:59:30Z")) === 1);

const writes = said("KV put() limit exceeded for the day.");
ok("KV's daily write limit: a 429 about changes", writes?.status === 429 && /limit for changes today/.test(writes.message), JSON.stringify(writes));
ok("  saying when it comes back", /midnight UTC, in about 12 hours/.test(writes?.message));
ok("KV's daily delete limit counts as changes", said("KV delete() limit exceeded for the day.")?.status === 429);
const reads = said("KV get() limit exceeded for the day.");
ok("KV's daily read limit: the page is resting", reads?.status === 503 && /free daily limit/.test(reads.message), JSON.stringify(reads));
ok("D1's daily row writes count as changes", said("D1_ERROR: Exceeded daily row write limit")?.status === 429);
ok("D1's daily row reads rest the page", said("D1_ERROR: Exceeded daily row read limit")?.status === 503);
const full = said("D1_ERROR: Exceeded maximum DB size");
ok("a full database: storage is full", full?.status === 507 && /storage is full/.test(full.message), JSON.stringify(full));
ok("  as is SQLite's own word for it", said("SQLITE_FULL: database or disk is full")?.status === 507);
ok("anything else is left alone", said("TypeError: x is undefined") === null && said("D1_ERROR: no such table") === null);
ok("  including a thrown string", quotaFailure("something broke", NOON) === null);

// ── and in the editor ───────────────────────────────────────────────────────
{
  const { explain } = await import("../manage/src/node-api.js");
  const page = "<!DOCTYPE html><title>Worker exceeded resource limits</title><h1>Error 1027</h1><p>This website has been temporarily rate limited</p>";
  ok("Cloudflare's own 1027 page: the daily limit, in words", /free daily limit of 100,000 requests/.test(explain(429, page)));
  ok("the node's own words are shown", explain(429, JSON.stringify({ error: writes.message })) === writes.message);
  ok("any other page of HTML isn't shown as text", explain(502, "<html><body>Bad gateway</body></html>") === "Your streaming service returned 502.");
  ok("plain words are", explain(500, "something broke") === "something broke");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
