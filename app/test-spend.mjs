/**
 * The money-safety rules, from the attacker's side.
 *
 * The manifest is a file from a stranger that names a price. These cases are
 * written as the things a hostile or careless one might try, because that is
 * the only useful way to check a defence.
 *
 * Run via `npm --prefix app run test`.
 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const s = await import("./src/spend.js");
const { toMicros } = await import("./src/pay.js");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};
const is = (name, got, want) => ok(name, Object.is(got, want), `expected ${want}, got ${got}`);

const URL_A = "https://a.test/manifest.json";
const owed = (ledger, url) => (ledger[url]?.micros ?? 0);

// ── the ceiling ─────────────────────────────────────────────────────────────

is("an ordinary rate is honoured", s.clampRate(0.01), 0.01);
is("a rate at the app's ceiling", s.clampRate(s.MAX_RATE), s.MAX_RATE);
is("a dollar a minute, which the spec's validator would allow, is capped", s.clampRate(1), s.MAX_RATE);
is("a thousand a minute is capped", s.clampRate(1000), s.MAX_RATE);
is("a negative rate is nothing", s.clampRate(-5), 0);
is("a rate that is not a number is nothing", s.clampRate("free"), 0);
is("infinity is refused outright, not clamped to the ceiling", s.clampRate(Infinity), 0);
is("NaN is nothing", s.clampRate(NaN), 0);

// ── nothing is adopted silently ─────────────────────────────────────────────

store.clear();
is("any rate from an unknown artist is asked about, once", s.rateStatus(URL_A, 0.01).ask, true);
is("a dearer one does", s.rateStatus(URL_A, 0.05).ask, true);
is("  and says why", s.rateStatus(URL_A, 0.05).why, "new");

const agreed = s.agreeRate(URL_A, 0.05);
is("once agreed, it is charged", s.rateStatus(URL_A, 0.05, agreed).ask, false);
is("a drop needs no asking", s.rateStatus(URL_A, 0.02, agreed).ask, false);
is("a rise does", s.rateStatus(URL_A, 0.06, agreed).ask, true);
is("  and is called an increase", s.rateStatus(URL_A, 0.06, agreed).why, "increase");
is("  remembering what was agreed", s.rateStatus(URL_A, 0.06, agreed).was, 0.05);

// ── money accrues at the price it was heard at ──────────────────────────────

store.clear();
{
  // A minute at a cent, then the artist raises the rate tenfold and the
  // listener plays another minute.
  s.agreeRate(URL_A, 0.01);
  let ledger = s.accrue({}, URL_A, 60, 0.01);
  is("a minute at a cent owes a cent", owed(ledger, URL_A), toMicros(0.01));

  const after = s.agreeRate(URL_A, 0.1);
  ledger = s.accrue(ledger, URL_A, 60, 0.1, { agreed: after });
  is("a minute at ten cents adds ten", owed(ledger, URL_A), toMicros(0.11));
  ok("  so the first minute was not repriced", owed(ledger, URL_A) !== toMicros(0.2));
}

store.clear();
{
  // The attack the old design allowed: listen cheaply, get billed dearly.
  s.agreeRate(URL_A, 0.001);
  let ledger = s.accrue({}, URL_A, 3600, 0.001);       // an hour at a tenth of a cent
  const before = owed(ledger, URL_A);
  const after = s.agreeRate(URL_A, 0.1);               // now charge a hundred times more
  ledger = s.accrue(ledger, URL_A, 0, 0.1, { agreed: after });
  is("an hour already listened to cannot be repriced", owed(ledger, URL_A), before);
  is("  and it is what it was", before, toMicros(0.06));
}

// ── an unagreed rate accrues nothing at all ─────────────────────────────────

store.clear();
{
  const ledger = s.accrue({}, URL_A, 600, 0.09);       // dear, never agreed
  is("listening is free until the price is agreed", owed(ledger, URL_A), 0);
  const yes = s.agreeRate(URL_A, 0.09);
  const then = s.accrue(ledger, URL_A, 60, 0.09, { agreed: yes });
  is("  and only counts from the moment it is", owed(then, URL_A), toMicros(0.09));
}

store.clear();
{
  // A hostile manifest asking for a dollar a minute, agreed to by a listener
  // who did not read it: the ceiling still applies.
  const yes = s.agreeRate(URL_A, 1);
  const ledger = s.accrue({}, URL_A, 60, 1, { agreed: yes });
  is("even agreed, nothing accrues above the ceiling", owed(ledger, URL_A), toMicros(s.MAX_RATE));
}

// ── settling ────────────────────────────────────────────────────────────────

store.clear();
{
  s.agreeRate(URL_A, 0.01);
  let ledger = s.accrue({}, URL_A, 600, 0.01);         // ten minutes, ten cents
  is("ten minutes at a cent", owed(ledger, URL_A), toMicros(0.1));
  ledger = s.settled(ledger, URL_A, toMicros(0.04));
  is("part payment leaves the rest owed", owed(ledger, URL_A), toMicros(0.06));
  ledger = s.settled(ledger, URL_A, toMicros(0.06));
  is("paying it all clears the debt", ledger[URL_A], undefined);
  ledger = s.settled(ledger, URL_A, toMicros(5));
  is("overpaying cannot make a debt negative", owed(ledger, URL_A), 0);
}

// ── the daily limit ─────────────────────────────────────────────────────────

store.clear();
is("an ordinary payment is fine", s.withinLimits(toMicros(0.2)).ok, true);
is("one enormous payment is refused", s.withinLimits(toMicros(5)).ok, false);
is("  for being too big at once", s.withinLimits(toMicros(5)).why, "payment");

store.clear();
s.recordSpend(toMicros(9.5));
is("a payment that would break the daily limit is refused", s.withinLimits(toMicros(1)).ok, false);
is("  for the day, not the payment", s.withinLimits(toMicros(1)).why, "daily");
is("one that fits still goes", s.withinLimits(toMicros(0.4)).ok, true);

const tomorrow = Date.now() + 86400e3;
is("and the limit is a day, not a lifetime", s.withinLimits(toMicros(1), tomorrow).ok, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
