/**
 * Evening out volume, end to end in a real browser: a deliberately quiet song
 * and a deliberately loud one are uploaded through the editor (the preview
 * build), and the streaming copies it makes are decoded and measured again.
 *
 *   npm run preview && node manage/test-loudness-browser.cjs
 *
 * Not part of `npm run check`: it needs Chromium (installed in CI images and
 * cloud sessions, not necessarily on every laptop).
 */
const { chromium } = require("playwright");
const { writeFileSync, mkdtempSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

/** A 16-bit stereo WAV of music-like noise with some drum hits, at a chosen level. */
function wav(path, dbfs, seconds = 20, rate = 44100) {
  const n = seconds * rate, a = Math.pow(10, dbfs / 20);
  const data = Buffer.alloc(n * 4);
  const samples = new Float32Array(n);
  let seed = 7, lp = 0;
  for (let i = 0; i < n; i++) {
    seed = (seed * 16807) % 2147483647;
    lp = lp * 0.9 + (seed / 2147483647 * 2 - 1) * 0.1;              // darker, more like music than white noise
    let v = lp * 4 * a + 0.3 * a * Math.sin(2 * Math.PI * 220 * i / rate);
    const t = (i % rate) / rate;                                       // a kick each second: a quick, decaying thump
    v += Math.min(0.9, a * 5) * Math.exp(-t * 40) * Math.sin(2 * Math.PI * 60 * t);
    const s = Math.max(-1, Math.min(1, v)) * 32767;
    samples[i] = (s | 0) / 32768;
    data.writeInt16LE(s | 0, i * 4); data.writeInt16LE(s | 0, i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([h, data]));
  return samples;
}

(async () => {
  const dir = mkdtempSync(join(tmpdir(), "amply-loud-"));
  const quiet = join(dir, "quiet-home-mix.wav"), loud = join(dir, "loud-master.wav");
  const { integratedLoudness, gainFor, TARGET_LUFS } = await import("../spec/loudness.mjs");
  const qs = wav(quiet, -22), ls = wav(loud, -9);
  // What each song measures before, and so where its copy should land: on the
  // target, or exactly as far as the 10 dB boost cap allows.
  const before = { "quiet-home-mix": integratedLoudness([qs, qs], 44100), "loud-master": integratedLoudness([ls, ls], 44100) };
  global.__expect = Object.fromEntries(Object.entries(before).map(([k, b]) => [k, { before: b, want: b + gainFor(b), target: TARGET_LUFS }]));

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("file:///tmp/amply-preview/editor.html");
  await page.waitForTimeout(1200);
  await page.click('button.tab:has-text("Music")');
  await page.waitForTimeout(400);
  await page.locator('input[type=file][multiple][accept*=".wav"]').first().setInputFiles([quiet, loud]);
  // Wait for both songs to be measured, copied and uploaded.
  await page.waitForFunction(() => (window.__uploads || []).filter((u) => u.key.endsWith(".stream.mp3")).length >= 2, null, { timeout: 120_000 });

  const source = readFileSync(join(__dirname, "../spec/loudness.mjs"), "utf8");
  const result = await page.evaluate(async (src) => {
    const { integratedLoudness } = await import("data:text/javascript," + encodeURIComponent(src));
    const out = {};
    for (const u of window.__uploads.filter((x) => x.key.endsWith(".stream.mp3"))) {
      const ctx = new OfflineAudioContext(2, 1, 44100);
      const buf = await ctx.decodeAudioData(await u.body.arrayBuffer());
      const ch = [buf.getChannelData(0), buf.getChannelData(1)];
      let peak = 0; for (const c of ch) for (const v of c) peak = Math.max(peak, Math.abs(v));
      out[u.key] = { lufs: integratedLoudness(ch, 44100), peakDb: 20 * Math.log10(peak), bytes: u.size, seconds: buf.duration };
    }
    return out;
  }, source).catch((e) => ({ error: String(e) }));
  if (result.error) {
    // The page's policy may refuse a data: module; measure in Node instead.
    console.log("note: measuring in the test, not the page:", result.error.slice(0, 80));
  }
  await browser.close();
  return { result, errors };
})().then(({ result, errors }) => {
  ok("no errors in the editor", errors.length === 0, errors.join("; "));
  const entries = Object.entries(result.error ? {} : result);
  ok("both songs got a streaming copy", entries.length === 2, JSON.stringify(result).slice(0, 200));
  for (const [key, r] of entries) {
    const name = key.split("/").pop();
    console.log(`      measured: ${r.lufs.toFixed(2)} LUFS, peak ${r.peakDb.toFixed(2)} dBFS, ${((r.bytes * 8) / r.seconds / 1000).toFixed(0)} kbps`);
    const e = global.__expect[name.replace(/-[a-z0-9]+\.stream\.mp3$/, "")];
    ok(`${name}: ${e.before.toFixed(1)} LUFS in, lands at ${e.want.toFixed(1)} (within 1 dB)`,
      Math.abs(r.lufs - e.want) <= 1, r.lufs.toFixed(2));
    ok(`${name}: never clips (peak under 0 dBFS)`, r.peakDb < 0, r.peakDb.toFixed(2));
    const kbps = (r.bytes * 8) / r.seconds / 1000;
    ok(`${name}: a streamable size (about 256 kbps)`, kbps > 200 && kbps < 300, kbps.toFixed(0));
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
