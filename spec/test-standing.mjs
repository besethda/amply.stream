/**
 * Where a listener stands (standing.mjs): the rules both the editor and the
 * artist's server apply, so they can never disagree about who is behind.
 *
 *   node spec/test-standing.mjs
 */
import { owedOf, behind, overdue, unpaidOf, autoBlock, DAY } from "./standing.mjs";
import { LISTEN_MIN_MICROS } from "./pricing.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};
const c = (cents) => cents * 10_000;
const NOW = 1_800_000_000_000;

ok("listening priced when heard is what it cost", owedOf({ seconds: 600, owed_seconds: 600, owed_micros: c(7) }, 0.05) === c(7));
ok("  listening from before that is estimated at today's price", owedOf({ seconds: 1200, owed_seconds: 600, owed_micros: c(7) }, 0.01) === c(7) + c(10));
ok("  and with no price, nothing more", owedOf({ seconds: 1200, owed_seconds: 600, owed_micros: c(7) }, 0) === c(7));
ok("  a row with nothing in it owes nothing", owedOf({}, 0.01) === 0 && owedOf(null, 0.01) === 0);

ok("behind: over one and a half payments unpaid", behind(c(76), 0, 0.5) && !behind(c(75), 0, 0.5));
ok("overdue: unpaid past the week and a day", overdue(c(30), 0, NOW - 9 * DAY, NOW) && !overdue(c(30), 0, NOW - 7.5 * DAY, NOW));
ok("  never for a wallet never heard from (last seen 0)", !overdue(c(30), 0, 0, NOW));
ok("unpaid is whole micros, never below nothing", unpaidOf(1000.6, 0) === 1001 && unpaidOf(10, 50) === 0);

const row = { seconds: 0, owed_seconds: 0, owed_micros: c(500), last_seen: NOW };
const terms = { ratePerMinute: 0.01, settleAt: 0.5, now: NOW };
ok("auto-block: $5 behind is refused, owing $5", JSON.stringify(autoBlock(row, 0, terms)) === JSON.stringify({ blocked: true, owes: c(500) }));
ok("  paid up: served", !autoBlock(row, c(500), terms).blocked);
ok("  paid more than it owes: served, owing nothing", JSON.stringify(autoBlock(row, c(900), terms)) === JSON.stringify({ blocked: false, owes: 0 }));
ok("  a subscriber: served, though what's owed is still said", JSON.stringify(autoBlock(row, 0, { ...terms, subscribed: true })) === JSON.stringify({ blocked: false, owes: c(500) }));
ok("  no price by the minute: nobody owes anything", JSON.stringify(autoBlock(row, 0, { ...terms, ratePerMinute: 0 })) === JSON.stringify({ blocked: false, owes: 0 }));
ok("  no record: never refused", !autoBlock(null, 0, terms).blocked);
ok("  overdue but under a cent: can't be paid alone, so served", !autoBlock({ ...row, owed_micros: LISTEN_MIN_MICROS - 1, last_seen: NOW - 30 * DAY }, 0, terms).blocked);
ok("  overdue at a few cents: refused", autoBlock({ ...row, owed_micros: c(30), last_seen: NOW - 30 * DAY }, 0, terms).blocked);
ok("  no payment point published: a dollar, as the editor assumes", !autoBlock({ ...row, owed_micros: c(140) }, 0, { ...terms, settleAt: undefined }).blocked
  && autoBlock({ ...row, owed_micros: c(160) }, 0, { ...terms, settleAt: undefined }).blocked);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
