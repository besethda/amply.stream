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

  // What listening cost is what the server priced it at when it was heard.
  cmp("4 hours priced at 10c when heard: not short, whatever today's price",
    of({ seconds: 4 * 3600, owed_seconds: 4 * 3600, owed_micros: c(10) }).short, false);
  cmp("  so raising the price doesn't put past listeners in red",
    (({ short }) => short)(standing({ pubkey: "A", last_seen: NOW, seconds: 4 * 3600, owed_seconds: 4 * 3600, owed_micros: c(10) }, paid, RATE * 10, POINT, NOW)), false);
  cmp("listening free when heard (paused, subscribed) owes nothing later",
    of({ seconds: 10 * 3600, owed_seconds: 10 * 3600, owed_micros: 0 }).short, false);
  cmp("listening from before the server priced it is still estimated",
    of({ seconds: 8 * 3600, owed_seconds: 3600, owed_micros: c(1) }).short, true);
  cmp("under a cent is never sent alone, so never overdue", overdue(c(0.9), 0, NOW - 30 * DAY, NOW), false);

  const { withPayers } = await import("./src/ui.jsx");
  const listed = withPayers([{ pubkey: "A", seconds: 60 }], { byWallet: { A: { micros: c(1) }, Z: { micros: c(1) }, unknown: { micros: 5 } } });
  cmp("someone who paid before a play was counted is listed", listed.map((r) => r.pubkey).join(","), "A,Z");
  cmp("  as having paid, with no plays yet", listed[1].paidOnly && listed[1].seconds === 0, true);
  cmp("  and isn't counted as short for it", standing(listed[1], { at: NOW, byWallet: { Z: { micros: c(1) } } }, RATE, POINT, NOW).short, false);
}

// ── reading payments off the chain ──────────────────────────────────────────
{
  const { paymentsTo, mergePayments } = await import("./src/chain.js");
  const ARTIST = "Art1st1111111111111111111111111111111111111", BAND = "Band11111111111111111111111111111111111111";
  const FAN = "Fan111111111111111111111111111111111111111", OUT = "Out111111111111111111111111111111111111111";
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const acct = { [ARTIST]: "accA", [BAND]: "accB", [FAN]: "accF", [OUT]: "accO" };
  const tx = (sig, transfers, memo) => ({
    blockTime: 1_000, meta: { err: null, preTokenBalances: [], innerInstructions: [],
      postTokenBalances: Object.entries(acct).map(([owner, a], i) => ({ accountIndex: i, owner, mint: USDC })) },
    transaction: { message: { accountKeys: Object.values(acct).map((pubkey) => ({ pubkey })), instructions: [
      ...transfers.map(([to, micros]) => ({ parsed: { type: "transferChecked", info: { authority: FAN, destination: acct[to], mint: USDC, tokenAmount: { amount: String(micros) } } } })),
      ...(memo ? [{ program: "spl-memo", parsed: memo }] : []),
    ] } },
  });
  // 2,500 payments (three pages of 1,000), then a tip, a purchase and a send-out fee.
  const sigs = [...Array(2500)].map((_, i) => `s${i}`).concat(["tip", "buy", "out"]);
  const txs = Object.fromEntries(sigs.map((sig) => [sig,
    sig === "tip" ? tx(sig, [[ARTIST, 1_000_000]], "amply:tip:a.test")
      : sig === "buy" ? tx(sig, [[ARTIST, 5_000_000]], "amply:buy:a.test:album")
      : sig === "out" ? tx(sig, [[OUT, 2_000_000], [ARTIST, 50_000]])
      : tx(sig, [[ARTIST, 7_000], [BAND, 3_000]])]));
  let pages = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const answer = (b) => {
      if (b.method === "getSignaturesForAddress") {
        pages++;
        const { before, until, limit } = b.params[1];
        let list = [...sigs].reverse();                       // newest first
        if (until) list = list.slice(0, list.indexOf(until));
        if (before) list = list.slice(list.indexOf(before) + 1);
        return { jsonrpc: "2.0", id: b.id, result: list.slice(0, limit).map((signature) => ({ signature, err: null })) };
      }
      return { jsonrpc: "2.0", id: b.id, result: txs[b.params[0]] };
    };
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)));
  };
  globalThis.setTimeout = ((real) => (fn, ms) => real(fn, 0))(globalThis.setTimeout);
  const all = await paymentsTo(ARTIST, "mainnet", { payees: [ARTIST, BAND] });
  cmp("every payment is read, not just the latest few hundred", all.byWallet[FAN].payments, 2500);
  cmp("  across pages", pages, 3);
  cmp("  listening paid is listening only", all.byWallet[FAN].micros, 2500 * 7_000);
  cmp("  a tip, a purchase and a send-out fee are counted apart", all.byWallet[FAN].other, 1_000_000 + 5_000_000 + 50_000);
  cmp("  and everything that arrived is in the total", all.total, 2500 * 7_000 + 6_050_000);
  sigs.push("new1");
  txs.new1 = tx("new1", [[ARTIST, 7_000], [BAND, 3_000]]);
  pages = 0;
  const more = await paymentsTo(ARTIST, "mainnet", { until: all.newest, payees: [ARTIST, BAND] });
  cmp("next time, only what's newer is read", more.byWallet[FAN].payments === 1 && pages === 1, true);
  cmp("  and added to what was kept", mergePayments(all, more).byWallet[FAN].payments, 2501);
  cmp("  with nothing more to read", !!all.more || !!more.more, false);

  // Thousands of junk transfers: one look reads at most so many, oldest
  // first, and says there's more; the next carries on from there.
  pages = 0;
  const first = await paymentsTo(ARTIST, "mainnet", { payees: [ARTIST, BAND], most: 1000 });
  cmp("one look reads at most so many transactions", first.checked, 1000);
  cmp("  says there's more to read", first.more, true);
  cmp("  the oldest first, so nothing is skipped", first.byWallet[FAN].payments === 1000 && first.newest === "s999", true);
  let sum = first, rounds = 1, next = first;
  while (next.more && rounds < 10) {
    next = await paymentsTo(ARTIST, "mainnet", { until: sum.newest, payees: [ARTIST, BAND], most: 1000 });
    sum = { ...mergePayments(sum, next), newest: next.newest };
    rounds++;
  }
  cmp("  and the next looks carry on until all is read", JSON.stringify([sum.byWallet[FAN].payments, sum.total - all.total, rounds, next.more]), JSON.stringify([2501, 7_000, 3, false]));
  globalThis.fetch = realFetch;
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
  check("not set up: Earnings invites setting up, with how long it takes, and card subscriptions under More", fresh.includes(">Start earning<")
    && fresh.includes("About 5 minutes") && fresh.includes("card subscriptions"));
  check("  and no exchange is needed to be paid", !/Paste my Coinbase address|Connect Coinbase/.test(fresh));
  check("  and no price yet", !fresh.includes("Your price") && !fresh.includes("Pays you every"));
  const paid = show(full, "earnings");
  check("set up: Earnings shows the price per minute and per song", paid.includes("¢/min") && paid.includes("per song)"));
  check("  and how often, in songs", paid.includes("Pays you every"));
  check("  not the setup choices", !paid.includes(">Get paid<"));
  // Cashing out needs the fees account on, and opens only when asked for.
  check("  no cash out before the fees account is known to be on", !paid.includes(">Cash out<") && !paid.includes("Cash App"));
  const profile = show(full, "settings");
  check("Profile holds the profile, without prices", profile.includes(">Profile<") && !profile.includes("¢/min"));
  check("  the email is for GDPR compliance", profile.includes("Email for GDPR compliance"));
}

// ── previewing a song doesn't redraw the editor as it plays ─────────────────
{
  const { memo, usePlayer } = await import("./src/ui.jsx");
  const check = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? "ok  " : "FAIL"}  ${name}`); };
  let player;
  renderToString(h(() => { player = usePlayer(); return null; }));
  check("the player the editor holds is which track and whether it plays, not where it is",
    "current" in player && "playing" in player && typeof player.toggle === "function" && typeof player.stop === "function"
    && !("at" in player) && !("of" in player));
  const Row = memo(() => null);
  const row = new Row({ a: 1, f: Math.max });
  row.props = { a: 1, f: Math.max };
  check("  and releases and tracks redraw only when their own props change",
    !row.shouldComponentUpdate({ a: 1, f: Math.max }) && row.shouldComponentUpdate({ a: 2, f: Math.max })
    && row.shouldComponentUpdate({ a: 1, f: Math.min }) && row.shouldComponentUpdate({ a: 1 }));
}

// ── one look at the fees account, shared, not a poll per card ───────────────
{
  const { feesPollMs } = await import("./src/ui.jsx");
  const check = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? "ok  " : "FAIL"}  ${name}`); };
  check("the fees account on: no polling", feesPollMs({ offering: true }, false) === null && feesPollMs({ offering: true }, true) === null);
  check("  off: one look a minute", feesPollMs({ offering: false }, false) === 60_000);
  check("  off, with the setup's fees step open: every 15 seconds", feesPollMs({ offering: false }, true) === 15_000 && feesPollMs(null, true) === 15_000);
  check("  not known yet (couldn't ask): no polling outside setup", feesPollMs(null, false) === null);
  let asked = 0;
  const counting = { ...api, fees: async () => { asked++; return { offering: false, address: "x", network: "solana", lamports: 0 }; } };
  for (const tab of ["home", "earnings", "music"]) {
    renderToString(h(Editor, { api: counting, node: { slug: "coolartist", url: NODE }, initial: full, published: true, initialTab: tab, onSignOut() {} }));
  }
  check("  and drawing the editor asks nothing by itself", asked === 0);
}

// ── Your price: what a payment comes to, at every choice of songs ──
{
  const { Pricing, settleFor, BATCHES } = await import("./src/ui.jsx");
  const check = (name, cond, detail = "") => { cond ? pass++ : fail++; console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`); };
  const said = {};
  for (const songs of BATCHES) {
    const html = renderToString(h(Pricing, { wallet: { type: "solana-usdc", ratePerMinute: 0.01, settleAt: settleFor(songs, 0.01) }, onChange() {} }));
    said[songs] = /Each payment is about ([^<·]+)/.exec(html.replace(/<!--.*?-->/g, ""))?.[1]?.trim();
  }
  check("every choice of songs says what a payment comes to", BATCHES.every((b) => !!said[b]), JSON.stringify(said));
  check("  and it grows with the songs", said[1] !== said[5] && said[5] !== said[10], JSON.stringify(said));
  const free = renderToString(h(Pricing, { wallet: { type: "solana-usdc", ratePerMinute: 0, settleAt: 1 }, onChange() {} }));
  check("  a free price has none", !/Each payment is about/.test(free));
}

// ── Auto-block: the switch, why it waits, and what turning it on would do ──
{
  const { AutoBlockSwitch, AutoBlockHelp, AutoBlockChip, autoBlockWaits, wouldAutoBlock, paidChunks } = await import("./src/ui.jsx");
  const check = (name, cond, detail = "") => { cond ? pass++ : fail++; console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`); };
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const W = (n) => `${"7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosg".slice(0, 40)}${[0, 1, 2, 3].map((k) => B58[Math.floor(n / 58 ** k) % 58]).join("")}`;
  const ready = { addresses: ["a"], at: 1, more: false, busy: false, byWallet: {} };

  const off = renderToString(h(AutoBlockSwitch, { ab: { known: true, on: false, disabled: false } }));
  check("Auto-block is a switch, labelled, saying it's off", /role="switch"/.test(off) && /aria-checked="false"/.test(off) && off.includes("Auto-block") && /aria-describedby="autoblock-help"/.test(off), off);
  check("  a button, so a keyboard works it", /<button type="button" role="switch"/.test(off));
  const on = renderToString(h(AutoBlockSwitch, { ab: { known: true, on: true, disabled: false } }));
  check("  and on", /aria-checked="true"/.test(on) && /class="ab-switch on"/.test(on));
  check("  not drawn until the server has said which", renderToString(h(AutoBlockSwitch, { ab: { known: false } })) === "");
  const waiting = renderToString(h(AutoBlockSwitch, { ab: { known: true, on: false, disabled: true, reason: "x" } }));
  check("  disabled while it waits", /disabled/.test(waiting));
  const help = renderToString(h(AutoBlockHelp, { ab: { known: true, on: false, reason: autoBlockWaits(0.01, { ...ready, at: undefined }) } }));
  check("the help says what it does", help.includes("Stop serving listeners who are behind on paying, until they pay. Their app is told what they owe and pays it.") && /id="autoblock-help"/.test(help));
  check("  and why it can't be turned on yet", help.includes("Check who has paid first"));

  // The "?" beside the switch, the mechanics it opens (with this artist's own
  // numbers) and the question before turning it on, all drawn in the page.
  check("the switch has a ? beside it, closed to begin with", /class="why"/.test(off) && /aria-expanded="false"/.test(off) && /aria-controls="autoblock-explain"/.test(off), off);
  const opened = renderToString(h(AutoBlockHelp, { ab: { known: true, on: false, explaining: true, settleAt: 0.5, limit: 0.75 } }));
  check("  opening it says how it decides, with the real figures", opened.includes("autoblock-explain") && opened.includes("$0.75") && opened.includes("$0.50") && opened.includes("more than"), opened);
  check("  and what it never does", /subscribers/.test(opened) && /less than a cent/.test(opened) && /blocked yourself stay blocked/.test(opened) && /free tracks always play/.test(opened));
  check("  and how fast a block bites", /half an hour/.test(opened));
  const asked = renderToString(h(AutoBlockHelp, { ab: { known: true, on: false, asking: { count: 2, owed: 6_500_000 } } }));
  check("turning it on asks in the page, naming who and how much", asked.includes("Turn on Auto-block?") && asked.includes("2 listeners are behind right now") && asked.includes("$6.50") && asked.includes("Cancel"), asked);
  const none = renderToString(h(AutoBlockHelp, { ab: { known: true, on: false, asking: { count: 0, owed: 0 } } }));
  check("  and says so when nobody is behind", none.includes("Nobody is behind right now"));

  check("waits for a price", autoBlockWaits(0, ready) !== null && autoBlockWaits(0.01, { ...ready, addresses: [] }) !== null);
  check("  for payments to be read", /Check who has paid/.test(autoBlockWaits(0.01, { ...ready, at: undefined })));
  check("  for a reading to finish", /Checking/.test(autoBlockWaits(0.01, { ...ready, busy: true })));
  check("  for all of them, not some", /more payments/.test(autoBlockWaits(0.01, { ...ready, more: true })));
  check("  and then it can be turned on", autoBlockWaits(0.01, ready) === null);

  const NOW = Date.now();
  const rows = [
    { pubkey: W(1), seconds: 600, owed_seconds: 600, owed_micros: 5_000_000, last_seen: NOW },           // $5 behind
    { pubkey: W(2), seconds: 600, owed_seconds: 600, owed_micros: 5_000_000, last_seen: NOW },           // paid it
    { pubkey: W(3), seconds: 600, owed_seconds: 600, owed_micros: 5_000_000, last_seen: NOW, blocked: 1 }, // blocked by hand
    { pubkey: W(4), seconds: 600, owed_seconds: 600, owed_micros: 5_000_000, last_seen: NOW, subscribed_until: NOW + 86_400_000 },
    { pubkey: W(5), seconds: 600, owed_seconds: 600, owed_micros: 300_000, last_seen: NOW },             // under the point
  ];
  const paid = { ...ready, byWallet: { [W(2)]: { micros: 5_000_000 } } };
  const caught = wouldAutoBlock(rows, paid, 0.01, 0.5, NOW);
  check("turning it on would stop the one who's behind, owing $5", caught.length === 1 && caught[0].r.pubkey === W(1) && caught[0].owes === 5_000_000, JSON.stringify(caught.map((c) => c.r.pubkey)));
  check("  not one who paid, one blocked by hand, a subscriber, or one within their payment point", !caught.some((c) => [W(2), W(3), W(4), W(5)].includes(c.r.pubkey)));

  const many = { byWallet: Object.fromEntries(Array.from({ length: 2500 }, (_, i) => [W(i), { micros: 1000.4 + i }])) };
  many.byWallet.unknown = { micros: 5 };
  many.byWallet[W(9999)] = { micros: 0 };
  const chunks = paidChunks(many);
  check("what everyone paid goes in pieces of a thousand", chunks.length === 3 && Object.keys(chunks[0]).length === 1000 && Object.keys(chunks[2]).length === 500,
    chunks.map((c) => Object.keys(c).length).join());
  check("  as whole micros, real wallets only, nobody who paid nothing", chunks.every((c) => Object.entries(c).every(([w, m]) => Number.isInteger(m) && m > 0 && w !== "unknown")));

  check("a listener auto-blocked has a chip saying what they owe",
    renderToString(h(AutoBlockChip, { row: { auto_blocked: true, owes_micros: 1_840_000 } })).includes("Auto-blocked, owes $1.84"));
  check("  and nobody else does", renderToString(h(AutoBlockChip, { row: { auto_blocked: false, owes_micros: 1_840_000 } })) === "");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
