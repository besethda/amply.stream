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

// ── uploading a song's files ────────────────────────────────────────────────
//
// A long WAV is too big for a service on KV (25 MB a file), but its streaming
// copy isn't. What listeners play must arrive; the original is a bonus.
{
  const { sendParts } = await import("./src/ui.jsx");
  const blob = (size) => ({ size });
  const parts = [["audio/a.stream.mp3", blob(8)], ["audio/a.wav", blob(60)], ["audio/a.waves", blob(1)]];
  const tooBig = async (k) => { if (k === "audio/a.wav") throw new Error("files here can be at most 25 MB"); };
  const got = await sendParts(parts, "audio/a.stream.mp3", tooBig);
  cmp("an original too big for storage is left out, and the song still goes up",
    [...got].sort().join(","), "audio/a.stream.mp3,audio/a.waves");
  let threw = null;
  await sendParts(parts, "audio/a.wav", tooBig).catch((e) => { threw = e.message; });
  cmp("  but with no streaming copy, the original is the song, and its failure stops the upload",
    threw, "files here can be at most 25 MB");
  const seen = [];
  await sendParts(parts, "audio/a.stream.mp3", async (k, b, progress) => progress(1), (f) => seen.push(Math.round(f * 100)));
  // 8 + 60 + 1 bytes: each part's end, as a share of the whole.
  cmp("one progress figure for all the parts, ending at the whole", seen.join(","), "12,99,100");

  // The release was deleted while this song uploaded: stop between parts,
  // and hand back what arrived, so it can be taken out of storage again.
  const { Stopped } = await import("./src/ui.jsx");
  const sentKeys = [];
  let stop = false;
  let caught = null;
  await sendParts(parts, "audio/a.stream.mp3", async (k) => { sentKeys.push(k); stop = true; }, () => {}, () => stop)
    .catch((e) => { caught = e; });
  cmp("deleted mid-upload: nothing more is sent", sentKeys.join(","), "audio/a.stream.mp3");
  cmp("  and what arrived is handed back, to remove", caught instanceof Stopped && [...caught.arrived].join(","), "audio/a.stream.mp3");
}

// ── a streaming copy that fits the storage ──────────────────────────────────
{
  const { fitKbps } = await import("./src/stream-copy.js");
  const KV = 25 * 1024 * 1024;
  cmp("a 5-minute song fits KV at full quality", fitKbps(5 * 60, KV), 256);
  cmp("a 16-minute one drops a step so it still fits", fitKbps(16 * 60, KV), 192);
  cmp("  never below 96 kbps: 40 minutes is too long for 25 MB", fitKbps(40 * 60, KV), null);
  cmp("with no limit known, full quality", fitKbps(16 * 60, null), 256);
}

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

  // Home's "isn't paying" and the listener table ask the same question
  // (standing), so paying every few songs is never mistaken for not paying.
  const { standing } = await import("./src/ui.jsx");
  const RATE = 0.0025, POINT = 0.10;   // 0.25c a minute, paid every 10c
  const paid = { at: NOW, byWallet: { A: { micros: c(10) } } };
  const of = (r) => standing({ pubkey: "A", last_seen: NOW, ...r }, paid, RATE, POINT, NOW);
  cmp("paid 10c, listened 60 minutes (15c): a batch not yet sent, not short", (({ short, overdue: o }) => short || o)(of({ seconds: 3600 })), false);
  cmp("paid 10c, listened 4 hours (60c): short", of({ seconds: 4 * 3600 }).short, true);
  cmp("a subscriber is never short", (({ short, overdue: o }) => short || o)(of({ seconds: 4 * 3600, subscribed_until: NOW + DAY })), false);
  cmp("nothing is flagged before payments are read",
    (({ short, overdue: o }) => short || o)(standing({ pubkey: "B", seconds: 99999, last_seen: 0 }, {}, RATE, POINT, NOW)), false);
}

// ── a page from before signup: the account first, then the claim ────────────
//
// Cloudflare's sign-up forgets the claim it came from, so the notice sends
// the artist to make an account before they tap Keep it.
{
  const html = renderToString(h(Editor, { api, node: { slug: "coolartist", url: NODE }, initial: full, published: true,
    initialTab: "home", onSignOut() {},
    temporary: { until: new Date(Date.now() + 40 * 60_000).toISOString(), claimed: false, claim: "https://dash.cloudflare.com/claim-preview?claimToken=x" } }));
  const check = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? "ok  " : "FAIL"}  ${name}`); };
  const signUp = html.indexOf("https://dash.cloudflare.com/sign-up");
  const andThen = html.indexOf("and then");
  const keep = html.indexOf("Keep it");
  check("the notice offers a Cloudflare account first", signUp > 0 && html.includes("Create a Cloudflare account"));
  check("  and then the claim, in that order", signUp < andThen && andThen < keep);
}

// ── Home only warns when someone's really short ─────────────────────────────
{
  const html = renderToString(h(Editor, { api, node: { slug: "coolartist", url: NODE },
    initial: full, published: true, initialTab: "home", onSignOut() {} }));
  const check = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? "ok  " : "FAIL"}  ${name}`); };
  check("no payments read yet: no paying warning on Home", !/isn't paying|aren't paying/.test(html));
  check("  and no paid-versus-listened percentage", !/of what their listening cost has been paid/.test(html));
}

// ── where money lives ───────────────────────────────────────────────────────
{
  const show = (manifest, tab) => renderToString(h(Editor, { api, node: { slug: "coolartist", url: NODE },
    initial: manifest, published: true, initialTab: tab, onSignOut() {} }));
  const check = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? "ok  " : "FAIL"}  ${name}`); };
  const fresh = show(empty, "earnings");
  check("not set up: Earnings shows getting paid into your own wallet, or card subscriptions", fresh.includes(">Get paid<")
    && fresh.includes("your own wallet") && fresh.includes("Card subscriptions"));
  check("  and no exchange is needed to be paid", !/Paste my Coinbase address|Connect Coinbase/.test(fresh));
  check("  and no price yet", !fresh.includes("Your price") && !fresh.includes("Pays you every"));
  const paid = show(full, "earnings");
  check("set up: Earnings shows the price per minute and per song", paid.includes("¢/min") && paid.includes("per song)"));
  check("  and how often, in songs", paid.includes("Pays you every"));
  check("  not the setup choices", !paid.includes(">Get paid<"));
  check("  and cashing out to Coinbase or Cash App", paid.includes(">Cash out<") && paid.includes("Coinbase") && paid.includes("Cash App"));
  const profile = show(full, "settings");
  check("Profile holds the profile, without prices", profile.includes(">Profile<") && !profile.includes("¢/min"));
  check("  the email is for GDPR compliance", profile.includes("Email for GDPR compliance"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
