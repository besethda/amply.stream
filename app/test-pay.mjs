/**
 * Dividing and timing a payment.
 *
 * Nothing here touches the network. What it checks is the arithmetic that
 * decides who gets how much, because a rounding error here is somebody's money
 * going missing, and a threshold error is an artist being paid late or a
 * listener being asked to approve a payment every three minutes.
 *
 * Run via `npm --prefix app run test`.
 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { shareOut, dueNow, toMicros, MICROS, SETTLE_AFTER_DAYS } = await import("./src/pay.js");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};
const is = (name, got, want) => ok(name, Object.is(got, want), `expected ${want}, got ${got}`);

const sum = (shares) => shares.reduce((n, s) => n + s.micros, 0);
const two = [{ address: "A", split: 60 }, { address: "B", split: 40 }];
const thirds = [{ address: "A", split: 33.34 }, { address: "B", split: 33.33 }, { address: "C", split: 33.33 }];

// The plain cases.
is("one payee takes all of it", shareOut(200000, [{ address: "A", split: 100 }])[0].micros, 200000);
is("60/40 of 20 cents, the larger share", shareOut(200000, two)[0].micros, 120000);
is("  and the smaller", shareOut(200000, two)[1].micros, 80000);
is("nothing to divide", shareOut(0, two).length, 0);
is("nobody to divide it between", shareOut(200000, []).length, 0);

// The rule that matters: every micro is accounted for, always.
let worst = null;
for (let micros = 1; micros <= 2000 && !worst; micros++) {
  for (const set of [two, thirds, [{ address: "A", split: 50 }, { address: "B", split: 50 }]]) {
    if (sum(shareOut(micros, set)) !== micros) worst = `${micros} micros across ${set.length}`;
  }
}
ok("no micro is ever lost or invented, at any amount", !worst, worst);

// Thirds are the case a naive split gets wrong.
const penny = shareOut(10000, thirds);          // one cent, three ways
is("a cent in thirds still adds to a cent", sum(penny), 10000);
ok("  and the extra micros go to the largest shares, not nobody",
  penny[0].micros >= penny[1].micros && penny[1].micros >= penny[2].micros);

// Dust: less money than there are people to divide it between.
const dust = shareOut(2, thirds);
is("two micros between three people still sends two", sum(dust), 2);
is("  paying only the people whose share rounds to something", dust.length, 2);

// The same payment must always divide the same way.
is("dividing is repeatable", JSON.stringify(shareOut(12345, thirds)), JSON.stringify(shareOut(12345, thirds)));

// ── when a payment is due ───────────────────────────────────────────────────

const rate = { perMinute: 0.01, settleAt: 0.2 };     // a cent a minute, every 5 songs
const minutes = (n) => n * 60;

is("nothing owed, nothing due", dueNow(0, rate), null);
is("free music is never due", dueNow(minutes(100), { perMinute: 0, settleAt: 0.2 }), null);
is("no payment method, nothing due", dueNow(minutes(100), null), null);
is("under the artist's threshold, it waits", dueNow(minutes(10), rate), null);
ok("at the threshold, it goes", dueNow(minutes(20), rate)?.micros === toMicros(0.2));
is("  because the threshold was reached", dueNow(minutes(20), rate).why, "threshold");

// The two exceptions the spec requires, so a listener who stops early still pays.
const small = minutes(4);                            // 4 cents, under the 20 cent threshold
is("a session ending settles what is left", dueNow(small, rate, { ending: true }).why, "session");
is("  for exactly what was listened to", dueNow(small, rate, { ending: true }).micros, toMicros(0.04));
const old = Date.now() - (SETTLE_AFTER_DAYS + 1) * 86400e3;
is("an old debt settles on its own", dueNow(small, rate, { since: old }).why, "age");
is("  but a recent one waits", dueNow(small, rate, { since: Date.now() - 86400e3 }), null);

// Fractions of a cent must not vanish or round up into money nobody owes.
is("a few seconds is a fraction of a cent, and waits", dueNow(6, rate), null);
is("  and is still exact when it does settle", dueNow(6, rate, { ending: true }).micros, 1000);
is("less than a micro owes nothing at all", dueNow(0.001, rate, { ending: true }), null);

// What the artist charges is what is charged: 4 minutes at a cent a minute.
is("four minutes at a cent a minute is four cents", dueNow(minutes(4), rate, { ending: true }).usd, 0.04);
is("and a hundred minutes is a dollar", dueNow(minutes(100), rate).micros, MICROS);

// ── a purchase's payment carries a note saying what it bought ───────────────
// The artist's server only accepts a USDC purchase whose transaction names
// it, so an old tip can't pass for one. Caught just before it would be sent.
{
  const { payArtist, MEMO_PROGRAM } = await import("./src/pay.js");
  const { Keypair, Connection } = await import("@solana/web3.js");
  let sent = null;
  const real = Connection.prototype.sendTransaction;
  Connection.prototype.sendTransaction = async (tx) => { sent = tx; throw new Error("stop here"); };
  const pair = Keypair.generate();
  const artist = Keypair.generate().publicKey.toBase58();
  await payArtist(pair, [{ address: artist, split: 100 }], 8_000_000, { artistName: "A", memo: "amply:buy:shop.example:tides" }).catch(() => {});
  const memo = sent?.instructions.find((ix) => ix.programId.toBase58() === MEMO_PROGRAM);
  ok("a purchase's transaction carries its note", memo && Buffer.from(memo.data).toString("utf8") === "amply:buy:shop.example:tides",
    sent ? sent.instructions.map((i) => i.programId.toBase58()).join(",") : "nothing sent");
  ok("  signed by the buyer", memo?.keys[0]?.pubkey.toBase58() === pair.publicKey.toBase58() && memo.keys[0].isSigner);
  sent = null;
  await payArtist(pair, [{ address: artist, split: 100 }], 1_000_000, { artistName: "A" }).catch(() => {});
  ok("a tip carries none", sent && !sent.instructions.some((ix) => ix.programId.toBase58() === MEMO_PROGRAM));
  Connection.prototype.sendTransaction = real;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
