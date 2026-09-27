/**
 * Render every tab, in every state that changes what it draws.
 *
 * This exists because a reference to an undefined variable shipped to an
 * artist's own node and blanked the whole editor. esbuild does not resolve free
 * identifiers, `tsc` never sees this file, and the change-count tests only
 * exercised one pure function, so nothing in the build looked at the markup
 * until a browser did. Rendering the tree is the cheapest thing that would have
 * caught it, and it catches the next one too.
 *
 * Run via `npm --prefix manage run test`.
 */
import { renderToString } from "preact-render-to-string";
import { h } from "preact";
import { Editor } from "./src/ui.jsx";

const NODE = "https://coolartist.example.workers.dev";

const api = {
  whoami: async () => ({ email: "you@example.com", version: "test" }),
  readManifest: async () => null,
  writeManifest: async () => {},
  putObject: async () => {},
  deleteObject: async () => {},
  listeners: async () => [],
  setBlocked: async () => {},
};

const full = {
  amply: 1,
  updated: "2026-09-19T12:00:00Z",
  artist: {
    name: "Hollow Coast",
    bio: "By the sea.",
    image: `${NODE}/art/a.jpg`,
    banner: `${NODE}/art/b.jpg`,
    links: [{ label: "Bandcamp", url: "https://x.test" }],
  },
  content: { explicit: true },
  licence: { type: "amply-personal-1" },
  payment: [{
    type: "solana-usdc", ratePerMinute: 0.005, settleAt: 0.1,
    recipients: [
      { name: "Hollow Coast", address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", split: 60 },
      { name: "Ada Vance", address: "9mPQ4cLXmhVYPb2M9fVd8rTgFq7WuXsKbNa1ZyEeRtUv", split: 40 },
    ],
  }],
  releases: [{
    id: "r1", title: "Longwave", date: "2026-03-01", art: `${NODE}/art/c.jpg`,
    tracks: [
      { id: "t1", title: "One", duration: 252, url: `${NODE}/audio/1.mp3` },
      { id: "t2", title: "Two", duration: 180, url: `${NODE}/audio/2.mp3` },
    ],
  }],
};

// A node straight out of setup: no manifest, no music, no payment.
const empty = {
  amply: 1,
  updated: "2026-09-19T12:00:00Z",
  artist: { name: "coolartist" },
  content: { explicit: false },
  payment: [],
  releases: [],
};

// A custom licence, which draws an extra field, and a single payee.
const custom = {
  ...full,
  licence: { type: "custom", url: "https://terms.test" },
  payment: [{ type: "solana-usdc", address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", ratePerMinute: 0 }],
};

const cases = [];
for (const [shape, manifest] of [["full", full], ["empty", empty], ["custom licence", custom]]) {
  for (const tab of ["music", "settings", "earnings"]) {
    for (const published of [true, false]) {
      cases.push([`${tab} — ${shape} — ${published ? "published" : "never published"}`, manifest, tab, published]);
    }
  }
}

let pass = 0, fail = 0;
for (const [name, manifest, tab, published] of cases) {
  try {
    const html = renderToString(
      h(Editor, { api, node: { slug: "coolartist", url: NODE }, initial: manifest,
                  published, initialTab: tab, onSignOut() {} }),
    );
    if (!html || html.length < 500) throw new Error(`rendered only ${html.length} chars`);
    if (!html.includes("Publish changes")) throw new Error("no header rendered");

    // A prop that never arrives stringifies into the markup rather than
    // failing. ImagePick took `class` while every call site passed `cls`, so
    // all three picture buttons rendered class="undefined" and none of their
    // styling applied: uploaded images came out at full size and the empty
    // states collapsed on top of each other. Nothing threw.
    if (/\b(undefined|NaN|\[object Object\])\b/.test(html)) {
      const near = html.match(/.{0,60}(undefined|NaN|\[object Object\]).{0,40}/)[0];
      throw new Error(`rendered a broken value: …${near}…`);
    }

    // The picture buttons must carry the classes that size and clip them.
    for (const cls of tab === "settings" ? ["banner-art", "avatar"]
                    : tab === "music" && manifest.releases.length ? ["release-art"] : []) {
      if (!html.includes(`class="${cls}`)) throw new Error(`no .${cls} in the markup`);
    }
    pass++;
    console.log(`ok    ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}\n        ${e.message}`);
  }
}

// ── knowing when this software is out of date ───────────────────────────────
//
// Nobody at Amply can update an artist's streaming service, so noticing is the
// only mechanism there is. Getting the comparison wrong either nags an artist
// who is up to date or, worse, stays quiet about a security fix.

const { isNewer } = await import("./src/ui.jsx");

const cmp = (name, got, want) => {
  const good = got === want;
  good ? pass++ : fail++;
  console.log(`${good ? "ok  " : "FAIL"}  ${name}${good ? "" : ` — expected ${want}, got ${got}`}`);
};

cmp("a later version is newer", isNewer("3.2.0", "3.1.0"), true);
cmp("a later patch is newer", isNewer("3.1.1", "3.1.0"), true);
cmp("the same version is not", isNewer("3.2.0", "3.2.0"), false);
cmp("an older one is not", isNewer("3.1.0", "3.2.0"), false);
cmp("3.10 comes after 3.9, as numbers not as text", isNewer("3.10.0", "3.9.0"), true);
cmp("and 3.9 does not come after 3.10", isNewer("3.9.0", "3.10.0"), false);
cmp("a major version counts", isNewer("4.0.0", "3.9.9"), true);
cmp("a missing part counts as zero", isNewer("3.2", "3.2.0"), false);
cmp("nothing to compare against says nothing", isNewer(null, "3.2.0"), false);
cmp("an unknown local version says nothing", isNewer("3.2.0", null), false);

// ── who counts as behind on paying ──────────────────────────────────────────
//
// An artist decides whether to stop serving someone from this. Getting it
// wrong in one direction bans honest listeners; in the other, hides people
// who aren't paying. Figures from the first real test: 0.25c a minute, a
// payment point of 10c.

const { behind } = await import("./src/ui.jsx");
const c = (cents) => cents * 10_000;   // cents to micros

cmp("12 minutes, nothing paid yet, under the payment point: not behind", behind(c(3), 0, 0.10), false);
cmp("  nor with a small payment already made", behind(c(3), c(0.11), 0.10), false);
cmp("just over one payment's worth unpaid: still within slack", behind(c(12), 0, 0.10), false);
cmp("a payment and a half unpaid: behind", behind(c(15.1), 0, 0.10), true);
cmp("hours of listening and nothing paid: behind", behind(c(90), 0, 0.10), true);
cmp("paid up in full: not behind", behind(c(90), c(90), 0.10), false);
cmp("with no payment point published, a dollar is the default", behind(c(120), 0, undefined), false);

// ── who counts as overdue ───────────────────────────────────────────────────
{
  const { overdue, rank } = await import("./src/ui.jsx");
  const NOW = 1_800_000_000_000, DAY = 86_400_000;
  cmp("one song, unpaid, last heard ten days ago: overdue", overdue(c(3), 0, NOW - 10 * DAY, NOW), true);
  cmp("  but not three days ago — the week isn't up", overdue(c(3), 0, NOW - 3 * DAY, NOW), false);
  cmp("  nor at exactly a week — their app pays when next opened, so a day's grace", overdue(c(3), 0, NOW - 7.5 * DAY, NOW), false);
  cmp("paid for, long ago: not overdue", overdue(c(3), c(3), NOW - 30 * DAY, NOW), false);
  cmp("a rounding difference isn't a debt", overdue(c(3), c(2.8), NOW - 30 * DAY, NOW), false);
  cmp("nothing owed at all: not overdue", overdue(0, 0, NOW - 30 * DAY, NOW), false);
  const order = [{ id: "fine" }, { id: "behind", short: true }, { id: "late", overdue: true }].sort(rank).map((x) => x.id);
  cmp("overdue first, then behind, then everyone else", order.join(","), "late,behind,fine");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
