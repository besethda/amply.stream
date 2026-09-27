/**
 * Picking up a new version: only when there is one, and only when it
 * interrupts nothing.
 *
 * Run via `npm --prefix app run test`.
 */
const { createUpdater, IDLE_MS } = await import("./src/update.js");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

class FakeAudio {
  constructor() { this.paused = true; this.src = ""; this.handlers = {}; }
  addEventListener(e, f) { (this.handlers[e] ||= []).push(f); }
  fire(e) { (this.handlers[e] || []).forEach((f) => f()); }
}
const served = (build) => async () => ({ ok: true, json: async () => ({ build }) });

let clock = 0, reloads = 0;
const memory = () => { let v = null; return { get: () => v, set: (x) => { v = x; } }; };
const make = (opts) => createUpdater({ current: "aaa", now: () => clock, reload: () => { reloads++; }, tried: memory(), ...opts });

ok("the same build: nothing to do", await make({ get: served("aaa") }).check() === "current" && reloads === 0);
ok("no signal: nothing to do, try later", await make({ get: async () => { throw new Error("offline"); } }).check() === "unknown");
ok("a build without a stamp: nothing to compare", await createUpdater({ current: undefined, get: served("bbb") }).check() === "unknown");

// Nothing loaded yet: a newer build loads straight away.
let a = new FakeAudio();
ok("newer, nothing playing: reloads", await make({ audio: a, get: served("bbb") }).check() === "reloaded" && reloads === 1);

// Playing: waits.
reloads = 0; clock = 0;
a = new FakeAudio(); a.src = "https://x/song.mp3";
const u = make({ audio: a, get: served("bbb") });
a.paused = false; a.fire("play");
ok("newer while a song plays: waits", await u.check() === "waiting" && reloads === 0);
// Paused a moment ago: still waits.
a.paused = true; a.fire("pause");
clock += 60 * 1000;
ok("  paused a minute ago: still waits", await u.check() === "waiting" && reloads === 0);
// Paused long enough: loads.
clock += IDLE_MS;
ok("  paused over ten minutes: reloads", await u.check() === "reloaded" && reloads === 1);

// Once it knows, it doesn't need the network again to act.
reloads = 0; clock = 0;
let asked = 0;
a = new FakeAudio(); a.src = "https://x/song.mp3"; a.paused = false;
const u2 = make({ audio: a, get: async () => { asked++; return { ok: true, json: async () => ({ build: "bbb" }) }; } });
a.fire("play");
await u2.check();
a.paused = true; a.fire("pause"); clock += IDLE_MS + 1;
ok("remembers there's a newer one; no need to ask twice", await u2.check() === "reloaded" && asked === 1);

// A reload that didn't take (the old app came back): not tried again for that build.
reloads = 0;
const once = memory();
await make({ get: served("ccc"), tried: once }).check();
const again = await make({ get: served("ccc"), tried: once }).check();
ok("a reload that didn't take isn't tried again for the same build", reloads === 1 && again === "current", `${reloads} reloads, then ${again}`);
ok("  but a newer one still is", await make({ get: served("ddd"), tried: once }).check() === "reloaded" && reloads === 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
