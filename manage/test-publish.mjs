/**
 * What Publish is allowed to send.
 *
 * The editor once published a manifest the spec rejects: a release with no
 * tracks. It also dropped an artist's price without a word when there was no
 * address to pay, and a "free" price would have produced a rate of zero, which
 * the spec also rejects. These cases pin down that what leaves the editor is
 * always valid, and that when something blocks a publish the artist is told
 * which thing, in their terms.
 *
 * Run via `npm --prefix manage run test`.
 */
import { buildManifest, explain, AUDIO_ACCEPT, salePrice, saleItems, withSaleLinks } from "./src/ui.jsx";
import { readFileSync } from "node:fs";
import { validate } from "../spec/manifest-rules.mjs";

const A = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const B = "9mPQ4cLXmhVYPb2M9fVd8rTgFq7WuXsKbNa1ZyEeRtUv";
const N = "https://node.test";
const track = (id, title = "Song") => ({ id, title, duration: 200, url: `${N}/audio/${id}.mp3` });

const base = (over = {}) => ({
  amply: 1, updated: "2026-09-19T12:00:00Z",
  artist: { name: "Test" },
  content: { explicit: false },
  licence: { type: "amply-personal-1" },
  payment: [{ type: "solana-usdc", ratePerMinute: 0.01, settleAt: 20 }],
  releases: [{ id: "r1", title: "One", tracks: [track("t1")] }],
  ...over,
});
const me = [{ name: "Test", address: A, split: 100 }];
const nobody = [{ name: "Test", address: "", split: 100 }];

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : `\n        ${detail}`}`);
};
const valid = (name, m, payees) => {
  const out = buildManifest(m, payees);
  const { errors } = validate(out);
  ok(name, errors.length === 0, errors.join("; "));
  return out;
};
const blocked = (name, m, payees, expect) => {
  const out = buildManifest(m, payees);
  const { errors } = validate(out);
  const said = errors.length ? explain(errors[0], out) : "(nothing, it published)";
  ok(name, errors.length > 0 && expect.test(said), `artist was told: ${said}`);
};

// The manifest actually live on the test node at the time of writing: art and
// photos set, one release, its only track removed. It was invalid.
valid("the real broken node: an emptied release is left off, not published empty", {
  amply: 1, updated: "2026-09-19T12:49:14.309Z",
  artist: { name: "besethdascool", banner: `${N}/art/b.jpeg`, image: `${N}/art/a.jpeg` },
  content: { explicit: true }, licence: { type: "amply-personal-1" }, payment: [],
  releases: [{ id: "release", title: "I just want your love", tracks: [], art: `${N}/art/c.jpeg`, date: "2026-09-16" }],
}, nobody);

{
  const out = buildManifest(base({ releases: [
    { id: "r1", title: "One", tracks: [track("t1")] },
    { id: "r2", title: "Draft", tracks: [] },
  ] }), me);
  ok("a draft release stays out of the manifest", out.releases.length === 1 && out.releases[0].id === "r1");
}

// Price and payment.
{
  const out = valid("a price with an address publishes", base(), me);
  ok("  and the price is in it", out.payment[0]?.ratePerMinute === 0.01);
}
{
  const out = valid("a price with no address publishes without payment", base(), nobody);
  ok("  and says nothing about a rate it cannot collect", out.payment.length === 0);
}
{
  const m = base({ payment: [{ type: "solana-usdc", ratePerMinute: 0, settleAt: 20 }] });
  const out = valid("free with an address is valid", m, me);
  ok("  because free publishes no metered payment at all", !out.payment.some((p) => p.type === "solana-usdc"));
}
{
  const m = base({ payment: [{ type: "solana-usdc", ratePerMinute: 0.02 }, { type: "link", label: "Ko-fi", url: "https://ko-fi.com/x" }] });
  const out = valid("a support link survives alongside the wallet", m, me);
  ok("  with the wallet first", out.payment[0].type === "solana-usdc" && out.payment[1].type === "link");
}
valid("a 60/40 split publishes", base(), [
  { name: "A", address: A, split: 60 }, { name: "B", address: B, split: 40 },
]);

// Blocked, and told why in plain terms.
blocked("a release with music but no name", base({ releases: [{ id: "r1", title: "", tracks: [track("t1")] }] }), me,
  /release needs a name/);
blocked("a track with no name", base({ releases: [{ id: "r1", title: "One", tracks: [track("t1", "")] }] }), me,
  /track 1 on “One” has none/);
blocked("a payment address that is not one", base(), [{ name: "", address: "not-an-address", split: 100 }],
  /payment address .* doesn't look right/);
blocked("shares that add up to 90", base(), [
  { name: "A", address: A, split: 60 }, { name: "B", address: B, split: 30 },
], /add up to 90\.00%, not 100%/);
blocked("a link without https", base({ artist: { name: "Test", links: [{ label: "Site", url: "http://x.test" }] } }), me,
  /Link 1 .* https:\/\//);
blocked("no name at all", base({ artist: { name: "" } }), me, /name you release under/);

// The audio picker. "audio/*" made phones offer only pictures, so the picker
// names every type instead, and it must name exactly what the node accepts:
// anything missing is a file an artist cannot choose, anything extra is one the
// node would store as unplayable. Run from manage/, as npm --prefix does.
{
  const node = readFileSync("../node/src/index.ts", "utf8");
  const table = node.match(/const AUDIO_TYPES[^{]*\{([^}]*)\}/)[1];
  const nodeExts = [...table.matchAll(/(\w+):/g)].map((m) => `.${m[1]}`).sort();
  const offered = AUDIO_ACCEPT.split(",").filter((x) => x.startsWith(".")).sort();
  ok("the picker never uses the audio/* wildcard", !AUDIO_ACCEPT.includes("audio/*"));
  ok("the picker offers every extension the node plays",
    nodeExts.every((e) => offered.includes(e)), `missing: ${nodeExts.filter((e) => !offered.includes(e))}`);
  ok("and nothing the node does not",
    offered.every((e) => nodeExts.includes(e)), `extra: ${offered.filter((e) => !nodeExts.includes(e))}`);
}

// ── selling songs and albums ────────────────────────────────────────────────
{
  ok("a price reads as dollars to the cent", salePrice("7.999") === 8 && salePrice("$1.50") === 1.5 && salePrice("") === null && salePrice("0") === null);
  const m = base({ releases: [
    { id: "r1", title: "One", sale: { price: 8 }, tracks: [{ ...track("t1"), sale: { price: 1 } }, track("t2")] },
    { id: "r2", title: "Draft", sale: { price: 5 }, tracks: [] },
  ] });
  const items = saleItems(m);
  ok("what's for sale: the album and the priced song, not a draft with no tracks",
    items.map((i) => `${i.item}:${i.price}`).join(",") === "r1:8,t1:1", JSON.stringify(items));
  const linked = withSaleLinks(m, { r1: "https://buy.stripe.com/test_r1" });
  ok("card links go on what has one", linked.releases[0].sale.url === "https://buy.stripe.com/test_r1" && !linked.releases[0].tracks[0].sale.url);
  ok("and come off what no longer does", !withSaleLinks(linked, {}).releases[0].sale.url);
  ok("an album for sale by card publishes valid", validate(buildManifest(linked, [{ address: A, split: 100 }])).errors.length === 0,
    JSON.stringify(validate(buildManifest(linked, [{ address: A, split: 100 }])).errors));
  const broken = base({ releases: [{ id: "r1", title: "One", tracks: [{ ...track("t1"), sale: {} }] }] });
  const e = validate(buildManifest(broken, [{ address: A, split: 100 }])).errors.find((x) => x.includes("sale.price"));
  ok("a song for sale without a price is explained in the artist's terms", /needs a price from \$0\.50/.test(explain(e, broken)), explain(e || "", broken));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
