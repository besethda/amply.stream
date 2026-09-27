/**
 * The listening app's logic, and that every screen renders.
 *
 * Run via `npm --prefix app run test`.
 */
import { renderToString } from "preact-render-to-string";
import { h } from "preact";

// The app reads storage and builds a player as it starts, so both have to exist
// before it is imported. A listener's device has them; Node does not.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
class FakeAudio {
  constructor() { this.paused = true; this.currentTime = 0; this.duration = 0; }
  addEventListener() {} removeEventListener() {} play() { return Promise.resolve(); }
  pause() {} removeAttribute() {}
}
globalThis.Audio = FakeAudio;
// Node's navigator is read-only and has no mediaSession, which is exactly the
// case a desktop browser without lock screen controls presents anyway.
globalThis.addEventListener = () => {};
globalThis.document = { addEventListener() {}, removeEventListener() {} };

const { manifestUrl, tracksOf, rateOf } = await import("./src/manifest.js");
const { App } = await import("./src/app.jsx");

let pass = 0, fail = 0;
const is = (name, got, want) => {
  const okay = Object.is(got, want);
  okay ? pass++ : fail++;
  console.log(`${okay ? "ok  " : "FAIL"}  ${name}${okay ? "" : ` — expected ${want}, got ${got}`}`);
};
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};
const throws = (name, fn, re) => {
  try { fn(); fail++; console.log(`FAIL  ${name} — it was accepted`); }
  catch (e) { const good = re.test(e.message); good ? pass++ : fail++;
    console.log(`${good ? "ok  " : "FAIL"}  ${name}${good ? "" : ` — said: ${e.message}`}`); }
};

// What a listener might paste. Artists share whatever their browser showed
// them, so all of these are the same artist.
const want = "https://hollowcoast.workers.dev/manifest.json";
is("a bare host", manifestUrl("hollowcoast.workers.dev"), want);
is("with https", manifestUrl("https://hollowcoast.workers.dev"), want);
is("a trailing slash", manifestUrl("https://hollowcoast.workers.dev/"), want);
is("the manifest itself", manifestUrl("https://hollowcoast.workers.dev/manifest.json"), want);
is("spaces around it", manifestUrl("  hollowcoast.workers.dev  "), want);
is("a fragment", manifestUrl("https://hollowcoast.workers.dev/#x"), want);
throws("nothing at all", () => manifestUrl("  "), /Paste an artist's link/);
throws("plain http, which could be tampered with", () => manifestUrl("http://x.test"), /https/);
throws("not an address", () => manifestUrl("who is hollow coast"), /web address/);

// Payment, as a client has to read it.
const one = { artist: { name: "A" }, payment: [{ type: "solana-usdc", address: "7xKX", ratePerMinute: 0.01, settleAt: 0.2 }] };
is("a single payee becomes one recipient", rateOf(one).recipients.length, 1);
is("  taking all of it", rateOf(one).recipients[0].split, 100);
is("  named as the artist", rateOf(one).recipients[0].name, "A");
const split = { artist: { name: "A" }, payment: [{ type: "solana-usdc", ratePerMinute: 0.01, recipients: [
  { name: "A", address: "7xKX", split: 60 }, { name: "B", address: "9mPQ", split: 40 }] }] };
is("a split is read as it stands", rateOf(split).recipients.length, 2);
is("no metered payment means nothing to pay", rateOf({ payment: [{ type: "link", label: "Ko-fi", url: "https://x.test" }] }), null);
is("no payment at all", rateOf({}), null);

// Tracks flatten in order, each knowing where it came from.
const entry = { url: want, manifest: { artist: { name: "A" }, releases: [
  { id: "r1", title: "One", tracks: [{ id: "a", title: "A", duration: 10, url: "https://x/1.mp3" }] },
  { id: "r2", title: "Two", tracks: [
    { id: "b", title: "B", duration: 10, url: "https://x/2.mp3" },
    { id: "c", title: "C", duration: 10, url: "https://x/3.mp3" }] },
] } };
is("every track, across releases", tracksOf(entry).length, 3);
is("in order", tracksOf(entry).map((t) => t.id).join(""), "abc");
is("each knows its release", tracksOf(entry)[2].releaseTitle, "Two");
is("and its artist's address, which is what it owes against", tracksOf(entry)[0].from, want);

// Every screen renders. The app opens empty, so that one matters most.
function screen(name, library) {
  store.clear();
  if (library) store.set("amply.library.v1", JSON.stringify(library));
  try {
    const html = renderToString(h(App, {}));
    ok(name, html.length > 200 && !/\b(undefined|NaN|\[object Object\])\b/.test(html),
      /\bundefined\b/.test(html) ? "rendered a broken value" : `only ${html.length} chars`);
    return html;
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name} — threw ${e.message}`);
    return "";
  }
}
const empty = screen("the first run, with nothing in it", null);
ok("  and asks for a first artist rather than looking broken", /Add your first/.test(empty));
// Structure, not prose: the copy legitimately contains the word "browse" while
// saying there is nothing to. What must not exist is a list of artists nobody
// chose, which is the line between a player and a catalogue.
ok("  with no list of artists on it", !/class="shelf"/.test(empty));
ok("  and a way to add one, by link or by their website", /An artist&#39;s link or website|An artist's link or website/.test(empty));
ok("  with no money in sight until it is needed", !/To spend|\$\d/.test(empty));
const home = screen("a library with one artist", [{ url: want, manifest: entry.manifest, added: 1 }]);
ok("  has the three tabs", /Home/.test(home) && /Library/.test(home) && /You/.test(home));
ok("  and no balance in the corner", !/wallet-link/.test(home));
screen("an artist with no payment set", [{ url: want, manifest: { artist: { name: "A" }, releases: [] }, added: 1 }]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
