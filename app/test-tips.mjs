/**
 * Tips: who can be tipped and how, and what stops a tip going.
 *
 * Run via `npm --prefix app run test`.
 */
const { tipsFor, tipBlocked, tipMicros, amplyTips, MAX_TIP, TIP_AMOUNTS } = await import("./src/tips.js");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

const band = {
  artist: { name: "The Band" },
  payment: [
    { type: "solana-usdc", ratePerMinute: 0.01, recipients: [
      { name: "Ann", address: "AnnAddress1111111111111111111111111111111111", split: 60 },
      { name: "Bo", address: "BoAddress11111111111111111111111111111111111", split: 40 },
    ] },
    { type: "link", label: "Ko-fi", url: "https://ko-fi.com/theband" },
    { type: "link", label: "Sketchy", url: "http://example.com" },
  ],
};
const t = tipsFor(band);
ok("an artist with a wallet can be tipped from the listener's wallet", t.wallet?.recipients.length === 2);
ok("  split between the same people as their listening payments", t.wallet.recipients.map((r) => r.split).join() === "60,40");
ok("  and their tip links are offered too (https only)", t.links.length === 1 && t.links[0].label === "Ko-fi", JSON.stringify(t.links));

const linksOnly = tipsFor({ artist: { name: "Links" }, payment: [{ type: "link", label: "Bandcamp", url: "https://x.bandcamp.com" }] });
ok("an artist with only a tip link: the link, no wallet tip", !linksOnly.wallet && linksOnly.links.length === 1);
const nothing = tipsFor({ artist: { name: "None" }, payment: [] });
ok("an artist with neither: nothing to offer", !nothing.wallet && !nothing.links.length);

// What stops a tip.
const ready = { hasWallet: true, balance: { usdc: 10, sol: 0.01 }, mismatch: null };
ok("with a wallet, money and fee: nothing stops it", tipBlocked(3, ready) === null);
ok("no wallet: set one up first", tipBlocked(3, { ...ready, hasWallet: false }) === "nowallet");
ok("wallet on the wrong network: says so", tipBlocked(3, { ...ready, mismatch: "wrong" }) === "mismatch");
ok("not enough money: top up", tipBlocked(3, { ...ready, balance: { usdc: 2, sol: 0.01 } }) === "empty");
ok("no SOL for the fee: add some", tipBlocked(3, { ...ready, balance: { usdc: 10, sol: 0 } }) === "nosol");
ok("balance not known yet: not refused for that", tipBlocked(3, { ...ready, balance: null }) === null);
ok("nothing, or more than the most a tip can be: refused", tipBlocked(0, ready) === "amount" && tipBlocked(MAX_TIP + 1, ready) === "amount");

ok("amounts offered are small, and in dollars", TIP_AMOUNTS.every((d) => d > 0 && d <= 10));
ok("$3 is 3,000,000 micros", tipMicros(3) === 3_000_000);
ok("Amply isn't offered until it has an address", amplyTips() === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
