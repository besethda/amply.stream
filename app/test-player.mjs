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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
