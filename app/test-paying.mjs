/**
 * Deciding who is owed what, and when it goes.
 *
 * The sending itself is proved against a real network in prove-payment.mjs.
 * What is checked here is the decision in front of it, which is where a wrong
 * answer means an artist not being paid, or being paid twice.
 *
 * Run via `npm --prefix app run test`.
 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const p = await import("./src/paying.js");
const { agreeRate } = await import("./src/spend.js");
const { toMicros } = await import("./src/money.js");
const { rateOf } = await import("./src/manifest.js");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};
const is = (name, got, want) => ok(name, Object.is(got, want), `expected ${want}, got ${got}`);

const URL_A = "https://a.test/manifest.json";
const URL_B = "https://b.test/manifest.json";

const artist = (url, perMinute, settleAt = 0.2, network) => ({
  url,
  manifest: {
    artist: { name: url },
    payment: perMinute == null ? [] : [{
      type: "solana-usdc", address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      ratePerMinute: perMinute, settleAt,
      ...(network ? { network } : {}),
    }],
    releases: [],
  },
});

/** Put this device's wallet on a network, the way the app stores it. */
const walletOn = (name) => store.set("amply.network.v1", name);

// ── banking listening against the right artist ──────────────────────────────

store.clear(); agreeRate(URL_A, 0.02); agreeRate(URL_B, 0.02);
{
  const entries = [artist(URL_A, 0.01), artist(URL_B, 0.02)];
  agreeRate(URL_B, 0.02);
  const ledger = p.bank({}, entries, { [URL_A]: 60, [URL_B]: 60 });
  is("each artist is owed at their own rate", ledger[URL_A].micros, toMicros(0.01));
  is("  and the other at theirs", ledger[URL_B].micros, toMicros(0.02));
  is("nothing is owed to anyone else", Object.keys(ledger).length, 2);
}

store.clear(); agreeRate(URL_A, 0.02); agreeRate(URL_B, 0.02);
{
  // Listening to somebody who is not in the library at all.
  const ledger = p.bank({}, [artist(URL_A, 0.01)], { "https://ghost.test/manifest.json": 600 });
  is("seconds against an unknown artist are dropped", Object.keys(ledger).length, 0);
}

store.clear(); agreeRate(URL_A, 0.02); agreeRate(URL_B, 0.02);
{
  const ledger = p.bank({}, [artist(URL_A, null)], { [URL_A]: 600 });
  is("an artist who takes no payment accrues nothing", Object.keys(ledger).length, 0);
}

store.clear(); agreeRate(URL_A, 0.02); agreeRate(URL_B, 0.02);
{
  // Dear, and never agreed to: the music plays, the meter does not run.
  const ledger = p.bank({}, [artist(URL_A, 0.09)], { [URL_A]: 600 });
  is("an unagreed rate accrues nothing", Object.keys(ledger).length, 0);
}

// ── when it goes ────────────────────────────────────────────────────────────

store.clear(); agreeRate(URL_A, 0.02); agreeRate(URL_B, 0.02);
{
  const entry = artist(URL_A, 0.01, 0.2);          // pays at 20 cents
  let ledger = p.bank({}, [entry], { [URL_A]: 600 });   // ten minutes, ten cents

  is("under the threshold it waits", p.owing(entry, ledger).due, false);
  is("  but it is still owed", p.owing(entry, ledger).usd, 0.1);
  is("  and the app can total it", p.totalOwed(ledger), 0.1);

  ledger = p.bank(ledger, [entry], { [URL_A]: 600 });   // twenty minutes, twenty cents
  is("at the threshold it goes", p.owing(entry, ledger).due, true);
  is("  because the threshold was reached", p.owing(entry, ledger).why, "threshold");
}

store.clear(); agreeRate(URL_A, 0.02); agreeRate(URL_B, 0.02);
{
  const entry = artist(URL_A, 0.01, 0.2);
  const ledger = p.bank({}, [entry], { [URL_A]: 60 });  // a cent, well under
  is("stopping settles what is left", p.owing(entry, ledger, { ending: true }).due, true);
  is("  however small", p.owing(entry, ledger, { ending: true }).usd, 0.01);
}

store.clear(); agreeRate(URL_A, 0.02); agreeRate(URL_B, 0.02);
{
  const entry = artist(URL_A, 0.01, 0.2);
  const ledger = p.bank({}, [entry], { [URL_A]: 60 });
  const later = Date.now() + 8 * 86400e3;
  is("an old debt settles on its own", p.owing(entry, ledger, { now: later }).due, true);
  is("  because of its age", p.owing(entry, ledger, { now: later }).why, "age");
}

store.clear();
is("nothing owed is nothing due", p.owing(artist(URL_A, 0.01), {}), null);
is("and an empty ledger totals nothing", p.totalOwed({}), 0);

// ── knowing whether there is a wallet, without loading the libraries ────────

store.clear();
is("no wallet on a fresh device", p.hasWallet(), false);
is("  and the payment libraries were not fetched to find out", p.loaded(), null);
store.set("amply.wallet.v1", "[1,2,3]");
is("a wallet is noticed", p.hasWallet(), true);
is("  still without loading them", p.loaded(), null);

// ── real money and play money must never be confused ────────────────────────
//
// A Solana address is valid on every network, so a payment sent to the wrong
// one succeeds: tokens move, and an artist expecting real money has been paid
// in something nobody can spend. Both ends would believe it worked.

store.clear();
walletOn("mainnet");
{
  const real = artist(URL_A, 0.01);                       // no network: real money
  const testing = artist(URL_B, 0.01, 0.2, "devnet");
  agreeRate(URL_A, 0.01); agreeRate(URL_B, 0.01);

  const ledger = p.bank({}, [real, testing], { [URL_A]: 60, [URL_B]: 60 });
  is("a manifest that says nothing means real money", ledger[URL_A].micros, toMicros(0.01));
  is("  and nothing accrues for an artist on the test network", ledger[URL_B], undefined);
  ok("  the listener is told why", /play money/.test(p.mismatch(rateOf(testing.manifest)) || ""));
}

store.clear();
walletOn("devnet");
{
  const real = artist(URL_A, 0.01);
  agreeRate(URL_A, 0.01);
  const ledger = p.bank({}, [real], { [URL_A]: 60 });
  is("a test wallet accrues nothing for an artist wanting real money", ledger[URL_A], undefined);
  ok("  and is told to switch", /Switch it to Solana/.test(p.mismatch(rateOf(real.manifest)) || ""));
}

// ── an artist who changes their mind after somebody has listened ────────────
//
// The debt is in the money it was earned in. Refusing to settle it on today's
// setting would strand a real debt for good.

store.clear();
walletOn("mainnet");
{
  const before = artist(URL_A, 0.01);
  agreeRate(URL_A, 0.01);
  let ledger = p.bank({}, [before], { [URL_A]: 60 });
  is("a minute is owed", ledger[URL_A].micros, toMicros(0.01));
  is("  recorded in the money it was earned in", ledger[URL_A].network, "mainnet");

  // The artist now switches to testing.
  const after = artist(URL_A, 0.01, 0.2, "devnet");
  ledger = p.bank(ledger, [after], { [URL_A]: 60 });
  is("no further debt accrues once they switch", ledger[URL_A].micros, toMicros(0.01));

  const owed = p.owing(after, ledger, { ending: true });
  ok("what was already earned is still due", owed.due && owed.micros === toMicros(0.01));
}

// And the wallet has to be where that money is.
store.clear();
walletOn("mainnet");
{
  agreeRate(URL_A, 0.01);
  const ledger = p.bank({}, [artist(URL_A, 0.01)], { [URL_A]: 60 });
  walletOn("devnet");
  const result = await p.settle(null, artist(URL_A, 0.01), ledger, { ending: true });
  is("a real debt is not sent from a test wallet", result.paid, null);
  ok("  and says how to fix it", /back to Solana/.test(result.refused || ""));
  is("  leaving the debt where it was", result.ledger[URL_A].micros, toMicros(0.01));
}

// ── which tracks the app identifies itself for ──────────────────────────────
//
// The same rule the artist's server enforces. If the app disagreed, a paid
// track would refuse to play, or a free one would be charged for.

{
  const { tracksOf } = await import("./src/manifest.js");
  const priced = artist(URL_A, 0.01);
  priced.manifest.releases = [{ id: "r", title: "R", tracks: [
    { id: "paid", title: "P", duration: 60, url: "https://a.test/audio/p.mp3" },
    { id: "gift", title: "G", duration: 60, url: "https://a.test/audio/g.mp3", free: true },
  ] }];
  const [paid, gift] = tracksOf(priced);
  is("a track from an artist who charges needs a wallet", paid.needsWallet, true);
  is("  one they made free does not", gift.needsWallet, false);

  const giving = artist(URL_B, null);
  giving.manifest.releases = priced.manifest.releases;
  is("nothing needs a wallet from an artist who doesn't charge",
    tracksOf(giving).some((t) => t.needsWallet), false);
}

// ── the backup key ──────────────────────────────────────────────────────────
{
  const A = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  const B = "9mPQrX6oJ8Yy4bA1cK2dE3fG4hJ5kL6mN7pQ8rS9tUvW";
  is("a new wallet's backup isn't saved", p.backupSaved(A), false);
  p.markBackupSaved(A);
  is("once saved, it's remembered", p.backupSaved(A), true);
  is("  for that wallet only — a different one starts unsaved", p.backupSaved(B), false);
  is("no wallet has nothing saved", p.backupSaved(undefined), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
