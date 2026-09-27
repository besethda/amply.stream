/**
 * Selling songs and albums to keep: the rules the artist's server has to hold
 * to, against a real SQLite, with Stripe and the chain stood in for.
 *
 *   - a payment buys one thing, once, for the wallet that made it;
 *   - a wallet payment has to say what it was for, or an old tip could be
 *     passed off as paying for an album;
 *   - each song of a purchase downloads a few times, and no more;
 *   - a gift belongs to nobody until its code is claimed, and then to one wallet.
 *
 * Run via `npm run test:sales`.
 */
import { DatabaseSync } from "node:sqlite";
import { SCHEMA } from "./src/store.ts";
import { recordSale, purchasesOf, downloadsOf, redeem, takeDownload, claimWalletSale, GIFT_RE } from "./src/sales.ts";
import { setSales, claimSale } from "./src/stripe.ts";
import { verifyPayment, purchaseMemo, MEMO_PROGRAM } from "./src/payment-check.ts";
import { DOWNLOADS_PER_PURCHASE } from "../spec/pricing.mjs";

function d1(db) {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        async run() { stmt.run(...args); },
        async first() { return stmt.get(...args) ?? null; },
        async all() { return { results: stmt.all(...args) }; },
      };
      return api;
    },
  };
}
const sqlite = new DatabaseSync(":memory:");
for (const s of SCHEMA) sqlite.exec(s);
const DB = d1(sqlite);

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

const A = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const B = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const ARTIST = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const LINK = "https://buy.stripe.com/test_album";
const manifest = {
  amply: 1, artist: { name: "Seller" },
  payment: [{ type: "solana-usdc", address: ARTIST, ratePerMinute: 0.01, network: "devnet" }],
  releases: [
    { id: "album", title: "Album", sale: { price: 8, url: LINK }, tracks: [
      { id: "one", title: "One", duration: 100, url: "https://s.example/audio/1.mp3", sale: { price: 1 } },
      { id: "two", title: "Two", duration: 100, url: "https://s.example/audio/2.mp3" },
    ] },
    { id: "other", title: "Other", tracks: [{ id: "three", title: "Three", duration: 100, url: "https://s.example/audio/3.mp3" }] },
  ],
};

// ── a purchase is recorded once ─────────────────────────────────────────────

const s1 = await recordSale(DB, { ref: "cs_test_1", item: "album", buyer: A, gift: false, via: "card" });
ok("a purchase belongs to the wallet that paid", s1.owner === A && s1.item === "album" && !s1.gift);
const again = await recordSale(DB, { ref: "cs_test_1", item: "one", buyer: B, gift: true, via: "card" });
ok("the same payment claimed again is the same purchase, not a new one", again.owner === A && again.item === "album" && again.buyer === A);

// ── downloads ───────────────────────────────────────────────────────────────

let last = null;
for (let i = 0; i < DOWNLOADS_PER_PURCHASE; i++) last = await takeDownload(DB, manifest, A, "two");
ok(`each song downloads ${DOWNLOADS_PER_PURCHASE} times`, last?.left === 0, JSON.stringify(last));
ok("  and then no more", (await takeDownload(DB, manifest, A, "two")) === null);
ok("the album's other song has its own downloads", (await takeDownload(DB, manifest, A, "one"))?.left === DOWNLOADS_PER_PURCHASE - 1);
ok("a song not in anything bought can't be downloaded", (await takeDownload(DB, manifest, A, "three")) === null);
ok("someone else can't download what A bought", (await takeDownload(DB, manifest, B, "one")) === null);
const counts = await downloadsOf(DB, ["cs_test_1"]);
ok("downloads are counted per song", counts.cs_test_1.two === DOWNLOADS_PER_PURCHASE && counts.cs_test_1.one === 1, JSON.stringify(counts));
await recordSale(DB, { ref: "tx_song_one", item: "one", buyer: A, gift: false, via: "usdc" });
let n = 0;
for (let i = 0; i < 10; i++) if (await takeDownload(DB, manifest, A, "one")) n++;
ok("two purchases that include a song give both their downloads", n === (DOWNLOADS_PER_PURCHASE - 1) + DOWNLOADS_PER_PURCHASE, String(n));

// ── gifts ───────────────────────────────────────────────────────────────────

const g = await recordSale(DB, { ref: "cs_test_gift", item: "album", buyer: A, gift: true, via: "card" });
ok("a gift has a code and no owner yet", GIFT_RE.test(g.gift || "") && g.owner === null);
ok("  the buyer can't download it themselves", (await purchasesOf(DB, A)).owned.every((s) => s.ref !== "cs_test_gift"));
ok("  but sees it among their unclaimed gifts", (await purchasesOf(DB, A)).gifts.some((s) => s.ref === "cs_test_gift"));
ok("a wrong code claims nothing", (await redeem(DB, B, "1111111111111111111z")) === null);
ok("the right code makes B its owner", (await redeem(DB, B, g.gift)) === "album");
ok("  once", (await redeem(DB, A, g.gift)) === null);
ok("  and B can download it", (await takeDownload(DB, manifest, B, "two"))?.left === DOWNLOADS_PER_PURCHASE - 1);
ok("  and it's no longer an unclaimed gift", (await purchasesOf(DB, A)).gifts.length === 0);

// ── paying in USDC ──────────────────────────────────────────────────────────

const HOST = "s.example";
let asked = null;
const verify = async (claim, terms) => { asked = { claim, terms }; return { ok: true, micros: terms.minMicros }; };
const sig = "5".repeat(88);
const w = await claimWalletSale(DB, manifest, { wallet: B, signature: sig, item: "one", gift: false, host: HOST }, { verify });
ok("a USDC purchase is recorded when the chain agrees", w.ok && w.sale.owner === B && w.sale.via === "usdc");
ok("  asked for at least the price, to the artist, from the buyer", asked.terms.minMicros === 1_000_000 && asked.terms.recipients[0] === ARTIST && asked.claim.payer === B);
ok("  on the artist's chain", asked.terms.rpc.includes("devnet"));
ok("  and only a payment that says it was for this song, here", asked.terms.memo === purchaseMemo(HOST, "one"));
const reuse = await claimWalletSale(DB, manifest, { wallet: A, signature: sig, item: "one", gift: false, host: HOST }, { verify });
ok("someone else can't claim the same payment", !reuse.ok);
const other = await claimWalletSale(DB, manifest, { wallet: B, signature: sig, item: "album", gift: false, host: HOST }, { verify });
ok("  nor can it buy something else as well", !other.ok);
const notForSale = await claimWalletSale(DB, manifest, { wallet: B, signature: "6".repeat(88), item: "three", gift: false, host: HOST }, { verify });
ok("something not for sale can't be bought", !notForSale.ok);
const busy = await claimWalletSale(DB, manifest, { wallet: B, signature: "7".repeat(88), item: "one", gift: false, host: HOST },
  { verify: async () => ({ ok: false, why: "the network is busy" }) });
ok("a network that can't be asked means try again, not refused", !busy.ok && busy.retry === true);
const short = await claimWalletSale(DB, manifest, { wallet: B, signature: "8".repeat(88), item: "one", gift: false, host: HOST },
  { verify: async () => ({ ok: false, why: "that payment was too small" }) });
ok("too little is refused for good", !short.ok && !short.retry);

// The chain check itself: the note has to be there, and be this one.
const realFetch = globalThis.fetch;
const txWith = (memo, { mint = "MINT", held = "MINT", authority = B, bare = false } = {}) => ({
  result: {
    meta: { err: null, postTokenBalances: [{ accountIndex: 1, owner: ARTIST, mint: held }], innerInstructions: [] },
    blockTime: 1,
    transaction: { message: {
      accountKeys: [{ pubkey: B }, { pubkey: "ArtistTokenAccount1111111111111111111111111" }],
      instructions: [
        bare
          ? { parsed: { type: "transfer", info: { authority, destination: "ArtistTokenAccount1111111111111111111111111", amount: "1000000" } } }
          : { parsed: { type: "transferChecked", info: { authority, destination: "ArtistTokenAccount1111111111111111111111111", mint, tokenAmount: { amount: "1000000" } } } },
        ...(memo ? [{ program: "spl-memo", programId: MEMO_PROGRAM, parsed: memo }] : []),
      ],
    } },
  },
});
const terms = { rpc: "https://rpc.example", mint: "MINT", recipients: [ARTIST], minMicros: 1_000_000, memo: purchaseMemo(HOST, "one") };
for (const [label, memo, want] of [["with this purchase's note, accepted", purchaseMemo(HOST, "one"), true],
  ["with no note (a tip, a settled listen), refused", null, false],
  ["with another item's note, refused", purchaseMemo(HOST, "album"), false],
  ["with another artist's note, refused", purchaseMemo("elsewhere.example", "one"), false]]) {
  globalThis.fetch = async () => new Response(JSON.stringify(txWith(memo)));
  const r = await verifyPayment({ signature: "9".repeat(88), payer: B }, terms);
  ok(`the chain check: a payment ${label}`, r.ok === want, JSON.stringify(r));
}
const memo1 = purchaseMemo(HOST, "one");
for (const [label, opts, want] of [
  ["a bare transfer into the artist's USDC account counts", { bare: true }, true],
  ["a bare transfer of a worthless token, into an account of it the artist 'owns', doesn't", { bare: true, held: "WORTHLESS" }, false],
  ["a transfer someone else sent doesn't count as the buyer's", { authority: A }, false],
]) {
  globalThis.fetch = async () => new Response(JSON.stringify(txWith(memo1, opts)));
  const r = await verifyPayment({ signature: "9".repeat(88), payer: B }, terms);
  ok(`the chain check: ${label}`, r.ok === want, JSON.stringify(r));
}

// ── card: links in the artist's Stripe, and checkouts confirmed ─────────────

const calls = [];
let nextId = 0;
globalThis.fetch = async (url, init) => {
  const path = new URL(url).pathname.replace("/v1", "");
  const body = new URLSearchParams(init?.body || "");
  calls.push({ method: init?.method || "GET", path, body });
  if (path === "/products" && init?.method === "POST") return new Response(JSON.stringify({ id: `prod_${++nextId}` }));
  if (path === "/prices") return new Response(JSON.stringify({ id: `price_${++nextId}`, unit_amount: Number(body.get("unit_amount")) }));
  if (path === "/payment_links") return new Response(JSON.stringify({ id: `plink_${++nextId}`, url: `https://buy.stripe.com/test_${nextId}` }));
  return new Response(JSON.stringify({ data: [] }));
};
const KEY = "rk_test_abc123";
const first = await setSales(DB, { key: KEY, items: [{ item: "album", title: "Album", price: 8 }, { item: "one", title: "One", price: 1 }], artist: "Seller", returnTo: "https://amply.stream/app/?bought=x&session={CHECKOUT_SESSION_ID}" });
ok("a link is made for each album and song sold", first.length === 2 && first.every((l) => l.url.startsWith("https://buy.stripe.com/")));
const priceCall = calls.find((c) => c.path === "/prices");
ok("  as a one-off price in dollars", priceCall.body.get("unit_amount") === "800" && priceCall.body.get("currency") === "usd" && !priceCall.body.has("recurring[interval]"));
const linkCall = calls.find((c) => c.path === "/payment_links");
ok("  sending the buyer back to the app to claim it", /bought=/.test(linkCall.body.get("after_completion[redirect][url]") || ""));
ok("  and telling them the download starts at once", /can't be returned/.test(linkCall.body.get("custom_text[submit][message]") || ""));
calls.length = 0;
const second = await setSales(DB, { items: [{ item: "album", title: "Album", price: 8 }, { item: "one", title: "One", price: 2 }], artist: "Seller", returnTo: "https://amply.stream/app/" });
ok("publishing again keeps a link whose price didn't change", second[0].linkId === first[0].linkId);
ok("  makes a new one for a changed price", second[1].linkId !== first[1].linkId);
ok("  and stops the old one", calls.some((c) => c.path === `/payment_links/${first[1].linkId}` && c.body.get("active") === "false"));
globalThis.fetch = realFetch;

const albumLink = second[0].linkId;
const session = (over) => async () => ({ id: "cs_test_abcdefghijkl", mode: "payment", status: "complete", payment_status: "paid", client_reference_id: A, payment_link: albumLink, ...over });
const good = await claimSale(DB, A, "cs_test_abcdefghijkl", { loadSession: session({}) });
ok("a paid checkout on an album's link buys the album", good.outcome === "recorded" && good.item === "album");
ok("  not for another wallet", (await claimSale(DB, B, "cs_test_abcdefghijkl", { loadSession: session({}) })).outcome === "refused");
ok("  not on a link this server didn't make", (await claimSale(DB, A, "cs_test_abcdefghijkl", { loadSession: session({ payment_link: "plink_merch" }) })).outcome === "refused");
ok("  not a subscription checkout", (await claimSale(DB, A, "cs_test_abcdefghijkl", { loadSession: session({ mode: "subscription" }) })).outcome === "refused");
ok("  and not yet if it isn't paid", (await claimSale(DB, A, "cs_test_abcdefghijkl", { loadSession: session({ payment_status: "unpaid" }) })).outcome === "pending");
ok("  a made-up checkout id is refused without asking", (await claimSale(DB, A, "not-a-session")).outcome === "refused");
let stripeAsked = 0;
const blind = await claimSale(DB, A, "", { loadSession: async () => { stripeAsked++; return {}; } });
ok("a claim with no checkout is refused, without asking Stripe anything", blind.outcome === "refused" && stripeAsked === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
