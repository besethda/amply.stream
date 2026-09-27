/**
 * Which tracks have to be paid for.
 *
 * The artist's server and the listening app both apply spec/pricing.mjs. If
 * it answers wrongly, a paid track plays for nothing — the whole point of an
 * artist setting a price, gone — or a track they gave away refuses to play.
 *
 *   node spec/test-pricing.mjs
 */
import { charges, needsWallet, perMinute, plans, subscriptionOnly, saleOf, forSale, includes, walletOf } from "./pricing.mjs";
import { validate } from "./manifest-rules.mjs";

let pass = 0, fail = 0;
const is = (name, got, want) => {
  const good = got === want;
  good ? pass++ : fail++;
  console.log(`${good ? "ok  " : "FAIL"}  ${name}${good ? "" : ` — expected ${want}, got ${got}`}`);
};

const ADDRESS = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const priced = { payment: [{ type: "solana-usdc", address: ADDRESS, ratePerMinute: 0.01 }] };
const unpriced = { payment: [] };
const linkOnly = { payment: [{ type: "link", label: "Bandcamp", url: "https://example.com" }] };

// ── does this artist charge ─────────────────────────────────────────────────

is("an artist with a price charges", charges(priced), true);
is("one with no payment does not", charges(unpriced), false);
is("one with no payment field does not", charges({}), false);
is("a Bandcamp link is not a charge per listen", charges(linkOnly), false);
is("a zero rate is not a charge",
  charges({ payment: [{ type: "solana-usdc", address: ADDRESS, ratePerMinute: 0 }] }), false);
is("nothing at all does not", charges(null), false);

// ── the rule ────────────────────────────────────────────────────────────────

is("if an artist charges, an ordinary track is paid for", needsWallet(priced, { id: "a" }), true);
is("  unless they made it free", needsWallet(priced, { id: "a", free: true }), false);
is("  and free means free even if an old flag says otherwise",
  needsWallet(priced, { id: "a", free: true, needsWallet: true }), false);
is("free: false is simply paid", needsWallet(priced, { id: "a", free: false }), true);

is("an artist who does not charge gives everything away", needsWallet(unpriced, { id: "a" }), false);
is("  including with only a Bandcamp link", needsWallet(linkOnly, { id: "a" }), false);
is("an explicit request for a wallet is still honoured",
  needsWallet(unpriced, { id: "a", needsWallet: true }), true);

is("no track, no requirement", needsWallet(priced, null), false);

// ── subscriptions: a second way to be paid, alongside or instead ────────────

const LINK = "https://buy.stripe.com/test_abc123";
const sub = { type: "stripe-subscription", plans: [{ months: 12, price: 10, currency: "usd", url: LINK }] };
const subOnly = { payment: [sub] };
const both = { payment: [...priced.payment, sub] };

is("an artist offering only a subscription charges", charges(subOnly), true);
is("  so their tracks need a wallet to identify the listener", needsWallet(subOnly, { id: "a" }), true);
is("  except the ones they made free", needsWallet(subOnly, { id: "a", free: true }), false);
is("  and a subscription is the only way to pay", subscriptionOnly(subOnly), true);
is("offering both, per-minute is still there", perMinute(both) && subscriptionOnly(both) === false, true);
is("per-minute alone has no plans", plans(priced).length, 0);
is("the plans are read back", plans(both)[0]?.months, 12);

// ── what the spec accepts ───────────────────────────────────────────────────

const base = {
  amply: 1, updated: "2026-09-21T00:00:00Z", artist: { name: "A" },
  licence: { type: "amply-personal-1" }, releases: [],
};
const errorsFor = (plansList) => validate({ ...base, payment: [{ type: "stripe-subscription", plans: plansList }] })
  .errors.filter((e) => e.startsWith("payment"));

is("a yearly $10 plan is valid", errorsFor([{ months: 12, price: 10, url: LINK }]).length, 0);
is("so are three lengths together",
  errorsFor([{ months: 3, price: 3, url: LINK }, { months: 6, price: 6, url: LINK }, { months: 12, price: 10, url: LINK }]).length, 0);
is("a monthly plan is refused — card fees eat it", errorsFor([{ months: 1, price: 1, url: LINK }]).length > 0, true);
is("a price under the minimum is refused", errorsFor([{ months: 12, price: 0.5, url: LINK }]).length > 0, true);
is("the same length twice is refused",
  errorsFor([{ months: 12, price: 10, url: LINK }, { months: 12, price: 12, url: LINK }]).length > 0, true);
is("a checkout that isn't Stripe's is refused", errorsFor([{ months: 12, price: 10, url: "https://evil.example/pay" }]).length > 0, true);
is("no plans at all is refused", errorsFor([]).length > 0, true);

// ── selling songs and albums ────────────────────────────────────────────────

{
  const LINK = "https://buy.stripe.com/test_abc";
  const base = (payment, rSale, tSale) => ({
    amply: 1, updated: "2026-09-24T00:00:00Z", artist: { name: "A" }, licence: { type: "amply-personal-1" }, payment,
    releases: [{ id: "album", title: "Album", sale: rSale, tracks: [
      { id: "one", title: "One", duration: 100, url: "https://x.example/a/1.mp3", sale: tSale },
      { id: "two", title: "Two", duration: 100, url: "https://x.example/a/2.mp3" },
    ] }],
  });
  const both = base(priced.payment, { price: 8, url: LINK }, { price: 1, url: LINK });
  is("an album with a link and a wallet can be bought by card or wallet", !!(saleOf(both, both.releases[0])?.card && saleOf(both, both.releases[0])?.wallet), true);
  is("  at its price", saleOf(both, both.releases[0]).price, 8);
  const cardOnly = base([], { price: 8, url: LINK });
  is("with no wallet, card only", !!saleOf(cardOnly, cardOnly.releases[0])?.card && !saleOf(cardOnly, cardOnly.releases[0]).wallet, true);
  const walletOnly = base(priced.payment, { price: 8 });
  is("with no link, wallet only", !saleOf(walletOnly, walletOnly.releases[0]).card && !!saleOf(walletOnly, walletOnly.releases[0]).wallet, true);
  const neither = base([], { price: 8 });
  is("with neither, not for sale", saleOf(neither, neither.releases[0]), null);
  is("a link that isn't Stripe's isn't a way to pay", saleOf(cardOnly, { sale: { price: 8, url: "https://evil.example/pay" } }), null);
  is("too cheap isn't for sale", saleOf(both, { sale: { price: 0.2, url: LINK } }), null);
  is("everything for sale: the album and the one priced song", forSale(both).map((x) => `${x.kind}:${x.id}`).join(","), "album:album,song:one");
  is("  the album includes both songs", forSale(both)[0].tracks.join(","), "one,two");
  is("a song is included by itself and its album", includes(both, "two").join(","), "two,album");
  is("the wallet names who is paid, and where", walletOf(priced).recipients[0].address + " " + walletOf(priced).network, `${ADDRESS} solana`);

  const rules = (m) => validate(m);
  is("the rules accept a sale", rules(both).errors.length, 0);
  is("  but not below 50 cents", rules(base([], { price: 0.3, url: LINK })).errors.some((e) => e.includes("sale.price")), true);
  is("  or a link that isn't Stripe's", rules(base([], { price: 3, url: "https://evil.example/x" })).errors.some((e) => e.includes("sale.url")), true);
  is("  or another currency", rules(base([], { price: 3, url: LINK, currency: "sek" })).errors.some((e) => e.includes("sale.currency")), true);
  is("  and warn when there's no way to pay", rules(neither).warnings.some((w) => w.includes("no way to pay")), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
