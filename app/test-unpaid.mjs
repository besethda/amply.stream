/**
 * An artist's server that won't serve this wallet until it's paid (their
 * Auto-block), and the app paying what that server says.
 *
 * The rules being checked: the server's refusal is read for what it is; what
 * it says is owed is paid at once, below the artist's usual amount and with
 * nothing on the device's ledger; in pieces a server will take; never twice,
 * whatever order things finish in; and never given up on, across a reload.
 * The payment itself is a stand-in here; test-fees.mjs sends real ones
 * through the node's own code.
 *
 * Run via `npm --prefix app run test` (bundled, for the sheet's JSX).
 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const p = await import("./src/paying.js");
const o = await import("./src/owes.js");
const id = await import("./src/identify.js");
const { agreeRate, recordSpend, spentToday } = await import("./src/spend.js");
const { LISTEN_MIN_MICROS, LISTEN_MAX_MICROS } = await import("../spec/pricing.mjs");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};
const is = (name, got, want) => ok(name, Object.is(got, want), `expected ${want}, got ${got}`);
const same = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

const URL_A = "https://a.test/manifest.json";
const ORIGIN_A = "https://a.test";
const artist = (url, perMinute = 0.01, settleAt = 1) => ({
  url, feesPaid: true,
  manifest: {
    artist: { name: "Ada" },
    payment: [{ type: "solana-usdc", address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", ratePerMinute: perMinute, settleAt }],
    releases: [],
  },
});
const A = artist(URL_A);
const pair = { publicKey: { toBase58: () => "me" }, secretKey: new Uint8Array(64).fill(7) };

// The payment libraries, stood in for: what was sent, and how it went.
const sent = [];
let failNext = null, slow = null, nodeConfirmed = true, landed = null;
p.useMachinery({
  pay: {
    async payArtist(_pair, _r, micros) {
      if (slow) await slow;
      if (failNext) { const f = failNext; failNext = null; const e = new Error(f.message || f.kind); e.kind = f.kind; e.signature = f.signature; throw e; }
      sent.push(micros);
      return { signature: `sig${sent.length}`, micros, nodeConfirmed };
    },
    async landedSince() { return landed; },
  },
  wallet: { bs58: () => "signed" },
});
const fresh = () => {
  store.clear(); sent.length = 0; failNext = null; slow = null; nodeConfirmed = true; landed = null;
  store.set("amply.network.v1", "mainnet");
};
const sum = (xs) => xs.reduce((n, x) => n + x, 0);

// ── reading the refusal ─────────────────────────────────────────────────────

same("an unpaid refusal is read for what's owed",
  o.unpaidRefusal(403, { error: "pay first", code: "unpaid", owes: 1_234_567 }), { owes: 1_234_567, error: "pay first" });
is("a plain block (the artist's own) is not an unpaid one", o.unpaidRefusal(403, { error: "this artist has stopped serving this wallet" }), null);
is("  nor any other status", o.unpaidRefusal(402, { code: "unpaid", owes: 5 }), null);
is("a fraction of a micro is nonsense, not a debt", o.unpaidRefusal(403, { code: "unpaid", owes: 1.5 }), null);
is("  and so is a negative one", o.unpaidRefusal(403, { code: "unpaid", owes: -1 }), null);
is("  and a string", o.unpaidRefusal(403, { code: "unpaid", owes: "100" })?.owes, 100);
is("  and an absurd one", o.unpaidRefusal(403, { code: "unpaid", owes: 5e12 }), null);

{
  // The real tokenFor, against a server that refuses with Auto-block.
  fresh();
  let answer = () => new Response(JSON.stringify({ error: "Ada is waiting to be paid.", code: "unpaid", owes: 420_000 }), { status: 403 });
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/listen/challenge") return new Response(JSON.stringify({ challenge: `amply:${u.host}:${Date.now()}:abc` }));
    if (u.pathname === "/listen/token") return answer();
    throw new Error(`unexpected ${url}`);
  };
  const e = await id.tokenFor(pair, ORIGIN_A).catch((x) => x);
  ok("tokenFor says the refusal is for being unpaid", e?.unpaid === true, e?.message);
  is("  with the server's number", e?.owes, 420_000);
  is("  and its words", e?.message, "Ada is waiting to be paid.");
  answer = () => new Response(JSON.stringify({ error: "this artist has stopped serving this wallet" }), { status: 403 });
  const plain = await id.tokenFor(pair, ORIGIN_A).catch((x) => x);
  ok("a manual block is still a plain refusal, with nothing to pay", plain instanceof Error && !plain.unpaid && /stopped serving/.test(plain.message));
}

// ── how it's sent ───────────────────────────────────────────────────────────

same("less than a cent is rounded up to a cent, not left blocking", o.pieces(3_000), [LISTEN_MIN_MICROS]);
same("one payment's worth is one payment", o.pieces(LISTEN_MAX_MICROS), [LISTEN_MAX_MICROS]);
same("just over is two even halves, never a crumb too small to send", o.pieces(2_005_000), [1_002_500, 1_002_500]);
{
  const big = o.pieces(7_000_001);
  ok("a big debt: no piece over the most, none under the least, nothing lost",
    big.every((m) => m <= LISTEN_MAX_MICROS && m >= LISTEN_MIN_MICROS) && sum(big) === 7_000_001 && big.length === 4, JSON.stringify(big));
}
same("nothing owed is nothing sent", o.pieces(0), []);

// ── paying the server's number ──────────────────────────────────────────────

{
  fresh(); agreeRate(URL_A, 0.01);
  o.noteClaim(URL_A, 50_000);
  const r = await p.settleClaim(pair, A);
  same("owed below the artist's $1 amount is paid now, not held back", sent, [50_000]);
  is("  and the claim says there's nothing left to send", o.claimOf(URL_A).remaining, 0);
  is("  so the next step is asking for a pass again", r.state, "paid");
}

{
  fresh(); agreeRate(URL_A, 0.01);
  o.noteClaim(URL_A, 300_000);
  await p.settleClaim(pair, A);
  same("an empty ledger (a new phone) pays the server's number", sent, [300_000]);

  fresh(); agreeRate(URL_A, 0.01);
  store.set("amply.owed.v2", JSON.stringify({ [URL_A]: { micros: 100_000, seconds: 600, since: Date.now(), network: "mainnet" } }));
  o.noteClaim(URL_A, 300_000);
  await p.settleClaim(pair, A);
  same("a ledger short of it still pays the server's number", sent, [300_000]);
  is("  and the ledger's part of it is settled too, not paid again later", p.loadLedger()[URL_A], undefined);
}

{
  fresh(); agreeRate(URL_A, 0.01);
  o.noteClaim(URL_A, 4_500_000);
  const r = await p.settleClaim(pair, A);
  same("over one payment's worth goes as several, in one go", sent, [1_500_000, 1_500_000, 1_500_000]);
  is("  all of it", r.state, "paid");
  is("  and counted against the day", spentToday(), 4_500_000);
}

{
  fresh();
  o.noteClaim(URL_A, 200_000);
  let r = await p.settleClaim(pair, A);
  ok("no price agreed on this device: nothing is sent on a server's word alone", sent.length === 0 && r.state === "ask" && r.why === "consent");
  r = await p.settleClaim(pair, A, { explicit: true });
  same("  the listener's tap on Pay sends it", sent, [200_000]);
}

{
  fresh(); agreeRate(URL_A, 0.01); recordSpend(9_900_000);
  o.noteClaim(URL_A, 500_000);
  let r = await p.settleClaim(pair, A);
  ok("past today's limit, it waits for the listener's OK", sent.length === 0 && r.state === "ask" && r.why === "daily");
  r = await p.settleClaim(pair, A, { explicit: true });
  same("  and their tap pays it, limit or not: a debt mustn't become unpayable", sent, [500_000]);
}

{
  fresh(); agreeRate(URL_A, 0.01);
  o.noteClaim(URL_A, 300_000);
  let r = await p.settleClaim(pair, A, { balanceMicros: 50_000 });
  same("not enough in the wallet: what it holds goes now", sent, [50_000]);
  is("  and the rest waits for money", r.state, "funds");
  is("  still owed", o.claimOf(URL_A).remaining, 250_000);
  sent.length = 0;
  r = await p.settleClaim(pair, A, { balanceMicros: 5_000 });
  ok("under a cent in the wallet: nothing sent, money needed", sent.length === 0 && r.state === "funds");
}

// ── paused (their fees account) is not the listener's problem ──────────────

{
  fresh(); agreeRate(URL_A, 0.01);
  o.noteClaim(URL_A, 300_000);
  failNext = { kind: "paused", message: "Ada can't take payments right now. Nothing was sent." };
  const e = await p.payClaim(pair, A).catch((x) => x);
  is("their fees account can't pay: the failure says so", e?.kind, "paused");
  is("  the claim is kept, marked paused", o.claimOf(URL_A)?.kind, "paused");
  ok("  and tried again later, not given up", o.claimOf(URL_A).next > Date.now());

  const { unpaidSheet } = await import("./src/sheets.jsx");
  const money = (usd) => `$${usd.toFixed(2)}`;
  const go = { pay: () => "pay", topUp: () => "topup", you: () => "you" };
  const paused = unpaidSheet({ name: "Ada", owes: 300_000, state: "paused" }, { money, go });
  ok("the paused sheet doesn't say the listener is blocked", !/paused your listening/.test(paused.title) && /can't take payments/.test(paused.title));
  ok("  says it isn't their doing, and that Amply keeps checking", /isn't anything you've done/.test(paused.body) && /keeps checking/.test(paused.body));
  ok("  and asks nothing of them", !paused.primary && paused.tone !== "warn");
  const unpaid = unpaidSheet({ name: "Ada", owes: 300_000, state: "ask" }, { money, go });
  is("the unpaid sheet says it plainly", unpaid.title, "Ada has paused your listening until you've paid $0.30");
  ok("  with Pay as the one thing to do", unpaid.primaryLabel === "Pay $0.30" && unpaid.primary() === "pay");
  const broke = unpaidSheet({ name: "Ada", owes: 300_000, state: "funds" }, { money, go });
  ok("short of money: the way to add some", broke.primaryLabel === "Add money" && broke.primary() === "topup");
}

// ── trying again, kept across a reload ──────────────────────────────────────

{
  fresh(); agreeRate(URL_A, 0.01);
  const t0 = Date.now();
  o.noteClaim(URL_A, 300_000, t0);
  ok("a new claim is due at once", o.claimDue(o.claimOf(URL_A), t0));
  failNext = { kind: "network", message: "Couldn't reach the network" };
  await p.payClaim(pair, A, { now: () => t0 }).catch(() => {});
  // A reload: everything in memory is gone, only storage is left.
  const kept = JSON.parse(store.get("amply.nodeowes.v1"))[URL_A];
  ok("a failed try is backed off, in storage", kept.tries === 1 && kept.next === t0 + o.BACKOFF_MS[0] && kept.kind === "network");
  let r = await p.settleAll(pair, [A], p.loadLedger(), { now: t0 + 1_000 });
  ok("  so after a reload it isn't hammered", sent.length === 0 && r.claimed.length === 0 && r.failed.length === 0);
  failNext = { kind: "network" };
  await p.settleAll(pair, [A], p.loadLedger(), { now: t0 + o.BACKOFF_MS[0] + 1 });
  is("  but is tried when its time comes, waiting longer after each failure", o.claimOf(URL_A).tries, 2);
  ok("  never more than an hour apart", o.backoffFor(50) === 60 * 60_000);
  is("  and never forgotten", !!o.claimOf(URL_A), true);
  o.wakeClaims(["funds"]);
  ok("money arriving wakes only what was waiting for money", o.claimOf(URL_A).next > Date.now());
  o.wakeClaims();
  ok("the network coming back wakes everything", o.claimDue(o.claimOf(URL_A)));
  r = await p.settleAll(pair, [A], p.loadLedger());
  same("  and pays it", sent, [300_000]);
}

{
  // A claim waiting out its back-off isn't paid from the ledger instead.
  fresh(); agreeRate(URL_A, 0.01);
  store.set("amply.owed.v2", JSON.stringify({ [URL_A]: { micros: 2_000_000, seconds: 60, since: Date.now(), network: "mainnet" } }));
  o.noteClaim(URL_A, 2_500_000);
  o.backOff(URL_A, "network");
  await p.settleAll(pair, [A], p.loadLedger());
  ok("a claim backing off: the ledger isn't paid separately meanwhile", sent.length === 0);
}

// ── after paying: a pass, or what's still owed ──────────────────────────────

{
  fresh(); agreeRate(URL_A, 0.01);
  o.noteClaim(URL_A, 300_000);
  let asked = 0;
  const r = await p.payClaim(pair, A, { token: async () => { asked++; return "pass"; } });
  ok("paid, then a pass: the claim is forgotten", r.state === "clear" && asked === 1 && o.claimOf(URL_A) === null);
}

{
  fresh(); agreeRate(URL_A, 0.01);
  o.noteClaim(URL_A, 300_000);
  const token = async () => { const e = new Error("still"); e.unpaid = true; e.owes = 40_000; throw e; };
  const r = await p.payClaim(pair, A, { token });
  ok("still refused with more owed: noted, not paid again on the spot", r.state === "owes" && sent.length === 1 && o.claimOf(URL_A).remaining === 40_000);
  ok("  it's paid at the next try instead", o.claimOf(URL_A).next > Date.now());
}

// ── never twice ─────────────────────────────────────────────────────────────

{
  fresh(); agreeRate(URL_A, 0.01);
  o.noteClaim(URL_A, 300_000);
  let release;
  slow = new Promise((r) => { release = r; });
  const first = p.exclusive(() => p.settleAll(pair, [A], p.loadLedger()));
  const second = await p.exclusive(() => p.settleAll(pair, [A], p.loadLedger()));
  const tap = await p.exclusive(() => p.payClaim(pair, A, { explicit: true }));
  release(); slow = null;
  await first;
  ok("while one payment is under way, a second (or the Pay button) waits its turn", second === null && tap === null);
  same("  so the debt is sent once", sent, [300_000]);
}

{
  fresh(); agreeRate(URL_A, 0.01);
  o.noteClaim(URL_A, 300_000);
  failNext = { kind: "unconfirmed", signature: "maybe" };
  await p.payClaim(pair, A).catch(() => {});
  ok("a payment that may have gone out is remembered", p.unsureOf(URL_A)?.signature === "maybe");
  o.wakeClaims();
  store.set("amply.unsure.v1", JSON.stringify({ [URL_A]: { ...p.unsureOf(URL_A), looked: 0 } }));
  landed = null;
  let r = await p.settleClaim(pair, A);
  ok("  until the network says, nothing more is sent", sent.length === 0 && r.state === "unsure");
  store.set("amply.unsure.v1", JSON.stringify({ [URL_A]: { ...p.unsureOf(URL_A), looked: 0 } }));
  landed = 300_000;
  const told = [];
  r = await p.settleClaim(pair, A, { report: async (origin, sig) => { told.push([origin, sig]); return true; } });
  ok("  it landed: not sent again, and the claim is paid", sent.length === 0 && r.state === "paid" && o.claimOf(URL_A).remaining === 0);
  same("  and its server is told", told, [[ORIGIN_A, "maybe"]]);
}

// ── telling the server, once ────────────────────────────────────────────────

{
  fresh(); agreeRate(URL_A, 0.01);
  o.noteClaim(URL_A, 300_000);
  nodeConfirmed = false;
  const told = [];
  await p.settleClaim(pair, A, { report: async (origin, sig) => { told.push(sig); return false; } });
  same("a payment its server hadn't seen land is reported to it", told, ["sig1"]);
  // The server's next refusal still counts it: the app waits, it doesn't pay it again.
  o.noteClaim(URL_A, 300_000);
  is("  and its next refusal, still counting it, owes nothing more", o.claimOf(URL_A).remaining, 0);
  const r = await p.settleClaim(pair, A);
  ok("  so nothing is sent while it catches up", sent.length === 1 && r.state === "counting");
  o.dropCredit("sig1");
  o.noteClaim(URL_A, 60_000);
  is("once it has it, what's still owed is what it says", o.claimOf(URL_A).remaining, 60_000);

  // The real reportPaid: once per signature, whatever the answer.
  const posts = [];
  let status = 200;
  globalThis.fetch = async (url, init) => { posts.push([url, init.body]); return new Response("{}", { status }); };
  o.noteCredit(URL_A, "sigX", 10_000);
  is("reportPaid tells the server", await id.reportPaid(ORIGIN_A, "sigX"), true);
  same("  at /listen/paid, with the signature", posts, [[`${ORIGIN_A}/listen/paid`, JSON.stringify({ signature: "sigX" })]]);
  is("  which then takes it off what's held back", o.pendingCredit(URL_A), 0);
  await id.reportPaid(ORIGIN_A, "sigX");
  is("  and only once", posts.length, 1);
  status = 429;
  await id.reportPaid(ORIGIN_A, "sigY"); await id.reportPaid(ORIGIN_A, "sigY");
  is("a refusal isn't asked again either", posts.length, 2);
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await id.reportPaid(ORIGIN_A, "sigZ");
  globalThis.fetch = async (url, init) => { posts.push([url, init.body]); return new Response("{}"); };
  await id.reportPaid(ORIGIN_A, "sigZ");
  is("one that never arrived is sent when it can be", posts.length, 3);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
