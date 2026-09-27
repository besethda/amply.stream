/**
 * The artist's public page, and the paid music on it.
 *
 * This page used to play every track in the browser to anyone, with no
 * wallet and no payment, which made an artist's own link the easiest way not
 * to pay them. The server now refuses those requests, so a paid track has to
 * send the listener to the app instead of offering a play button that would
 * fail — and a free one has to keep playing right here.
 *
 *   node --experimental-strip-types node/test-page.mjs
 */
import { renderPage, renderPrivacy } from "./src/page.ts";
import { validate } from "../spec/manifest-rules.mjs";
import { guardedKeys } from "./src/listen.ts";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

const ORIGIN = "https://someone.example.workers.dev";
const track = (id, extra = {}) => ({
  id, title: `Track ${id}`, duration: 200, url: `${ORIGIN}/audio/${id}.mp3`, ...extra,
});
const manifest = (payment, tracks) => ({
  amply: 1, artist: { name: "Someone" }, payment,
  releases: [{ id: "r", title: "Record", tracks }],
});
const PRICE = [{ type: "solana-usdc", address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", ratePerMinute: 0.01 }];

// ── an artist who charges ───────────────────────────────────────────────────

const paid = manifest(PRICE, [track("one"), track("two", { free: true })]);
const html = renderPage(paid, ORIGIN, "n");

ok("a paid track has no in-browser play button",
  !html.includes(`data-src="${ORIGIN}/audio/one.mp3"`));
ok("  it sends the listener to the app, with the artist already added",
  html.includes(`amply.stream/app/?add=${encodeURIComponent(`${ORIGIN}/manifest.json`)}`));
ok("a free track still plays right here", html.includes(`data-src="${ORIGIN}/audio/two.mp3"`));
ok("  and says it is free", html.includes('class="free"'));
ok("the page says the music is paid for, and where to listen",
  html.includes("paid for as you listen") && html.includes("Open in the Amply app"));
ok("it no longer tells people to listen freely", !html.includes("Listen freely"));

// ── and the server agrees about which is which ──────────────────────────────

const guarded = guardedKeys(paid);
ok("the server refuses the paid track without a wallet", guarded.has("one.mp3"));
ok("  and serves the free one to anyone", !guarded.has("two.mp3"));

// ── an artist who gives it all away ─────────────────────────────────────────

const free = manifest([], [track("one"), track("two")]);
const freeHtml = renderPage(free, ORIGIN, "n");
ok("with no price, every track plays in the browser",
  freeHtml.includes(`data-src="${ORIGIN}/audio/one.mp3"`) && freeHtml.includes(`data-src="${ORIGIN}/audio/two.mp3"`));
ok("  with no call to open the app", !freeHtml.includes("Open in the Amply app"));
ok("  and nothing guarded on the server", guardedKeys(free).size === 0);

// ── the page escapes what an artist writes, paid or not ─────────────────────

const hostile = manifest(PRICE, [track("x", { title: "<script>alert(1)</script>" })]);
ok("a track title cannot inject markup", !renderPage(hostile, ORIGIN, "n").includes("<script>alert(1)"));

// ── how the page looks when its link is shared ──────────────────────────────
//
// Messages, WhatsApp and the rest build a card from these tags. The page, not
// the manifest, is the link artists share.

const meta = (html, key) => (html.match(new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`)) || [])[1];
const shared = {
  ...manifest([], [track("one")]),
  artist: { name: "Someone", bio: "Songs from the coast.", image: "https://x.example/photo.jpg", banner: "https://x.example/banner.jpg" },
  releases: [
    { id: "old", title: "Old", date: "2024-01-01", art: "https://x.example/old.jpg", tracks: [track("a")] },
    { id: "new", title: "New", date: "2026-09-01", art: "https://x.example/new.jpg", tracks: [track("b")] },
  ],
};
const card = renderPage(shared, ORIGIN, "n");
ok("a shared link has a title, a description and its own address",
  meta(card, "og:title") === "Someone" && meta(card, "og:description") === "Songs from the coast." && meta(card, "og:url") === `${ORIGIN}/`);
ok("  and shows the wide banner, as a large card", meta(card, "og:image") === "https://x.example/banner.jpg" && meta(card, "twitter:card") === "summary_large_image");
const noBanner = renderPage({ ...shared, artist: { ...shared.artist, banner: undefined } }, ORIGIN, "n");
ok("without a banner, the newest release's cover", meta(noBanner, "og:image") === "https://x.example/new.jpg" && meta(noBanner, "twitter:card") === "summary");
const bare = renderPage({ ...manifest([], [track("one")]), artist: { name: "Someone" } }, ORIGIN, "n");
ok("with no bio, a description all the same", /Listen to Someone/.test(meta(bare, "og:description") || ""));

// Linked to one song or album: the card is that one, and the button opens it.
const songCard = renderPage(shared, ORIGIN, "n", { kind: "song", id: "a" });
ok("a song link's card is the song: its title, by whom, and its cover",
  meta(songCard, "og:title") === "Track a — Someone" && /A song by Someone/.test(meta(songCard, "og:description")) && meta(songCard, "og:image") === "https://x.example/old.jpg");
ok("  its own address", meta(songCard, "og:url") === `${ORIGIN}/?song=a`);
ok("  and its button opens that song in the app",
  songCard.includes(`amply.stream/app/?song=${encodeURIComponent(`${ORIGIN}/manifest.json`)}&amp;id=a`) || songCard.includes(`amply.stream/app/?song=${encodeURIComponent(`${ORIGIN}/manifest.json`)}&id=a`));
const albumCard = renderPage(shared, ORIGIN, "n", { kind: "album", id: "new" });
ok("an album link's card is the album", meta(albumCard, "og:title") === "New — Someone" && meta(albumCard, "og:image") === "https://x.example/new.jpg" && meta(albumCard, "og:type") === "music.album");
const nowhere = renderPage(shared, ORIGIN, "n", { kind: "song", id: "gone" });
ok("a link to something no longer there is just the artist's page", meta(nowhere, "og:title") === "Someone" && !nowhere.includes('class="linked"'));
ok("each paid song's button opens that song in the app", html.includes(`?song=${encodeURIComponent(`${ORIGIN}/manifest.json`)}&amp;id=one`) || html.includes(`?song=${encodeURIComponent(`${ORIGIN}/manifest.json`)}&id=one`));
const hostileTitle = renderPage({ ...shared, releases: [{ ...shared.releases[0], tracks: [track("a", { title: '"><script>x</script>' })] }] }, ORIGIN, "n", { kind: "song", id: "a" });
ok("a song's title can't break out of the card", !hostileTitle.includes("<script>x"));
const sneaky = renderPage({ ...shared, artist: { ...shared.artist, bio: '"><script>alert(1)</script>' } }, ORIGIN, "n");
ok("a bio can't break out of the tags", !sneaky.includes("<script>alert(1)") && !sneaky.includes('content=""><'));

// ── the artist's privacy notice ─────────────────────────────────────────────
//
// Written by the software, from what it keeps, so an artist who charges has a
// correct notice without ever writing one. GDPR Article 13 asks for who is
// responsible and how to reach them, what is kept and why, for how long, who
// else is involved, and the listener's rights.

{
  const withContact = { ...paid, artist: { name: "Someone", contact: "someone@example.com" } };
  const notice = renderPrivacy(withContact, ORIGIN, "n");
  ok("the notice names who is responsible", notice.includes("Someone is responsible"));
  ok("  and how to reach them", notice.includes('href="mailto:someone@example.com"'));
  ok("  what is kept", notice.includes("your wallet address") && notice.includes("for how many minutes"));
  ok("  and, as plainly, what is not", notice.includes("which tracks you played"));
  ok("  why, with the legal basis", notice.includes("6(1)(b)") && notice.includes("6(1)(f)"));
  ok("  for how long", notice.includes("A year after you last listened"));
  ok("  who else is involved", notice.includes("Cloudflare") && notice.includes("Amply</strong>, which made the software, receives nothing"));
  ok("  and how to use your rights without asking anyone", notice.includes("What they keep") && notice.includes("See it") && notice.includes("Erase"));
  ok("  including a complaint to a regulator", notice.includes("data protection authority"));

  const page = renderPrivacy({ ...paid, artist: { name: "Someone", contact: "https://someone.example/contact" } }, ORIGIN, "n");
  ok("a contact page is linked rather than mailed", page.includes('href="https://someone.example/contact"'));

  const none = renderPrivacy(paid, ORIGIN, "n");
  ok("with no contact yet, the notice says so and still explains the app route",
    none.includes("has not added a contact address") && none.includes("from the Amply app"));

  const giving = renderPrivacy(free, ORIGIN, "n");
  ok("an artist who gives their music away keeps nothing, and says so",
    giving.includes("Nothing is kept about you") && !giving.includes("6(1)(b)"));

  const hostile = renderPrivacy({ ...paid, artist: { name: "<img src=x onerror=alert(1)>", contact: "a@b.co" } }, ORIGIN, "n");
  ok("an artist's name cannot inject markup into the notice", !hostile.includes("<img src=x"));

  ok("the artist's page links to the notice", html.includes('href="/privacy"'));

  const subscribing = renderPrivacy({ ...paid, payment: [...PRICE, { type: "stripe-subscription",
    plans: [{ months: 12, price: 10, url: "https://buy.stripe.com/test_1" }] }] }, ORIGIN, "n");
  ok("selling subscriptions, the notice names Stripe and what it holds",
    subscribing.includes("<strong>Stripe</strong> handles subscriptions") && subscribing.includes("name, email and card"));
  ok("  and says erasure doesn't remove a subscription that's still running", subscribing.includes("because it is what you bought"));
  ok("not selling them, Stripe isn't mentioned", !notice.includes("<strong>Stripe</strong>"));

  // Selling songs to keep leaves a record, charged listening or not.
  const album = (m) => ({ ...m, releases: m.releases.map((r) => ({ ...r, sale: { price: 8, url: "https://buy.stripe.com/test_a" } })) });
  const sellingFree = renderPrivacy(album(free), ORIGIN, "n");
  ok("an artist who gives music away but sells albums says purchases are kept",
    sellingFree.includes("If you buy") && sellingFree.includes("what you bought") && !sellingFree.includes("Nothing is kept about you"));
  ok("  that listening still leaves no record", sellingFree.includes("Listening leaves no record"));
  ok("  and that Stripe holds the card", sellingFree.includes("Stripe\nholds your name") || sellingFree.includes("Stripe holds your name") || /Stripe\s+holds your name/.test(sellingFree));
  ok("  with rights and a complaint route", sellingFree.includes("What they keep") && sellingFree.includes("data protection authority"));
  ok("a charging artist who sells says so too", renderPrivacy(album(paid), ORIGIN, "n").includes("If you buy"));
  ok("not selling, purchases aren't mentioned", !notice.includes("If you buy"));
}

// ── the contact an artist gives ─────────────────────────────────────────────

{
  const check = (contact) => validate({
    amply: 1, updated: "2026-09-21T00:00:00Z", artist: { name: "A", contact },
    licence: { type: "amply-personal-1" }, payment: [], releases: [],
  }).errors.filter((e) => e.startsWith("artist.contact"));
  ok("an email address is accepted as a contact", check("a@b.co").length === 0);
  ok("  so is an https page", check("https://example.com/contact").length === 0);
  ok("  but not an http one", check("http://example.com").length === 1);
  ok("  or something that is neither", check("call me").length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
