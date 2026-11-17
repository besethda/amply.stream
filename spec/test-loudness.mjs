/**
 * Loudness: the measurement against known references, and the correction
 * against what it promises (the right level, nothing over the ceiling).
 *
 *   node spec/test-loudness.mjs
 */
import { integratedLoudness, peakDb, gainFor, applyGain, normalize, needsStreamCopy, TARGET_LUFS, CEILING_DB } from "./loudness.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const RATE = 48000;
const sine = (freq, dbfs, seconds, rate = RATE) => {
  const a = Math.pow(10, dbfs / 20), n = Math.round(seconds * rate), x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = a * Math.sin(2 * Math.PI * freq * i / rate);
  return x;
};
let seed = 1;
const noise = (dbfs, seconds, rate = RATE) => {
  const a = Math.pow(10, dbfs / 20), n = Math.round(seconds * rate), x = new Float32Array(n);
  for (let i = 0; i < n; i++) { seed = (seed * 16807) % 2147483647; x[i] = a * (seed / 2147483647 * 2 - 1); }
  return x;
};

// ── measuring, against BS.1770's reference ─────────────────────────────────
{
  // The standard's own check: a 1 kHz sine at -20 dBFS in both channels reads
  // -20 LUFS (to within a tenth).
  const s = sine(997, -20, 10);
  const l = integratedLoudness([s, s], RATE);
  ok("a 1 kHz tone at -20 dBFS, stereo, reads -20 LUFS", near(l, -20, 0.1), l.toFixed(2));
  const m = integratedLoudness([s], RATE);
  ok("  the same tone in one channel reads 3 dB quieter", near(m, -23, 0.1), m.toFixed(2));
  const at44 = integratedLoudness([sine(997, -20, 10, 44100), sine(997, -20, 10, 44100)], 44100);
  ok("  and the same at 44.1 kHz", near(at44, -20, 0.1), at44.toFixed(2));
}
{
  const loud = integratedLoudness([sine(997, -8, 6), sine(997, -8, 6)], RATE);
  const quiet = integratedLoudness([sine(997, -26, 6), sine(997, -26, 6)], RATE);
  ok("18 dB quieter reads 18 LU lower", near(loud - quiet, 18, 0.1), `${loud.toFixed(2)} vs ${quiet.toFixed(2)}`);
  ok("low bass counts for less (the K-weighting)", integratedLoudness([sine(30, -20, 6)], RATE) < integratedLoudness([sine(997, -20, 6)], RATE) - 3);
}
{
  // A song with a long silence in the middle reads as loud as its music.
  const music = sine(997, -20, 5);
  const gap = new Float32Array(RATE * 20);
  const withGap = Float32Array.from([...music, ...gap, ...music]);
  const l = integratedLoudness([withGap, withGap], RATE);
  ok("silence in the middle doesn't make a song read quieter", near(l, -20, 0.2), l.toFixed(2));
  ok("pure silence reads as -Infinity, and asks for no change", integratedLoudness([new Float32Array(RATE * 3)], RATE) === -Infinity && gainFor(-Infinity) === 0);
}

// ── how much to change ─────────────────────────────────────────────────────
ok("a quiet home mix (-22 LUFS) is turned up 8 dB", gainFor(-22) === 8);
ok("a loud master (-7 LUFS) is turned down 7 dB", gainFor(-7) === -7);
ok("never up more than 10 dB, or down more than 20", gainFor(-40) === 10 && gainFor(15) === -20);
ok("one at the target is left alone", gainFor(TARGET_LUFS) === 0);

// ── correcting ─────────────────────────────────────────────────────────────
{
  // A quiet song with loud drum hits: turned up 10 dB, the hits would clip.
  const body = noise(-30, 8);
  for (let k = 0; k < 8; k++) for (let i = 0; i < 200; i++) body[k * RATE + i] = (i % 2 ? -1 : 1) * 0.5;   // -6 dBFS spikes
  const { out: [L, R], before, gainDb } = normalize([body, body], RATE);
  const ceiling = Math.pow(10, CEILING_DB / 20);
  ok("turned up, nothing goes over the ceiling", peakDb([L, R]) <= CEILING_DB + 1e-6, peakDb([L, R]).toFixed(2));
  const after = integratedLoudness([L, R], RATE);
  ok("  and it reaches the target, or stops at the 10 dB cap trying", near(after, TARGET_LUFS, 0.5) || (gainDb === 10 && after > before + 5), `${before.toFixed(1)} → ${after.toFixed(1)} at +${gainDb.toFixed(1)} dB`);
  let jump = 0;
  for (let i = 1; i < L.length; i++) jump = Math.max(jump, Math.abs(L[i] - L[i - 1]));
  ok("  without making new jumps bigger than the music's own", jump <= 2 * ceiling + 1e-6);
  ok("  the samples stay real numbers", L.every(Number.isFinite));
}
{
  const s = sine(997, -6, 4);
  const [L] = applyGain([s], RATE, -8);
  ok("turning down is exact", near(peakDb([L]), -14, 0.01), peakDb([L]).toFixed(3));
}
{
  const s = sine(997, -20, 2);
  const [L] = applyGain([s], RATE, 6);
  ok("turning up with room to spare is exact, no limiting", near(peakDb([L]), -14, 0.01));
}

{
  const loudMaster = noise(-3, 6);
  const r = normalize([loudMaster, loudMaster], RATE);
  ok("a loud master comes down to the target", near(r.after, TARGET_LUFS, 0.3), `${r.before.toFixed(1)} → ${r.after.toFixed(1)}`);
  const veryQuiet = noise(-45, 6);
  const q = normalize([veryQuiet, veryQuiet], RATE);
  ok("a very quiet song is lifted by at most 10 dB", q.gainDb <= 10 && near(q.after - q.before, 10, 0.3));
}

// ── when to make a streaming copy ──────────────────────────────────────────
ok("a song 6 dB off gets a copy", needsStreamCopy({ gainDb: 6, kbps: 256, ext: "mp3" }));
ok("an MP3 already at the level is left as it is", !needsStreamCopy({ gainDb: 0.4, kbps: 256, ext: "mp3" }));
ok("a WAV always gets one (too heavy to stream)", needsStreamCopy({ gainDb: 0, kbps: 1411, ext: "wav" }));
ok("so does a FLAC, which not every phone plays", needsStreamCopy({ gainDb: 0, kbps: 900, ext: "flac" }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
