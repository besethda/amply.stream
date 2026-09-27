/**
 * Card subscriptions, through the artist's own Stripe account.
 *
 * The artist is the seller and Stripe holds the money; Amply is neither. The
 * artist pastes a Stripe key into their editor, it is kept here on their own
 * server and nowhere else, and this server uses it to set up what they sell
 * and to ask who has paid. A listener pays on Stripe's page, carrying their
 * wallet address as Stripe's `client_reference_id`; Stripe sends them back
 * with the checkout's id, their app hands that to this server, and this
 * server asks Stripe about it.
 *
 * Asking, not being told. It used to be told, by webhook — but Stripe won't
 * let an app ask for webhook permission, and Amply's Stripe App is what lets
 * an artist make the key in one click. Asking needs no webhook, no secret to
 * keep, and only read permission.
 *
 * Three rules this file keeps:
 *   - a checkout counts only for the wallet it was paid for, proven by that
 *     wallet's signature, and only for a plan this server made;
 *   - the key never leaves this server — no route returns it;
 *   - nothing personal is copied from Stripe: a wallet, two ids and a date.
 */
import { fromBase58 } from "./identity";
import { setting, putSetting, recordSubscription, updateSubscription, subscriptionOf } from "./store";

const API = "https://api.stripe.com/v1";
const STRIPE_KEY = "stripe";      // the settings row holding the connection
const TOLERANCE = 5 * 60;         // seconds a signed notice stays acceptable
const MAX_EVENT = 256 * 1024;     // Stripe's notices are a few kilobytes

export interface Plan { months: number; price: number; currency?: string }
export interface Connection {
  key: string;
  live: boolean;
  product: string;
  /** Only on connections made before this server stopped using webhooks. */
  webhook?: string;
  webhookSecret?: string;
  portal: string | null;
  plans: (Plan & { currency: string; priceId: string; linkId: string; url: string })[];
  /** Songs and albums sold to keep, one link each. Absent on older connections. */
  sales?: SaleLink[];
}

export interface SaleLink { item: string; title: string; price: number; productId: string; priceId: string; linkId: string; url: string }

// ── talking to Stripe ───────────────────────────────────────────────────────

/** Stripe's API takes form encoding with brackets for nesting. */
export function formEncode(params: Record<string, unknown>, prefix = ""): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === "object") out.push(formEncode(item as Record<string, unknown>, `${key}[${i}]`));
        else out.push(`${encodeURIComponent(`${key}[]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof v === "object") {
      out.push(formEncode(v as Record<string, unknown>, key));
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return out.filter(Boolean).join("&");
}

export class StripeError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}

/**
 * The permissions a restricted key needs, named the way Stripe's key screen
 * names them — which is not how its errors name them. An artist told "lacks
 * rak_plan_write" has no way to know that means the Prices row.
 */
export const PERMISSIONS: Record<string, string> = {
  product_write: "Products — Write (under Core)",
  product_read: "Products — Write (under Core)",
  plan_write: "Prices — Write (under Billing)",
  plan_read: "Prices — Write (under Billing)",
  payment_links_write: "Payment Links — Write (under Core)",
  payment_links_read: "Payment Links — Write (under Core)",
  webhook_write: "Webhook Endpoints — Write",
  webhook_read: "Webhook Endpoints — Write",
  customer_portal_write: "Customer portal — Write (under Billing)",
  customer_portal_read: "Customer portal — Write (under Billing)",
  subscription_read: "Subscriptions — Read (under Billing)",
  subscription_write: "Subscriptions — Read (under Billing)",
  checkout_session_read: "Checkout Sessions — Read (under Checkout)",
  checkout_session_write: "Checkout Sessions — Read (under Checkout)",
};

/** Stripe's error, in words an artist can act on. */
export function explain(message: string, status = 0): string {
  const wanted = /rak_([a-z_]+?)_(read|write)\b/.exec(message);
  if (wanted) {
    const row = PERMISSIONS[`${wanted[1]}_${wanted[2]}`];
    return row
      ? `Your key is missing a permission. In Stripe, edit the key and set ${row}, then try again.`
      : `Your key is missing a permission Stripe calls "${wanted[1]} ${wanted[2]}". Edit the key in Stripe to add it, then try again.`;
  }
  if (status === 401 || /invalid api key/i.test(message)) {
    return "Stripe doesn't recognise that key. Copy it again — the whole thing, starting rk_ — and check it hasn't been deleted.";
  }
  if (/activate|activation|not.*enabled.*live|account.*cannot.*live/i.test(message)) {
    return "Your Stripe account isn't activated for real payments yet. Finish Stripe's setup (Activate payments, in your Stripe dashboard), or use a test-mode key for now.";
  }
  return `Stripe said: ${message}`;
}

async function call<T = Record<string, any>>(
  key: string, method: string, path: string, params?: Record<string, unknown>,
): Promise<T> {
  const init: RequestInit = { method, headers: { Authorization: `Bearer ${key}` } };
  let url = `${API}${path}`;
  if (params && method === "GET") url += `?${formEncode(params)}`;
  else if (params) {
    (init.headers as Record<string, string>)["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = formEncode(params);
  }
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({})) as { error?: { message?: string } };
  if (!res.ok) throw new StripeError(explain(body?.error?.message || `Stripe answered ${res.status}`, res.status), res.status);
  return body as T;
}

// ── being told who has paid ─────────────────────────────────────────────────
//
// Only connections made before this server switched to asking have a webhook
// and its secret; for any other, every notice is refused.

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Did Stripe send this, recently?
 *
 * Stripe signs each notice with the endpoint's secret: an HMAC-SHA256 of the
 * timestamp and the exact body. Anyone can post to this address; only Stripe
 * can produce the signature. The timestamp stops an old notice, captured
 * somewhere, being replayed later to extend a subscription.
 */
export async function verifySignature(
  raw: string, header: string | null, secret: string, now = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!header || !secret) return false;
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!Number.isFinite(t) || !signatures.length) return false;
  if (Math.abs(now - t) > TOLERANCE) return false;

  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const expected = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${raw}`)));
  return signatures.some((sig) => {
    if (sig.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  });
}

/** When a subscription's current period ends, in milliseconds. Newer Stripe
 *  API versions moved this from the subscription onto its items. */
export function periodEnd(sub: Record<string, any>): number | null {
  const s = sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end;
  return Number.isFinite(Number(s)) && Number(s) > 0 ? Number(s) * 1000 : null;
}

/** Still paid for? A payment that failed is given until the period ends,
 *  the same grace Stripe gives it before giving up. */
const STANDING = new Set(["active", "trialing", "past_due"]);

/** Made by this server: every price it creates is marked, and the mark
 *  outlives changing prices, so a subscriber on an old plan is still ours. */
export const ours = (sub: Record<string, any>) =>
  Array.isArray(sub?.items?.data) && sub.items.data.some((i: any) => i?.price?.metadata?.amply === "1");

export type Outcome = "recorded" | "updated" | "ignored" | "refused";

/**
 * Handle one notice from Stripe. Returns what was done, for the response and
 * for tests; anything not understood is acknowledged and ignored, so Stripe
 * does not keep retrying a notice this server has no use for.
 */
export async function handleEvent(
  db: D1Database, raw: string, signature: string | null,
  { fetchSubscription, now = Date.now() }: {
    fetchSubscription?: (id: string) => Promise<Record<string, any>>;
    now?: number;
  } = {},
): Promise<Outcome> {
  const connection = await connectionOf(db);
  if (!connection?.webhookSecret) return "refused";
  if (raw.length > MAX_EVENT) return "refused";
  if (!(await verifySignature(raw, signature, connection.webhookSecret, Math.floor(now / 1000)))) return "refused";

  let event: { type?: string; data?: { object?: Record<string, any> } };
  try { event = JSON.parse(raw); } catch { return "refused"; }
  const obj = event.data?.object ?? {};
  const load = fetchSubscription ?? ((id: string) => call(connection.key, "GET", `/subscriptions/${id}`));

  if (event.type === "checkout.session.completed") {
    if (obj.mode !== "subscription" || !obj.subscription) return "ignored";
    // The wallet the listener's app put on the checkout link. Without one, or
    // with something that isn't a wallet, there is nobody here to serve.
    const wallet = String(obj.client_reference_id || "");
    const key = fromBase58(wallet);
    if (!key || key.length !== 32) return "ignored";
    const sub = await load(String(obj.subscription));
    // Only a subscription to one of the plans this server made. The artist's
    // Stripe account may sell other things — a monthly merch club, a fan
    // page — and anyone can add their wallet to any of those links; buying a
    // $1 badge must not unlock a year of music.
    if (!ours(sub)) return "ignored";
    // And only one that is paid for. A checkout can complete with its first
    // payment still pending or failed.
    if (!STANDING.has(String(sub.status))) return "ignored";
    const until = periodEnd(sub);
    if (!until) return "ignored";
    await recordSubscription(db, {
      wallet, subscription: String(obj.subscription), customer: obj.customer ? String(obj.customer) : null, until,
    }, now);
    return "recorded";
  }

  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    if (!obj.id) return "ignored";
    let until: number;
    if (event.type === "customer.subscription.deleted" || !STANDING.has(String(obj.status))) {
      // Over. Ended now, or when Stripe says it ended.
      until = obj.ended_at ? Number(obj.ended_at) * 1000 : now;
    } else {
      // Renewed, or cancelled to end with the period — paid up until then.
      until = periodEnd(obj) ?? now;
    }
    await updateSubscription(db, String(obj.id), until, now);
    await tidy(db, now);
    return "updated";
  }

  return "ignored";
}

// ── asking who has paid ─────────────────────────────────────────────────────

const REFRESH_EVERY = 24 * 3600e3;
const SESSION = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;

type Loader = (id: string) => Promise<Record<string, any>>;

export type Claim = "recorded" | "pending" | "refused";

/** The latest finished checkout paid for this wallet, on any of this
 *  connection's links. The newest hundred per link — plenty for a fan who
 *  paid a moment ago. */
async function findSession(c: Connection, wallet: string): Promise<Record<string, any> | null> {
  for (const p of c.plans) {
    const page = await call<{ data?: Record<string, any>[] }>(c.key, "GET", "/checkout/sessions", {
      payment_link: p.linkId, status: "complete", limit: 100,
    });
    const mine = (page.data || []).find((s) => s.client_reference_id === wallet);
    if (mine) return mine;
  }
  return null;
}

/**
 * A listener back from Stripe, saying "this checkout was mine".
 *
 * The caller has already proven the wallet with its signature. What makes the
 * checkout theirs is that Stripe says it was paid for that same wallet — the
 * one their app put on the link. A checkout id alone proves nothing: it may
 * have been copied from someone else's address bar.
 */
export async function claim(
  db: D1Database, wallet: string, sessionId: string,
  { loadSession, loadSubscription, now = Date.now() }: {
    loadSession?: Loader; loadSubscription?: Loader; now?: number;
  } = {},
): Promise<Claim> {
  const c = await connectionOf(db);
  if (!c) return "refused";
  let session: Record<string, any> | null;
  if (sessionId === "") {
    // No id: they paid but never made it back to the app. Look through the
    // latest finished checkouts on this server's own links for their wallet.
    session = await findSession(c, wallet);
    if (!session) return "refused";
  } else {
    if (!SESSION.test(sessionId)) return "refused";
    session = await (loadSession ?? ((id) => call(c.key, "GET", `/checkout/sessions/${id}`)))(sessionId);
  }
  if (session.mode !== "subscription" || !session.subscription) return "refused";
  if (session.client_reference_id !== wallet) return "refused";
  if (session.status !== "complete") return "pending";
  const id = typeof session.subscription === "string" ? session.subscription : String(session.subscription.id);
  const sub = await (loadSubscription ?? ((i) => call(c.key, "GET", `/subscriptions/${i}`)))(id);
  // Only one of the plans this server made — see ours() — and only once paid.
  if (!ours(sub)) return "refused";
  if (!STANDING.has(String(sub.status))) return "pending";
  const until = periodEnd(sub);
  if (!until) return "pending";
  await recordSubscription(db, {
    wallet, subscription: id, customer: session.customer ? String(session.customer) : sub.customer ? String(sub.customer) : null, until,
  }, now);
  return "recorded";
}

/**
 * How long this wallet's subscription runs, checked with Stripe when due.
 *
 * Renewals and cancellations are learned by asking: the moment a paid period
 * runs out (so a renewal leaves no gap), and otherwise once a day (so a
 * subscription the artist cancelled or refunded stops within a day). An ended
 * subscription is not asked about again — starting a new one is a new claim.
 * If Stripe doesn't answer, what was known stands.
 */
export async function refresh(
  db: D1Database, wallet: string,
  { loadSubscription, now = Date.now() }: { loadSubscription?: Loader; now?: number } = {},
): Promise<number | null> {
  const s = await subscriptionOf(db, wallet);
  if (!s) return null;
  const due = s.until > now ? now - s.updated >= REFRESH_EVERY : s.updated < s.until;
  if (!due) return s.until;
  const c = await connectionOf(db);
  if (!c) return s.until;
  try {
    const sub = await (loadSubscription ?? ((i) => call(c.key, "GET", `/subscriptions/${i}`)))(s.subscription);
    const until = STANDING.has(String(sub.status))
      ? (periodEnd(sub) ?? now)
      : (sub.ended_at ? Number(sub.ended_at) * 1000 : now);
    await updateSubscription(db, s.subscription, until, now);
    await tidy(db, now);
    return until;
  } catch {
    return s.until;
  }
}

// ── connecting an artist's account ──────────────────────────────────────────

export async function connectionOf(db: D1Database): Promise<Connection | null> {
  const raw = await setting(db, STRIPE_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as Connection; } catch { return null; }
}

/** What the editor may see: whether there is a connection and what it sells.
 *  Never the key or the webhook secret. */
export async function publicView(db: D1Database) {
  const c = await connectionOf(db);
  if (!c) return { connected: false };
  const sales = (c.sales || []).map(({ item, price, url }) => ({ item, price, url }));
  // Stopped, but still following people who subscribed before. (Connected
  // for selling songs, even with nothing priced yet, is still connected.)
  if (!c.plans.length && !c.sales) return { connected: false, winding: true, live: c.live };
  return {
    connected: true,
    live: c.live,
    cancellable: !!c.portal,
    plans: c.plans.map(({ months, price, currency, url }) => ({ months, price, currency, url })),
    sales,
  };
}

/**
 * Set up what the artist sells, in their Stripe account, with their key.
 *
 * One product, and one recurring price and one payment link per plan. A
 * customer portal too, so a subscriber can cancel on Stripe's own page — EU
 * law requires that ending a subscription be as easy as starting it.
 * Reconnecting (to change prices) replaces the links; subscribers already
 * paying keep their subscriptions on the prices they chose.
 */
export async function connect(
  db: D1Database,
  { key, plans, origin, artist, returnTo }: {
    key: string; plans: Plan[]; origin: string; artist: string; returnTo: string;
  },
): Promise<Connection> {
  if (!/^(sk|rk)_(live|test)_[A-Za-z0-9]+$/.test(key)) {
    throw new StripeError(/^pk_/.test(key)
      ? "That's Stripe's publishable key. Amply needs the secret key shown with it, which starts rk_."
      : "That doesn't look like a Stripe secret key. Copy the one that starts rk_.");
  }
  const live = key.includes("_live_");

  // Checks the key works, and can see products, before anything is created.
  await call(key, "GET", "/products", { limit: 1 });

  const previous = await connectionOf(db);

  // Anything made before a later step fails is undone, so a missing
  // permission halfway through doesn't leave working checkout links in the
  // artist's Stripe that nothing here is listening for.
  const made: Connection["plans"] = [];
  let product: Record<string, any> | null = null;
  try {
  product = await call(key, "POST", "/products", {
    name: `${artist} — subscription`,
    metadata: { amply: "1" },
  });

  for (const plan of plans) {
    const currency = (plan.currency || "usd").toLowerCase();
    const price = await call(key, "POST", "/prices", {
      product: product!.id,
      currency,
      unit_amount: Math.round(plan.price * 100),
      recurring: { interval: "month", interval_count: plan.months },
      metadata: { amply: "1", months: String(plan.months) },
    });
    const link = await call(key, "POST", "/payment_links", {
      line_items: [{ price: price.id, quantity: 1 }],
      after_completion: { type: "redirect", redirect: { url: returnTo } },
      metadata: { amply: "1", months: String(plan.months) },
    });
    made.push({ months: plan.months, price: plan.price, currency, priceId: price.id, linkId: link.id, url: link.url });
  }

  // Reading a checkout and a subscription is how a payment is confirmed;
  // better to find a missing permission now than when the first fan pays.
  await call(key, "GET", "/checkout/sessions", { limit: 1 });
  await call(key, "GET", "/subscriptions", { limit: 1 });
  } catch (e) {
    for (const p of made) await call(key, "POST", `/payment_links/${p.linkId}`, { active: false }).catch(() => {});
    if (product?.id) await call(key, "POST", `/products/${product.id}`, { active: false }).catch(() => {});
    throw e;
  }

  // Cancellation on Stripe's page. Optional only in that a key without the
  // permission still connects; the editor says cancelling isn't available.
  let portal: string | null = null;
  try {
    const config = await call(key, "POST", "/billing_portal/configurations", {
      business_profile: { headline: `Manage your subscription to ${artist}` },
      features: {
        subscription_cancel: { enabled: true, mode: "at_period_end" },
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
      },
    });
    portal = config.id;
  } catch { /* connected without it */ }

  const connection: Connection = { key, live, product: product!.id, portal, plans: made, sales: previous?.sales };
  await putSetting(db, STRIPE_KEY, JSON.stringify(connection));

  // The old links stop selling, and any old webhook is removed. Best effort:
  // the new connection is already in place, whatever happens here.
  if (previous) await retire(previous).catch(() => {});
  return connection;
}

/** Stop selling through a connection: its links deactivated, its webhook removed. */
async function retire(c: Connection): Promise<void> {
  for (const p of c.plans) await call(c.key, "POST", `/payment_links/${p.linkId}`, { active: false }).catch(() => {});
  if (c.webhook) await call(c.key, "DELETE", `/webhook_endpoints/${c.webhook}`).catch(() => {});
}

/**
 * Stop selling subscriptions.
 *
 * The links stop selling at once. But people already subscribed stay
 * subscribed in Stripe, and Stripe goes on renewing them — so this server
 * keeps its key, to go on checking those renewals and cancellations, until
 * the last one has ended. Letting go straight away would charge them and
 * then lock them out.
 */
export async function disconnect(db: D1Database, now = Date.now()): Promise<void> {
  const c = await connectionOf(db);
  if (!c) return;
  for (const p of c.plans) await call(c.key, "POST", `/payment_links/${p.linkId}`, { active: false }).catch(() => {});
  await putSetting(db, STRIPE_KEY, JSON.stringify({ ...c, plans: [] }));
  await tidy(db, now);
}

/** Once nothing is sold and nobody is still subscribed, let go entirely:
 *  any old webhook removed and the key forgotten. */
async function tidy(db: D1Database, now: number): Promise<void> {
  const c = await connectionOf(db);
  if (!c || c.plans.length || c.sales) return;
  const still = await db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE until > ?").bind(now).first<{ n: number }>();
  if (Number(still?.n) > 0) return;
  await retire(c).catch(() => {});
  await db.prepare("DELETE FROM settings WHERE key = ?").bind(STRIPE_KEY).run();
}

/** A link to Stripe's page where this wallet's subscriber can cancel. */
export async function portalFor(db: D1Database, wallet: string, returnTo: string): Promise<string | null> {
  const c = await connectionOf(db);
  const s = await subscriptionOf(db, wallet);
  if (!c?.portal || !s?.customer) return null;
  const session = await call(c.key, "POST", "/billing_portal/sessions", {
    customer: s.customer, configuration: c.portal, return_url: returnTo,
  });
  return session.url ?? null;
}

// ── selling songs and albums ────────────────────────────────────────────────
//
// The same arrangement as subscriptions: a one-off price and a Payment Link
// in the artist's own Stripe for each album or song they sell, made with the
// key already here (or one given now, for an artist who sells songs but not
// subscriptions). No new permissions: products, prices, links, and reading a
// checkout are what the key can already do.

export interface SaleItem { item: string; title: string; price: number }

/**
 * Make, keep or retire the links for what the artist sells. A link whose
 * price hasn't changed is kept, so publishing again doesn't break a link a
 * fan has open; a changed price gets a new link and the old one stops; an
 * item no longer sold has its link stopped.
 */
export async function setSales(
  db: D1Database,
  { key, items, artist, returnTo }: { key?: string; items: SaleItem[]; artist: string; returnTo: string },
): Promise<SaleLink[]> {
  let c = await connectionOf(db);
  const useKey = (key || "").trim() || c?.key || "";
  if (!useKey) throw new StripeError("Connect Stripe first: paste your key, or install Amply for Artists.");
  if (!/^(sk|rk)_(live|test)_[A-Za-z0-9]+$/.test(useKey)) throw new StripeError("That doesn't look like a Stripe secret key. Copy the one that starts rk_.");
  if (!c || c.key !== useKey) {
    await call(useKey, "GET", "/products", { limit: 1 });
    c = { key: useKey, live: useKey.includes("_live_"), product: c?.product || "", portal: c?.portal ?? null, plans: c?.key === useKey ? c.plans : [], sales: c?.sales };
  }
  const had = c.sales || [];
  const next: SaleLink[] = [];
  const made: SaleLink[] = [];
  try {
    for (const it of items) {
      const same = had.find((h) => h.item === it.item && h.price === it.price);
      if (same) { next.push({ ...same, title: it.title }); continue; }
      const product = await call(useKey, "POST", "/products", {
        name: `${it.title} — ${artist}`.slice(0, 250),
        metadata: { amply: "1", sale: it.item },
      });
      const price = await call(useKey, "POST", "/prices", {
        product: product.id, currency: "usd", unit_amount: Math.round(it.price * 100),
        metadata: { amply: "1", sale: it.item },
      });
      const link = await call(useKey, "POST", "/payment_links", {
        line_items: [{ price: price.id, quantity: 1 }],
        after_completion: { type: "redirect", redirect: { url: returnTo } },
        // Said where the buyer pays, as well as in the app before they get
        // here: a download that starts at once can't be sent back.
        custom_text: { submit: { message: "The download starts as soon as you've paid, so it can't be returned once it has." } },
        metadata: { amply: "1", sale: it.item },
      });
      const entry = { item: it.item, title: it.title, price: it.price, productId: product.id, priceId: price.id, linkId: link.id, url: link.url };
      made.push(entry);
      next.push(entry);
    }
    // Reading a finished checkout is how a purchase is confirmed.
    if (items.length) await call(useKey, "GET", "/checkout/sessions", { limit: 1 });
  } catch (e) {
    for (const m of made) await call(useKey, "POST", `/payment_links/${m.linkId}`, { active: false }).catch(() => {});
    throw e;
  }
  for (const h of had) {
    if (!next.some((n) => n.linkId === h.linkId)) await call(useKey, "POST", `/payment_links/${h.linkId}`, { active: false }).catch(() => {});
  }
  await putSetting(db, STRIPE_KEY, JSON.stringify({ ...c, sales: next }));
  return next;
}

export type SaleClaim = { outcome: "recorded"; ref: string; item: string } | { outcome: "pending" } | { outcome: "refused" };

/**
 * A listener back from buying: "this checkout was mine". Believed only if
 * Stripe says it was paid, for this wallet, on one of this server's own sale
 * links — a payment for anything else the artist sells doesn't buy music.
 *
 * Only with the checkout's id, which Stripe hands back on the way to the app.
 * Searching every sale link for a wallet instead would let anyone with a key
 * pair make this server spend its Stripe requests (hundreds, for an artist
 * selling many songs) as often as they liked.
 */
export async function claimSale(
  db: D1Database, wallet: string, sessionId: string,
  { loadSession }: { loadSession?: Loader } = {},
): Promise<SaleClaim> {
  const c = await connectionOf(db);
  const links = c?.sales || [];
  if (!c || !links.length) return { outcome: "refused" };
  if (!SESSION.test(sessionId)) return { outcome: "refused" };
  const session = await (loadSession ?? ((id) => call(c.key, "GET", `/checkout/sessions/${id}`)))(sessionId);
  if (session.mode !== "payment") return { outcome: "refused" };
  if (session.client_reference_id !== wallet) return { outcome: "refused" };
  const linkId = typeof session.payment_link === "string" ? session.payment_link : session.payment_link?.id;
  const link = links.find((l) => l.linkId === linkId);
  if (!link) return { outcome: "refused" };
  if (session.status !== "complete" || session.payment_status !== "paid") return { outcome: "pending" };
  return { outcome: "recorded", ref: String(session.id), item: link.item };
}
