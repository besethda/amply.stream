/**
 * The waveform's data: a song's waves file folded into three ribbons that
 * line up with the song's own timeline, fetched once, never the song itself.
 *
 * Run via `npm --prefix app run test`.
 */
const { RIBBONS, ribbonsOf, levelAt, createVisualizer, EASE_S } = await import("./src/visualizer.js");
const { startWaves, feedWaves, finishWaves, readWaves } = await import("../spec/waves.mjs");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

// A waves file for four seconds at 16 kHz: silence, then a tone for each
// ribbon for 0.5 s at 1 s, 2 s and 3 s.
const rate = 16000, secs = 4, pcm = new Float32Array(rate * secs);
const bursts = [[1.0, 100], [2.0, 1200], [3.0, 6000]];
for (const [at, f] of bursts) {
  for (let i = Math.round(at * rate); i < Math.round((at + 0.5) * rate); i++) pcm[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / rate);
}
const a = startWaves(rate, secs);
feedWaves(a, pcm);
const file = finishWaves(a);
const s = ribbonsOf(readWaves(file));

ok("three ribbons, low to high", RIBBONS.length === 3 && RIBBONS.every((r, i) => i === 0 || r.below > RIBBONS[i - 1].below));
bursts.forEach(([at, f], r) => {
  const inside = levelAt(s, r, at + 0.25);
  const others = [0, 1, 2].filter((x) => x !== r).map((x) => levelAt(s, x, at + 0.25));
  ok(`${RIBBONS[r].name}: loud during its own ${f} Hz tone`, inside > 0.8, inside.toFixed(2));
  ok(`  and the others much quieter then`, others.every((v) => v < inside * 0.5), others.map((v) => v.toFixed(2)).join(" "));
  // On time, to within a frame of the file (1/30 s).
  const before = levelAt(s, r, at - 0.06), after = levelAt(s, r, at + 0.06);
  ok(`  quiet just before it starts, up just after`, before < 0.1 && after > 0.5, `${before.toFixed(2)} → ${after.toFixed(2)}`);
  const gone = levelAt(s, r, at + 0.5 + 0.45);
  ok(`  and falls away after it ends`, gone < 0.15, gone.toFixed(2));
});
ok("nothing before the song or after it", levelAt(s, 0, -1) === 0 && levelAt(s, 0, 99) === 0);

// The visualizer: fetches the waves file (never the song), once, and follows the clock.
const asked = [];
const get = async (url) => {
  asked.push(url);
  if (url.includes("missing")) return { ok: false, status: 404 };
  return { ok: true, arrayBuffer: async () => file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) };
};
const viz = createVisualizer({ get });
const audio = { currentTime: 1.25 };
viz.start(audio);
ok("nothing to show before a song", viz.levels() === null);
viz.show({ url: "https://x/song.mp3", waves: "https://x/song.waves" });
ok("  or while its waves are on their way", viz.levels() === null);
await new Promise((r) => setTimeout(r, 0));
const lv = viz.levels();
ok("the song's levels once they arrive", lv && lv[0] > 0.8 && lv[2] < 0.3, JSON.stringify(lv));
ok("  read from its waves file, not the song", asked.length === 1 && asked[0].endsWith(".waves"), asked.join(" "));
audio.currentTime = 3.25;
ok("  and following the song's clock", viz.levels()[2] > 0.8 && viz.levels()[0] < 0.3);
viz.show({ url: "https://x/song.mp3", waves: "https://x/song.waves" });
viz.prefetch({ waves: "https://x/song.waves" });
ok("  fetched once, however often it's shown", asked.length === 1);
viz.show({ url: "https://x/old.mp3" });
ok("a song without a waves file: nothing, so the idle motion", viz.levels() === null && asked.length === 1);
viz.show({ waves: "https://x/missing.waves" });
await new Promise((r) => setTimeout(r, 0));
ok("a waves file that can't be fetched: the same", viz.levels() === null);

ok("reads a touch ahead, so easing lands on time", EASE_S > 0 && EASE_S < 0.1);

// Every band on its own, for the boxes: a tone lands in its own band, and a
// moment ago can be read as well as now.
const { bandsOf } = await import("./src/visualizer.js");
const W = readWaves(file), B = bandsOf(W);
ok("all the file's bands, low to high", B.env.length === W.bands.length && W.bands.every((b, i) => i === 0 || b[0] >= W.bands[i - 1][0]));
// Each band is scaled to itself (so treble moves as visibly as bass), so what
// matters is that the band holding a tone lights up fully while it plays.
bursts.forEach(([at, f]) => {
  const b = W.bands.findIndex(([from, to]) => f >= from && f < to);
  const during = levelAt(B, b, at + 0.25), before = levelAt(B, b, at - 0.1);
  ok(`${f} Hz lights its band (${W.bands[b].join("–")} Hz) while it plays, not before`, during > 0.8 && before < 0.2, `${before.toFixed(2)} → ${during.toFixed(2)}`);
});
viz.show({ url: "https://x/song.mp3", waves: "https://x/song.waves" });
audio.currentTime = 1.2;
const nowBands = viz.bands(0), earlier = viz.bands(0.4);
ok("the boxes can read now and a moment ago", nowBands[1] > 0.5 && earlier[1] < 0.2, `${nowBands[1].toFixed(2)} now, ${earlier[1].toFixed(2)} 0.4 s ago`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
