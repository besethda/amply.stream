/**
 * Waves files: bands split by frequency, on time, and read back as written.
 *
 * Run via `npm run test:pricing` (with the other spec tests).
 */
import { startWaves, feedWaves, finishWaves, readWaves, waveAt, wavesFrom, WAVES_BANDS, WAVES_FPS } from "./waves.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

// A one-second tone at the middle of several bands, one after another, from
// the bass up (the bands' middles, geometrically, so each is squarely inside).
const rate = 16000;
const step = Math.max(1, Math.floor((WAVES_BANDS.length - 1) / 7));
const picks = Array.from({ length: Math.min(7, WAVES_BANDS.length - 1) }, (_, k) => 1 + k * step);
const tones = picks.map((b, k) => {
  const [from, to] = WAVES_BANDS[b];
  return [k + 1, Math.round(Math.sqrt(Math.max(from, 20) * to)), b];
});
const secs = tones.length + 2, pcm = new Float32Array(rate * secs);
for (const [at, f] of tones) {
  for (let i = at * rate; i < (at + 0.8) * rate; i++) pcm[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / rate);
}
const a = startWaves(rate, secs);
for (let at = 0; at < pcm.length; at += 7000) feedWaves(a, pcm.subarray(at, at + 7000));   // in uneven pieces
const bytes = finishWaves(a);
const w = readWaves(bytes);
const perMinute = bytes.length / secs * 60 / 1024;

ok("reads back what was written", w.version === 1 && w.fps === WAVES_FPS && w.frames === secs * WAVES_FPS && w.bands.length === WAVES_BANDS.length);
ok(`${WAVES_BANDS.length} bands, low to high, with no gaps`, WAVES_BANDS.every((b, i) => i === 0 || b[0] === WAVES_BANDS[i - 1][1]));
// One byte per band per frame, plus a small header: about 14 KB a minute.
ok("about 14 KB a minute", Math.abs(perMinute - WAVES_BANDS.length * WAVES_FPS * 60 / 1024) < 1.5 && perMinute < 16, `${perMinute.toFixed(1)} KB`);

// Each band is kept on its own scale; its ceiling puts it back on a common one.
const real = (b, t) => (waveAt(w, b, t) ** 2) * w.ceilings[b];
tones.forEach(([at, f, b]) => {
  const levels = w.bands.map((_, x) => real(x, at + 0.4));
  const loudest = levels.reduce((m, v, x) => (v > levels[m] ? x : m), 0);
  ok(`${f} Hz is loudest in its own band (${w.bands[b].join("–")} Hz)`, loudest === b, `loudest ${w.bands[loudest].join("–")}`);
  const before = waveAt(w, b, at - 0.1), after = waveAt(w, b, at + 0.1);
  ok(`  on time: quiet just before, up just after`, before < 0.2 && after > 0.8, `${before.toFixed(2)} → ${after.toFixed(2)}`);
});

ok("nothing before the start or after the end", waveAt(w, 3, -1) === 0 && waveAt(w, 3, 99) === 0);
ok("silence is zero, not noise", waveAt(w, 3, 0.4) === 0);

let threw = "";
try { readWaves(new Uint8Array(40)); } catch (e) { threw = e.message; }
ok("refuses something that isn't one", /not a waves file/.test(threw));
const future = bytes.slice(); future[4] = 2; threw = "";
try { readWaves(future); } catch (e) { threw = e.message; }
ok("refuses a version it doesn't know", /version 2/.test(threw));
threw = "";
try { readWaves(bytes.subarray(0, 200)); } catch (e) { threw = e.message; }
ok("refuses one cut short", /cut short/.test(threw));

// From something shaped like a decoded stereo AudioBuffer.
const stereo = { sampleRate: rate, length: pcm.length, numberOfChannels: 2, getChannelData: () => pcm };
const again = readWaves(await wavesFrom(stereo, { pause: async () => {} }));
ok("from a decoded song, the same result", again.levels.every((v, i) => v === w.levels[i]));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
