/**
 * The price control's arithmetic.
 *
 * Two inputs drive one number: a slider that is deliberately non-linear, and a
 * typed figure in cents while the manifest stores dollars. Both have to agree,
 * and neither may produce a rate the spec will reject, because the artist finds
 * out about that only when publishing fails.
 *
 * Run via `npm --prefix manage run test`.
 */
import { fromSlider, toSlider, cents, RATE_MAX, SLIDER_STEPS, sizeAdvice,
  settleFor, batchOf, withPrice, BATCHES, DEFAULT_BATCH } from "./src/ui.jsx";
import { validate } from "../spec/manifest-rules.mjs";

let pass = 0, fail = 0;
const is = (name, got, want) => {
  const ok = Object.is(got, want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : ` — expected ${want}, got ${got}`}`);
};
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

// Ends of the track.
is("slider at 0 is free", fromSlider(0), 0);
is("slider at the top is the cap", fromSlider(SLIDER_STEPS), RATE_MAX);
is("cap is 5c a minute", RATE_MAX * 100, 5);

is("one step is a hundredth of a cent", fromSlider(1) * 100, 0.01);
is("halfway is half the cap", fromSlider(SLIDER_STEPS / 2), RATE_MAX / 2);

// The dead zone that made this linear: with a curve, the first stretch of
// travel all rounded to the same displayed price and dragging did nothing.
const distinct = new Set();
for (let v = 0; v <= SLIDER_STEPS; v++) distinct.add(fromSlider(v));
is("every step is its own price, no dead zone", distinct.size, SLIDER_STEPS + 1);

// Monotonic, or dragging right could lower the price.
let rising = true;
for (let v = 1; v <= SLIDER_STEPS; v++) {
  if (fromSlider(v) < fromSlider(v - 1)) { rising = false; break; }
}
ok("the slider never goes backwards", rising);

// Round trip: a rate set by the slider must put the handle back exactly.
let worst = 0;
for (let v = 0; v <= SLIDER_STEPS; v++) {
  worst = Math.max(worst, Math.abs(toSlider(fromSlider(v)) - v));
}
is("slider round trip is exact", worst, 0);

// Nothing the control can produce may be outside what the spec accepts.
let inRange = true;
for (let v = 0; v <= SLIDER_STEPS; v++) {
  const r = fromSlider(v);
  if (r < 0 || r > 1.0 || !Number.isFinite(r)) { inRange = false; break; }
}
ok("every slider position is a rate the spec allows", inRange);

// Out-of-range rates still land on the track rather than off the end.
is("a rate above the cap pins to the top", toSlider(10), SLIDER_STEPS);
is("a negative rate pins to the bottom", toSlider(-1), 0);

// Typed cents to stored dollars, at the resolution the slider works in.
const typed = (c) => Math.round(Math.min(Math.max(c, 0), RATE_MAX * 100) * 100) / 10000;
is("typing 1 gives a cent a minute", typed(1), 0.01);
is("typing 0.75 gives three quarters of a cent", typed(0.75), 0.0075);
is("typing 0.01 gives a hundredth of a cent", typed(0.01), 0.0001);
is("typing 5 gives the cap", typed(5), RATE_MAX);
is("typing past the cap clamps", typed(500), RATE_MAX);
is("typing a negative clamps to free", typed(-3), 0);

// What the artist reads back.
is("free reads as free", cents(0), "free");
is("a cent", cents(0.01), "1¢");
is("three quarters of a cent keeps its decimals", cents(0.0075), "0.75¢");
is("a tenth of a cent", cents(0.001), "0.1¢");
is("the cap", cents(RATE_MAX), "5¢");
is("a four-minute song at a cent a minute", cents(0.01 * 4), "4¢");

// How often listeners pay. The artist picks songs; the manifest stores dollars.
is("every 5 songs at a cent a minute is 20c", settleFor(5, 0.01), 0.2);
is("every song at a cent a minute is 4c", settleFor(1, 0.01), 0.04);
is("every song at the cheapest price still sends at least a cent", settleFor(1, 0.0001), 0.01);
is("every 10 songs at the cap is $2", settleFor(10, RATE_MAX), 2);
is("a stored 20c at a cent a minute reads back as every 5 songs", batchOf({ ratePerMinute: 0.01, settleAt: 0.2 }), 5);
is("an old $20 threshold reads back as the largest batch", batchOf({ ratePerMinute: 0.01, settleAt: 20 }), 10);
is("no threshold yet defaults to every 5 songs", batchOf({ ratePerMinute: 0.01 }), DEFAULT_BATCH);
{
  const before = { type: "solana-usdc", ratePerMinute: 0.01, settleAt: settleFor(5, 0.01) };
  const after = withPrice(before, 0.02);
  is("doubling the price doubles the threshold", after.settleAt, 0.4);
  is("  so it is still every 5 songs", batchOf(after), 5);
  is("going free leaves the threshold alone", withPrice(before, 0).settleAt, before.settleAt);
}
{
  // Every threshold the control can produce must pass the spec, at every
  // price the slider can set.
  let bad = null;
  for (let v = 1; v <= SLIDER_STEPS && !bad; v++) {
    for (const b of BATCHES) {
      const m = { amply: 1, updated: "2026-09-19T00:00:00Z", artist: { name: "x" }, releases: [],
        payment: [{ type: "solana-usdc", address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
                    ratePerMinute: fromSlider(v), settleAt: settleFor(b, fromSlider(v)) }] };
      const { errors } = validate(m);
      if (errors.length) { bad = `${cents(fromSlider(v))}, every ${b}: ${errors[0]}`; break; }
    }
  }
  ok("every price and batch the editor can make is a valid manifest", !bad, bad);
}

// The too-large-to-stream flag. Judged by bitrate, so format alone never
// trips it and a long lossy file never does either.
const kb = (kbps, sec) => (kbps * 1000 * sec) / 8;
ok("the real first upload is flagged: 46MB WAV, 2:54", !!sizeAdvice(46101094, 174));
is("it reports the size the artist will recognise", sizeAdvice(46101094, 174)?.now, 46);
is("and roughly what an MP3 would be", sizeAdvice(46101094, 174)?.after, "5.6");
ok("CD-quality WAV is flagged", !!sizeAdvice(kb(1411, 200), 200));
ok("typical FLAC is flagged", !!sizeAdvice(kb(850, 200), 200));
ok("a 320kbps MP3 is not", !sizeAdvice(kb(320, 200), 200));
ok("a 256kbps M4A is not", !sizeAdvice(kb(256, 200), 200));
ok("a long 320kbps mix is not, whatever its size", !sizeAdvice(kb(320, 3600), 3600));
ok("unknown size is not flagged", !sizeAdvice(null, 200));
ok("unknown length is not flagged", !sizeAdvice(46101094, 0));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
