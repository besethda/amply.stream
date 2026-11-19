/**
 * The queue: shuffle, repeat, and editing what's up next.
 *
 * Run via `npm --prefix app run test`.
 */
class FakeAudio {
  constructor() { this.paused = true; this.currentTime = 0; this.duration = 200; this.handlers = {}; this.src = ""; }
  addEventListener(e, f) { (this.handlers[e] ||= []).push(f); }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  removeAttribute() {}
}
globalThis.Audio = FakeAudio;

const { createPlayer, shuffled, REPEAT } = await import("./src/player.js");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};
const tick = () => new Promise((r) => setTimeout(r, 0));

const tracks = ["a", "b", "c", "d", "e"].map((id) => ({ id, title: id.toUpperCase(), url: `https://x/${id}.mp3` }));
let state = {};
const seq = (() => { let n = 0; return () => ((n = (n * 9301 + 49297) % 233280) / 233280); })();
const player = createPlayer((s) => { state = s; }, () => {}, { random: seq });

player.play(tracks, 1, "Test album");
await tick();
ok("plays from the chosen song", state.track?.id === "b");
ok("  and says where it's playing from", state.from === "Test album");
ok("up next is what follows", state.upNext.map((t) => t.id).join("") === "cde");

player.toggleShuffle();
ok("shuffling keeps the current song", state.track?.id === "b" && state.shuffle);
ok("  and shuffles only what's left", state.upNext.length === 4 && !state.upNext.some((t) => t.id === "b"));
player.toggleShuffle();
ok("unshuffling goes back to album order after the current song", state.upNext.map((t) => t.id).join("") === "cde");

player.moveNextTo(0, 1);
ok("moving a song down up next", state.upNext.map((t) => t.id).join("") === "dce");
player.removeNext(0);
ok("removing one from up next", state.upNext.map((t) => t.id).join("") === "ce");
player.playNext(tracks[0]);
ok("play next puts it first", state.upNext[0].id === "a");
player.addToQueue(tracks[4]);
ok("add to queue puts it last", state.upNext[state.upNext.length - 1].id === "e");

player.cycleRepeat();
ok("repeat all", state.repeat === REPEAT.ALL);
player.cycleRepeat();
ok("repeat one", state.repeat === REPEAT.ONE);
player.cycleRepeat();
ok("repeat off", state.repeat === REPEAT.OFF);

// At the end of the list: repeat all wraps, off stops.
player.play(tracks.slice(0, 2), 1);
await tick();
ok("no next at the end with repeat off", !state.hasNext);
player.cycleRepeat();
ok("  but there is with repeat all", state.hasNext);
player.next();
await tick();
ok("  and it wraps to the first song", state.track?.id === "a");
player.cycleRepeat(); player.cycleRepeat();

// A refusal names its kind, and retry tries again.
let refuse = true;
const p2 = createPlayer((s) => { state = s; }, () => {}, {
  resolve: async (t) => { if (refuse) { const e = new Error("agree first"); e.kind = "price"; e.data = { url: "u" }; throw e; } return t.url; },
});
p2.play(tracks, 0);
await tick();
ok("a refusal says what kind it is", state.refused?.kind === "price" && state.refused?.url === "u");
refuse = false;
p2.retry();
await tick();
ok("retry plays once the reason is fixed", !state.refused && state.track?.id === "a");

// Losing signal: stuck but still "playing" shows as buffering, then the song
// is fetched again from where it got to. A pause is left alone.
let ms = 0, resolves = 0, online = true, s3 = {};
const p3 = createPlayer((s) => { s3 = s; }, () => {}, {
  clock: () => ms,
  resolve: async (t) => { resolves++; if (!online) throw new Error("offline"); return `${t.url}?t=${resolves}`; },
});
const el = p3.element();
const fire = (e) => (el.handlers[e] || []).forEach((f) => f());
p3.play(tracks, 0);
await tick();
fire("playing");
el.currentTime = 42;
p3.check();
ms = 1000; p3.check();
ok("playing along: not buffering", !s3.waiting && s3.playing);
ms = 3500; p3.check();
ok("clock stuck two seconds: buffering", s3.waiting === true);
online = false;
ms = 7000; p3.check();
await tick();
ok("stuck six seconds: tries fetching it again", resolves === 2);
ms = 8000; p3.check();
await tick();
ok("  and doesn't hammer while there's no signal", resolves === 2);
online = true;
ms = 13500; p3.check();
await tick();
ok("  tries again a little later", resolves === 3 && el.src.endsWith("?t=3"));
el.currentTime = 0;
fire("loadedmetadata");
ok("  and carries on from where it got to", el.currentTime === 42);
fire("playing"); el.currentTime = 43; ms = 14500; p3.check();
ok("  and stops showing buffering once it moves", !s3.waiting);
p3.toggle(); fire("pause");
ms = 60000; p3.check();
ok("paused on purpose: left alone", !s3.waiting && resolves === 3);

// Removing songs: out of the queue; the playing one stops.
{
  let st = {};
  const p = createPlayer((s) => { st = s; }, () => {});
  p.play(tracks, 2);
  await tick();
  p.remove((t) => t.id === "a" || t.id === "d");
  await tick();
  ok("removing songs not playing keeps the current one", p.current()?.id === "c");
  p.next(); await tick();
  ok("  and skips the removed ones", p.current()?.id === "e", p.current()?.id);
  p.prev(); p.prev(); await tick();
  ok("  going back too", p.current()?.id !== "d");
  p.remove((t) => t.id === p.current()?.id);
  await tick();
  ok("removing the playing song stops it", p.current() === null && st.track === null, JSON.stringify({ c: p.current(), t: st.track }));
}

// Dragging a queued song to another place.
{
  let st = {};
  const p = createPlayer((s) => { st = s; }, () => {});
  p.play(tracks, 0);
  await tick();
  const next = () => st.upNext.map((t) => t.id).join("");
  p.moveNextTo(3, 0); await tick();
  ok("a queued song dragged to the top plays next", next() === "ebcd", next());
  p.moveNextTo(0, 2); await tick();
  ok("  and dragged down, lands where it's dropped", next() === "bced", next());
  p.moveNextTo(0, 9); p.moveNextTo(-1, 0); await tick();
  ok("  a place that isn't there changes nothing", next() === "bced", next());
  ok("  and the song playing stays put", p.current()?.id === "a");
}

ok("shuffle is a permutation", shuffled([1, 2, 3, 4, 5], seq).sort().join("") === "12345");

// Listening in a pocket: the phone reports less often, in bigger steps.
// (Past the first 30 s first, so the play counts and steps are counted as they come.)
{
  let wall = 0, heard = 0;
  const p4 = createPlayer(() => {}, (_t, step) => { heard += step; }, { clock: () => wall });
  const a = p4.element();
  const on = (e) => (a.handlers[e] || []).forEach((f) => f());
  p4.play(tracks, 0);
  await tick();
  a.paused = false; on("play");
  const at = (t, ms) => { wall = ms; a.currentTime = t; on("timeupdate"); };
  for (let t = 1; t <= 31; t++) at(t, t * 1000);
  const base = heard;
  at(41, 41_000);
  ok("ten seconds reported at once, ten seconds passed: counted", Math.abs(heard - base - 10) < 0.01, heard - base);
  at(130, 41_500);
  ok("a jump further than the clock moved is a seek: not counted", Math.abs(heard - base - 10) < 0.01, heard - base);
  a.paused = true; on("pause");
  wall = 600_000;
  a.paused = false; on("play");
  at(180, 601_000);
  ok("a long pause, then a jump: not taken for listening", Math.abs(heard - base - 10) < 0.01, heard - base);
  on("seeked"); at(181, 602_000);
  ok("  and listening carries on from there", Math.abs(heard - base - 11) < 0.01, heard - base);
}

// ── when a play counts: 30 s heard, or half a song under a minute ──────────
{
  let wall = 0;
  const counted = [], told = [];
  const pl = createPlayer(() => {}, (t, step) => counted.push([t.id, step]), {
    clock: () => wall, onFinished: (t, seconds) => told.push([t.id, seconds]),
  });
  const a = pl.element();
  const on = (e) => (a.handlers[e] || []).forEach((f) => f());
  const sum = (id) => counted.filter(([x]) => x === id).reduce((n, [, s]) => n + s, 0);
  const at = (t) => { wall += 1000; a.currentTime = t; on("timeupdate"); };
  const start = async (list, i = 0) => { pl.play(list, i); await tick(); a.currentTime = 0; a.paused = false; on("play"); wall += 1; };

  // A skip at 29 s: nothing counted, reported as 0.
  await start(tracks.slice(0, 3));
  for (let t = 1; t <= 29; t++) at(t);
  ok("29 s heard: nothing counted yet", sum("a") === 0, sum("a"));
  pl.next(); await tick();
  ok("  skipped there: free, and reported as 0 s", sum("a") === 0 && told.at(-1)?.[0] === "a" && told.at(-1)?.[1] === 0, JSON.stringify(told));

  // Reaching 30 s: all 30 counted at once, then each second as it comes.
  await start(tracks.slice(0, 3));
  for (let t = 1; t <= 30; t++) at(t);
  ok("at 30 s the play counts: all 30 s at once", Math.abs(sum("a") - 30) < 0.01 && counted.filter(([x]) => x === "a").length === 1, JSON.stringify(counted));
  at(31);
  ok("  then each second as it's heard", Math.abs(sum("a") - 31) < 0.01, sum("a"));
  pl.next(); await tick();
  ok("  and the play is reported as 31 s", told.at(-1)?.[0] === "a" && Math.abs(told.at(-1)[1] - 31) < 0.01, JSON.stringify(told.at(-1)));

  // Dragging the progress bar doesn't make a play count.
  counted.length = 0;
  await start(tracks.slice(0, 3));
  for (let t = 1; t <= 10; t++) at(t);
  pl.seek(150); a.currentTime = 150; on("seeked"); at(151);
  ok("10 s heard, then dragged to 2:30: 11 s heard, nothing counted", sum("a") === 0, sum("a"));
  pl.seek(195); a.currentTime = 195; on("seeked");
  for (let t = 196; t <= 199; t++) at(t);
  ok("  dragged near the end and played out: 15 s heard, still free", sum("a") === 0, JSON.stringify(counted));

  // Heard in pieces: scrubbed back and played again, it all adds up.
  counted.length = 0;
  await start(tracks.slice(1, 3));
  for (let t = 1; t <= 20; t++) at(t);
  pl.seek(0); a.currentTime = 0; on("seeked");
  for (let t = 1; t <= 10; t++) at(t);
  ok("20 s, scrubbed back to the start, 10 s more: 30 s heard, so it counts (all 30)", Math.abs(sum("b") - 30) < 0.01, JSON.stringify(counted));
  a.paused = true; on("pause"); wall += 3_600_000; a.paused = false; on("play");
  at(11);
  ok("  paused an hour and resumed: the same play, counted on", Math.abs(sum("b") - 31) < 0.01, sum("b"));

  // A short song counts at half its length.
  const short = [{ id: "s", title: "S", url: "https://x/s.mp3", duration: 40 }];
  counted.length = 0;
  const saved = a.duration; a.duration = 40;
  await start(short);
  for (let t = 1; t <= 19; t++) at(t);
  ok("a 40 s song: 19 s heard, nothing counted", sum("s") === 0);
  at(20);
  ok("  at 20 s (half of it) it counts, all 20", Math.abs(sum("s") - 20) < 0.01, sum("s"));
  // Its length unknown: 30 s.
  a.duration = NaN;
  const unknown = [{ id: "u", title: "U", url: "https://x/u.mp3" }];
  await start(unknown);
  for (let t = 1; t <= 29; t++) at(t);
  ok("a song of unknown length counts at 30 s, not before", sum("u") === 0);
  at(30);
  ok("  and at 30 s it does", Math.abs(sum("u") - 30) < 0.01, sum("u"));
  a.duration = saved;

  // Repeat one: each loop is its own play.
  counted.length = 0;
  await start(tracks.slice(2, 3));
  pl.cycleRepeat(); pl.cycleRepeat();
  for (let t = 1; t <= 199; t += 1) at(t);
  at(199.7);                                 // played through: it loops from the start
  const first = sum("c");
  ok("  (it looped: back at the start)", a.currentTime === 0, a.currentTime);
  for (let t = 1; t <= 10; t++) at(t);
  ok("repeat one: a second loop skipped at 10 s isn't counted", Math.abs(sum("c") - first) < 0.01 && first > 190, `${first} → ${sum("c")}`);
  pl.cycleRepeat();
}

// ── what's reported: every song fetched, even one skipped at 0 s ────────────
{
  const told = [];
  const q = createPlayer(() => {}, () => {}, { onFinished: (t, seconds, o) => told.push([t.id, seconds, !!o?.partial]) });
  q.play(tracks.slice(0, 3), 0);
  await tick();
  q.next();          // skipped before a second played
  await tick();
  ok("a song fetched and skipped at once is reported, as 0 s", told.length === 1 && told[0][0] === "a" && told[0][1] === 0 && !told[0][2], JSON.stringify(told));
  const a = q.element();
  a.paused = false;
  for (let t = 1; t <= 32; t++) { a.currentTime = t; a.handlers.timeupdate.forEach((f) => f()); }
  q.checkpoint();    // the app closing mid-song
  ok("closing mid-song reports what's been heard, marked partial", told.length === 2 && told[1][0] === "b" && told[1][1] > 0 && told[1][2], JSON.stringify(told));
  q.checkpoint();
  ok("  and not twice", told.length === 2, JSON.stringify(told));
  q.next();
  await tick();
  ok("  if it plays on, the song's end still reports it (0 s more here)", told.length === 3 && told[2][0] === "b" && told[2][1] === 0 && !told[2][2], JSON.stringify(told));

  // A song refused (no pass, no money) was never fetched: nothing to report.
  const said = [];
  const r = createPlayer(() => {}, () => {}, { resolve: async () => { const e = new Error("no"); e.kind = "nowallet"; throw e; }, onFinished: (t, s) => said.push([t.id, s]) });
  r.play(tracks.slice(0, 2), 0);
  await tick();
  r.next();
  await tick();
  ok("a song refused before any audio was fetched isn't reported", said.length === 0, JSON.stringify(said));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
