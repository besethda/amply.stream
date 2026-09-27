/**
 * The number in the header has to mean something.
 *
 * It said "4 changes" after typing four letters into one field, because it was
 * counting edits rather than differences. These cases pin down what it counts
 * now: fields, not keystrokes, and one change per item added to a list rather
 * than one per field inside it.
 *
 * Bundled with esbuild first, so the tests and the code share one Preact.
 * Run via `npm --prefix manage run test`.
 */
import { countChanges } from "./src/ui.jsx";

const base = () => ({
  amply: 1,
  updated: "2026-09-19T12:00:00Z",
  artist: { name: "Hollow Coast", bio: "By the sea.", links: [{ label: "Bandcamp", url: "https://x.test" }] },
  content: { explicit: false },
  payment: [{ type: "solana-usdc", address: "7xKX", ratePerMinute: 0.01, settleAt: 20 }],
  releases: [{
    id: "r1", title: "Longwave", tracks: [
      { id: "t1", title: "One", duration: 200, url: "https://x.test/audio/1.mp3" },
      { id: "t2", title: "Two", duration: 180, url: "https://x.test/audio/2.mp3" },
    ],
  }],
});

const cases = [];
const t = (name, mutate, expected) => cases.push([name, mutate, expected]);

t("nothing touched", () => {}, 0);
t("only the timestamp moved", (m) => { m.updated = "2026-09-20T09:00:00Z"; }, 0);
t("rename the artist, however many letters", (m) => { m.artist.name = "Hollow Coast Ensemble"; }, 1);
t("rename back again", (m) => { m.artist.name = "Hollow Coast"; }, 0);
t("change two separate fields", (m) => { m.artist.name = "X"; m.artist.bio = "Y"; }, 2);
t("set a cover image", (m) => { m.artist.banner = "https://x.test/art/b.jpg"; }, 1);
t("change the price", (m) => { m.payment[0].ratePerMinute = 0.005; }, 1);
t("change price and payout", (m) => { m.payment[0].ratePerMinute = 0.005; m.payment[0].settleAt = 10; }, 2);
t("add one release", (m) => { m.releases.push({ id: "r2", title: "New", tracks: [] }); }, 1);
t("add a release with three tracks", (m) => {
  m.releases.push({ id: "r2", title: "New", tracks: [{ id: "a" }, { id: "b" }, { id: "c" }] });
}, 1);
t("add three tracks to an existing release", (m) => {
  m.releases[0].tracks.push({ id: "t3" }, { id: "t4" }, { id: "t5" });
}, 3);
t("remove a track", (m) => { m.releases[0].tracks.pop(); }, 1);
t("rename one track", (m) => { m.releases[0].tracks[1].title = "Deux"; }, 1);
t("replace a track's audio", (m) => {
  m.releases[0].tracks[0].url = "https://x.test/audio/1b.mp3";
  m.releases[0].tracks[0].duration = 205;
}, 2);
t("switch one payee to a two-way split", (m) => {
  delete m.payment[0].address;
  m.payment[0].recipients = [{ address: "7xKX", split: 60 }, { address: "9mPQ", split: 40 }];
}, 2);
t("add a link", (m) => { m.artist.links.push({ label: "IG", url: "https://y.test" }); }, 1);
t("toggle explicit", (m) => { m.content.explicit = true; }, 1);

let pass = 0, fail = 0;
for (const [name, mutate, expected] of cases) {
  const live = base();
  const now = base();
  mutate(now);
  const got = countChanges(live, now);
  const ok = got === expected;
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name} — expected ${expected}, got ${got}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
