/**
 * Subscriptions through the artist's own Stripe account.
 *
 * The endpoint Stripe posts to is public — it has to be — so everything rests
 * on the signature. Each case here is either something Stripe really sends or
 * something an attacker would try: forging a notice, replaying an old one, or
 * pointing a subscription at somebody else's wallet.
 *
 *   npm run test:stripe
 */
import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import { SCHEMA, putSetting, subscribedUntil, subscriptionOf, forget, remove, counted, pruneSubscriptions } from "./src/store.ts";
import { verifySignature, handleEvent, formEncode, periodEnd, publicView, disconnect, connectionOf, explain, connect, claim, refresh } from "./src/stripe.ts";

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

const SECRET = "whsec_test_secret";
const NOW = 1_800_000_000_000;
const T = Math.floor(NOW / 1000);
const sign = (raw, secret = SECRET, t = T) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;

await putSetting(DB, "stripe", JSON.stringify({
  key: "sk_test_secret_key", live: false, product: "prod_1", webhook: "we_1", webhookSecret: SECRET,
  portal: "bpc_1", plans: [{ months: 12, price: 10, currency: "usd", priceId: "price_1", linkId: "plink_1", url: "https://buy.stripe.com/test_1" }],
}));

const WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const YEAR_ON = T + 365 * 86400;
const OURS = { metadata: { amply: "1", months: "12" } };
const fetchSubscription = async () => ({ id: "sub_1", status: "active", items: { data: [{ current_period_end: YEAR_ON, price: OURS }] } });

// ── the signature ───────────────────────────────────────────────────────────

const raw = JSON.stringify({ type: "ping" });
ok("Stripe's own signature is accepted", await verifySignature(raw, sign(raw), SECRET, T));
ok("a signature made with another secret is refused", !(await verifySignature(raw, sign(raw, "whsec_other"), SECRET, T)));
ok("a body changed after signing is refused", !(await verifySignature(raw + " ", sign(raw), SECRET, T)));
ok("a notice signed an hour ago is refused — a replay", !(await verifySignature(raw, sign(raw, SECRET, T - 3600), SECRET, T)));
ok("no signature at all is refused", !(await verifySignature(raw, null, SECRET, T)));
ok("several signatures, one of them right, is accepted (Stripe does this while rolling secrets)",
  await verifySignature(raw, `${sign(raw)},v1=${"0".repeat(64)}`, SECRET, T));

// ── a listener subscribes ───────────────────────────────────────────────────

const completed = (overrides = {}) => JSON.stringify({
  type: "checkout.session.completed",
  data: { object: { mode: "subscription", subscription: "sub_1", customer: "cus_1", client_reference_id: WALLET, ...overrides } },
});

{
  const body = completed();
  const outcome = await handleEvent(DB, body, sign(body), { fetchSubscription, now: NOW });
  ok("a completed checkout records the subscription", outcome === "recorded", outcome);
  ok("  against the wallet that was on the link", (await subscribedUntil(DB, WALLET)) === YEAR_ON * 1000);
  const row = await subscriptionOf(DB, WALLET);
  ok("  keeping only ids and a date — no name, no email", row && Object.keys(row).sort().join() === "customer,subscription,until,updated,wallet");
}

{
  const body = completed();
  ok("the same notice unsigned does nothing", (await handleEvent(DB, body, null, { fetchSubscription, now: NOW })) === "refused");
  const forged = completed({ client_reference_id: "11111111111111111111111111111112" });
  ok("a forged one pointing at another wallet is refused", (await handleEvent(DB, forged, sign(forged, "whsec_guess"), { fetchSubscription, now: NOW })) === "refused");
}

{
  const body = completed({ client_reference_id: null });
  ok("a checkout with no wallet on it is acknowledged and ignored", (await handleEvent(DB, body, sign(body), { fetchSubscription, now: NOW })) === "ignored");
  const junk = completed({ client_reference_id: "not-a-wallet" });
  ok("  and so is one with something that isn't a wallet", (await handleEvent(DB, junk, sign(junk), { fetchSubscription, now: NOW })) === "ignored");
  const oneOff = completed({ mode: "payment" });
  ok("a one-off payment isn't a subscription", (await handleEvent(DB, oneOff, sign(oneOff), { fetchSubscription, now: NOW })) === "ignored");
}

// ── renewals, cancellations and endings ─────────────────────────────────────

const updated = (object, type = "customer.subscription.updated") => JSON.stringify({ type, data: { object: { id: "sub_1", ...object } } });

{
  const TWO_YEARS = YEAR_ON + 365 * 86400;
  const body = updated({ status: "active", current_period_end: TWO_YEARS });
  ok("a renewal extends it", (await handleEvent(DB, body, sign(body), { now: NOW })) === "updated"
    && (await subscribedUntil(DB, WALLET)) === TWO_YEARS * 1000);
}

{
  const body = updated({ status: "active", cancel_at_period_end: true, items: { data: [{ current_period_end: YEAR_ON }] } });
  await handleEvent(DB, body, sign(body), { now: NOW });
  ok("cancelled to end with the period: paid up until then", (await subscribedUntil(DB, WALLET)) === YEAR_ON * 1000);
}

{
  const body = updated({ status: "past_due", current_period_end: YEAR_ON });
  await handleEvent(DB, body, sign(body), { now: NOW });
  ok("a failed card payment keeps them until the period ends, as Stripe does", (await subscribedUntil(DB, WALLET)) === YEAR_ON * 1000);
}

{
  const body = updated({ status: "canceled", ended_at: T }, "customer.subscription.deleted");
  await handleEvent(DB, body, sign(body), { now: NOW });
  ok("ended outright: over from when Stripe says", (await subscribedUntil(DB, WALLET)) === T * 1000);
}

// ── what survives a listener's erasure, and an artist's delete ──────────────

{
  const body = completed();
  await handleEvent(DB, body, sign(body), { fetchSubscription, now: NOW });
  await counted(DB, WALLET, 120, NOW);
  await forget(DB, WALLET);
  ok("asking to be forgotten keeps the subscription they paid for", (await subscribedUntil(DB, WALLET)) === YEAR_ON * 1000);
  await remove(DB, WALLET);
  ok("an artist deleting the record takes the subscription with it", (await subscribedUntil(DB, WALLET)) === null);
}

{
  const body = completed();
  await handleEvent(DB, body, sign(body), { fetchSubscription, now: NOW });
  await pruneSubscriptions(DB, YEAR_ON * 1000 + 400 * 86400_000);
  ok("a subscription that ended over a year ago is deleted", (await subscribedUntil(DB, WALLET)) === null);
}

// ── only what this server sells, and only once paid ─────────────────────────

{
  const other = "9mPQrX6oJ8Yy4bA1cK2dE3fG4hJ5kL6mN7pQ8rS9tUvW";
  const body = completed({ client_reference_id: other, subscription: "sub_merch" });
  const merch = async () => ({ id: "sub_merch", status: "active",
    items: { data: [{ current_period_end: YEAR_ON, price: { metadata: {} } }] } });
  ok("a subscription to something else the artist sells unlocks nothing",
    (await handleEvent(DB, body, sign(body), { fetchSubscription: merch, now: NOW })) === "ignored"
    && (await subscribedUntil(DB, other)) === null);
  const unpaid = async () => ({ id: "sub_merch", status: "incomplete",
    items: { data: [{ current_period_end: YEAR_ON, price: OURS }] } });
  ok("one whose first payment hasn't gone through unlocks nothing",
    (await handleEvent(DB, body, sign(body), { fetchSubscription: unpaid, now: NOW })) === "ignored"
    && (await subscribedUntil(DB, other)) === null);
}

// ── stopping ────────────────────────────────────────────────────────────────

{
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => { calls.push(`${init.method || "GET"} ${url}`); return new Response("{}"); };

  const body = completed();
  await handleEvent(DB, body, sign(body), { fetchSubscription, now: NOW });
  await disconnect(DB, NOW);
  ok("stopping switches the payment links off", calls.some((c) => c.includes("/payment_links/plink_1")));
  ok("  but keeps listening while someone is still subscribed",
    !calls.some((c) => c.startsWith("DELETE")) && (await connectionOf(DB))?.webhookSecret === SECRET);
  ok("  and says so to the editor, without the key", (await publicView(DB)).winding === true
    && !JSON.stringify(await publicView(DB)).includes("sk_test"));
  const renewed = JSON.stringify({ type: "customer.subscription.updated",
    data: { object: { id: "sub_1", status: "active", current_period_end: YEAR_ON + 365 * 86400 } } });
  await handleEvent(DB, renewed, sign(renewed), { now: NOW });
  ok("  so a renewal after stopping still counts", (await subscribedUntil(DB, WALLET)) === (YEAR_ON + 365 * 86400) * 1000);
  const ended = JSON.stringify({ type: "customer.subscription.deleted", data: { object: { id: "sub_1", status: "canceled", ended_at: T } } });
  await handleEvent(DB, ended, sign(ended), { now: NOW });
  ok("once the last one ends, the webhook is removed and the key forgotten",
    calls.some((c) => c.startsWith("DELETE") && c.includes("/webhook_endpoints/we_1")) && (await connectionOf(DB)) === null);

  globalThis.fetch = realFetch;
}

// ── helping an artist connect ───────────────────────────────────────────────

ok("a missing permission is named as Stripe's key screen names it",
  explain("The provided key 'rk_test_abc' does not have the required permissions for this endpoint on account 'acct_1'. Having the 'rak_plan_write' permission would allow this request to continue.")
    .includes("Prices — Write"));
ok("  and so is a webhook one", explain("... Having the 'rak_webhook_write' permission would ...").includes("Webhook Endpoints"));
ok("a wrong key says to copy it again", explain("Invalid API Key provided: rk_test_***", 401).includes("Copy it again"));
ok("anything else is passed on", explain("Something odd").startsWith("Stripe said:"));

{
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const line = `${init.method || "GET"} ${url}`;
    calls.push(line);
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
    if (line.includes("/checkout/sessions")) {
      return json({ error: { message: "Having the 'rak_checkout_session_read' permission would allow this request to continue." } }, 403);
    }
    if (line.includes("/products") && init.method === "POST") return json({ id: "prod_new" });
    if (line.includes("/prices")) return json({ id: "price_new" });
    if (line.includes("/payment_links") && init.method === "POST" && !line.includes("plink_")) return json({ id: "plink_new", url: "https://buy.stripe.com/x" });
    return json({ data: [] });
  };
  let said = "";
  try {
    await connect(DB, { key: "rk_test_abc", plans: [{ months: 12, price: 10 }], origin: "https://a.workers.dev", artist: "A", returnTo: "https://amply.stream/app/" });
  } catch (e) { said = e.message; }
  ok("connecting without checkout permission fails with the row to fix", said.includes("Checkout Sessions — Read"), said);
  ok("  and never asks for a webhook", !calls.some((c) => c.includes("/webhook_endpoints")));
  ok("  and switches off the checkout link it had already made", calls.some((c) => c.startsWith("POST") && c.includes("/payment_links/plink_new")));
  ok("  and archives the product", calls.some((c) => c.startsWith("POST") && c.includes("/products/prod_new")));
  ok("  and stores nothing", (await publicView(DB)).plans?.[0]?.url !== "https://buy.stripe.com/x");
  globalThis.fetch = realFetch;
}

// ── claiming a checkout, and checking it later ──────────────────────────────
{
  await putSetting(DB, "stripe", JSON.stringify({
    key: "rk_test_key", live: false, product: "prod_1", portal: "bpc_1",
    plans: [{ months: 12, price: 10, currency: "usd", priceId: "price_1", linkId: "plink_1", url: "https://buy.stripe.com/test_1" }],
  }));
  const FAN = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  const THIEF = "9mPQrX6oJ8Yy4bA1cK2dE3fG4hJ5kL6mN7pQ8rS9tUvW";
  const CS = "cs_test_a1B2c3D4e5F6g7H8";
  const session = (o = {}) => async () => ({ id: CS, mode: "subscription", status: "complete", subscription: "sub_9",
    customer: "cus_9", client_reference_id: FAN, ...o });
  const sub = (o = {}) => async () => ({ id: "sub_9", status: "active", customer: "cus_9",
    items: { data: [{ current_period_end: YEAR_ON, price: OURS }] }, ...o });

  ok("a checkout paid for this wallet is claimed",
    (await claim(DB, FAN, CS, { loadSession: session(), loadSubscription: sub(), now: NOW })) === "recorded"
    && (await subscribedUntil(DB, FAN)) === YEAR_ON * 1000);
  ok("someone else's checkout id is refused — it names another wallet",
    (await claim(DB, THIEF, CS, { loadSession: session(), loadSubscription: sub(), now: NOW })) === "refused"
    && (await subscribedUntil(DB, THIEF)) === null);
  ok("something that isn't a checkout id is refused without asking Stripe",
    (await claim(DB, FAN, "cs_test_x'; DROP", { loadSession: async () => { throw new Error("asked"); }, now: NOW })) === "refused");
  ok("a checkout not finished yet is pending",
    (await claim(DB, THIEF, CS, { loadSession: session({ client_reference_id: THIEF, status: "open" }), loadSubscription: sub(), now: NOW })) === "pending");
  ok("a checkout for something else the artist sells is refused",
    (await claim(DB, THIEF, CS, { loadSession: session({ client_reference_id: THIEF }),
      loadSubscription: sub({ items: { data: [{ current_period_end: YEAR_ON, price: { metadata: {} } }] } }), now: NOW })) === "refused");
  ok("a one-off payment isn't a subscription",
    (await claim(DB, FAN, CS, { loadSession: session({ mode: "payment" }), now: NOW })) === "refused");

  let asked = 0;
  const counting = (o) => async () => { asked++; return sub(o)(); };
  await refresh(DB, FAN, { loadSubscription: counting(), now: NOW + 3600e3 });
  ok("within a day, Stripe isn't asked again", asked === 0);
  const TWO = YEAR_ON + 365 * 86400;
  await refresh(DB, FAN, { loadSubscription: counting({ status: "canceled", ended_at: T + 86400 * 2 }), now: NOW + 2 * 86400e3 });
  ok("after a day it is — and a cancellation the artist made is found", asked === 1 && (await subscribedUntil(DB, FAN)) === (T + 86400 * 2) * 1000);
  await refresh(DB, FAN, { loadSubscription: counting(), now: NOW + 30 * 86400e3 });
  ok("an ended subscription isn't asked about again", asked === 1);

  await claim(DB, FAN, CS, { loadSession: session(), loadSubscription: sub(), now: NOW });
  await refresh(DB, FAN, { loadSubscription: counting({ items: { data: [{ current_period_end: TWO, price: OURS }] } }), now: YEAR_ON * 1000 + 1000 });
  ok("the moment a paid year runs out, a renewal is found with no gap", asked === 2 && (await subscribedUntil(DB, FAN)) === TWO * 1000);
  await refresh(DB, FAN, { loadSubscription: async () => { throw new Error("Stripe down"); }, now: TWO * 1000 + 1000 });
  ok("if Stripe doesn't answer, what was known stands", (await subscribedUntil(DB, FAN)) === TWO * 1000);
  {
    const realFetch = globalThis.fetch;
    const LATE = "5ZWj7a1f8tWkjBESHKgrLmXshuJxqeY9SYcfbshpAqPG";
    globalThis.fetch = async (url) => {
      const u = String(url);
      const json = (o) => new Response(JSON.stringify(o));
      if (u.includes("/checkout/sessions?")) return json({ data: [
        { id: "cs_test_other", mode: "subscription", status: "complete", subscription: "sub_x", client_reference_id: THIEF },
        { id: "cs_test_late0000000", mode: "subscription", status: "complete", subscription: "sub_late", customer: "cus_l", client_reference_id: LATE },
      ] });
      if (u.includes("/subscriptions/sub_late")) return json({ id: "sub_late", status: "active", items: { data: [{ current_period_end: YEAR_ON, price: OURS }] } });
      return json({});
    };
    ok("a fan who paid but never made it back is found without a checkout id",
      (await claim(DB, LATE, "", { now: NOW })) === "recorded" && (await subscribedUntil(DB, LATE)) === YEAR_ON * 1000);
    ok("  and a wallet with no payment finds nothing", (await claim(DB, "3yZe7d7GsbeFvvLkeJH9Tus8QEzQqvxG6bXkRkNiEVkH", "", { now: NOW })) === "refused");
    globalThis.fetch = realFetch;
  }
  ok("a new connection keeps no webhook secret", !JSON.stringify(await connectionOf(DB)).includes("whsec"));
  const body = completed();
  ok("  so an unsigned or old-style notice is refused outright", (await handleEvent(DB, body, sign(body), { fetchSubscription, now: NOW })) === "refused");
}

// ── small parts ─────────────────────────────────────────────────────────────

ok("Stripe's nested form encoding",
  decodeURIComponent(formEncode({ recurring: { interval: "month", interval_count: 12 }, line_items: [{ price: "p", quantity: 1 }], enabled_events: ["a", "b"] }))
  === "recurring[interval]=month&recurring[interval_count]=12&line_items[0][price]=p&line_items[0][quantity]=1&enabled_events[]=a&enabled_events[]=b");
ok("the period end is found wherever Stripe's API version puts it",
  periodEnd({ current_period_end: 5 }) === 5000 && periodEnd({ items: { data: [{ current_period_end: 6 }] } }) === 6000);

{
  await putSetting(DB, "stripe", JSON.stringify({
    key: "sk_test_secret_key", live: false, product: "prod_1", webhook: "we_1", webhookSecret: SECRET,
    portal: "bpc_1", plans: [{ months: 12, price: 10, currency: "usd", priceId: "price_1", linkId: "plink_1", url: "https://buy.stripe.com/test_1" }],
  }));
  const view = await publicView(DB);
  const text = JSON.stringify(view);
  ok("the editor's view of the connection never includes the key", !text.includes("sk_test") && !text.includes("whsec"), text);
  ok("  but does include what is sold", view.plans?.[0]?.url === "https://buy.stripe.com/test_1");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
