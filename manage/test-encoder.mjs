/**
 * The MP3 encoder: fetched when a song is uploaded, run only if it's the file
 * this editor was built with.
 *
 * Run via `npm --prefix manage run test`.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const { LAMEJS, fetchEncoder } = await import("./src/stream-copy.js");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { cond ? pass++ : fail++; console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`); };

const real = readFileSync(new URL("./node_modules/@breezystack/lamejs/dist/lamejs.js", import.meta.url));
const installed = JSON.parse(readFileSync(new URL("./node_modules/@breezystack/lamejs/package.json", import.meta.url), "utf8")).version;
ok("the pinned hash is the installed library's file", createHash("sha256").update(real).digest("hex") === LAMEJS.sha256);
ok("  and its version, in every address it's fetched from", LAMEJS.version === installed && LAMEJS.sources.every((u) => u.includes(`@${installed}/dist/lamejs.js`)), installed);

const serve = (map) => async (url) => (map[url] ? { ok: true, arrayBuffer: async () => map[url] } : { ok: false });
const [a, b] = LAMEJS.sources;
const tampered = new Uint8Array(real); tampered[100] ^= 1;
let got = await fetchEncoder({ get: serve({ [a]: real.buffer.slice(real.byteOffset, real.byteOffset + real.byteLength) }) });
ok("the right file from the first CDN is taken", got.byteLength === real.byteLength);
got = await fetchEncoder({ get: serve({ [a]: tampered.buffer, [b]: real.buffer.slice(real.byteOffset, real.byteOffset + real.byteLength) }) });
ok("a changed file from the first is refused, and the second's taken", got.byteLength === real.byteLength && new Uint8Array(got)[100] === real[100]);
const none = await fetchEncoder({ get: serve({ [a]: tampered.buffer, [b]: tampered.buffer }) }).then(() => "ran", (e) => e.message);
ok("  changed on both: nothing is run, it says so", none !== "ran", none);
const down = await fetchEncoder({ get: async () => { throw new Error("offline"); } }).then(() => "ran", (e) => e.message);
ok("  neither reachable: the same", down !== "ran");

const lame = await import("data:text/javascript," + encodeURIComponent(real.toString("utf8")));
const enc = new lame.Mp3Encoder(2, 44100, 128);
const tone = new Int16Array(1152 * 4).map((_, i) => Math.round(Math.sin(i / 10) * 8000));
ok("and the checked file encodes", enc.encodeBuffer(tone, tone).length + enc.flush().length > 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
