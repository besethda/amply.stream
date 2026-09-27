/**
 * Everything the streaming service remembers, in the artist's own database.
 *
 * `settings` holds the manifest, the sign-in configuration, the key this
 * service signs listening tokens with, and the artist's Stripe connection if
 * they have one. `listeners` holds a tally per wallet: how much they have
 * listened, when they were last here, and whether the artist has stopped
 * serving them. `subscriptions` holds who has paid for a subscription, and
 * until when. `sales` and `downloads` hold what was bought to keep, and how
 * many times each song of it has been downloaded.
 *
 * **A ledger, not a log.** There is no row recording that a particular wallet
 * played a particular track at a particular time. Totals answer the question an
 * artist actually has — who is listening a lot and paying nothing — without
 * building a record of anybody's taste. What is not collected cannot leak, be
 * demanded, or be mishandled by someone who never wanted to be a data
 * controller. See docs/identity.md.
 *
 * D1 rather than KV because KV allows a thousand writes a day on the free plan
 * and a single enthusiastic listener would spend a tenth of that in an evening.
 */

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS listeners (
     pubkey TEXT PRIMARY KEY,
     plays INTEGER NOT NULL DEFAULT 0,
     seconds INTEGER NOT NULL DEFAULT 0,
     first_seen INTEGER NOT NULL,
     last_seen INTEGER NOT NULL,
     blocked INTEGER NOT NULL DEFAULT 0
   )`,
  // Who has an active subscription, and until when. The listener's wallet,
  // Stripe's id for the subscription and for the customer — so it can be
  // checked with Stripe and cancelled through Stripe's page — and the
  // date it runs to. Their name, email and card stay in the artist's Stripe
  // account, where Stripe keeps them; none of it is copied here.
  `CREATE TABLE IF NOT EXISTS subscriptions (
     wallet TEXT PRIMARY KEY,
     subscription TEXT NOT NULL,
     customer TEXT,
     until INTEGER NOT NULL,
     updated INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS subscriptions_by_id ON subscriptions (subscription)`,
  // Songs and albums bought to keep (sales.ts). The payment is the key, so it
  // counts once. The owner is empty while a gift waits for someone to claim it.
  `CREATE TABLE IF NOT EXISTS sales (
     ref TEXT PRIMARY KEY,
     item TEXT NOT NULL,
     buyer TEXT NOT NULL,
     owner TEXT,
     gift TEXT,
     via TEXT NOT NULL,
     created INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS sales_by_owner ON sales (owner)`,
  `CREATE INDEX IF NOT EXISTS sales_by_buyer ON sales (buyer)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS sales_by_gift ON sales (gift)`,
  `CREATE TABLE IF NOT EXISTS downloads (
     ref TEXT NOT NULL,
     track TEXT NOT NULL,
     count INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (ref, track)
   )`,
];

/**
 * Changes to the tables above, in order, applied once each.
 *
 * SCHEMA is created with IF NOT EXISTS, which means it can bring a table into
 * existence and can never change one that already exists. That is fine until
 * the day a column is added: a rebuild would install a Worker that reads it on
 * top of a database that does not have it, and the artist would watch their
 * service break — with no way for us to reach in and fix it.
 *
 * So changes go here instead. Each has an id higher than the last, each is
 * applied once, and the highest applied id is recorded in the artist's own
 * settings table. Empty today, which is the right time to build the mechanism
 * rather than the day it is needed in a hurry.
 *
 * Rules for anything added here:
 *   - never destructive: no DROP, no rewriting a column's contents;
 *   - safe to run against a database that has already had it, in case the
 *     record of what was applied is ever lost;
 *   - and the Worker must cope with the column being absent, because a rebuild
 *     can fail halfway.
 */
export const MIGRATIONS: { id: number; sql: string }[] = [];

export const SCHEMA_VERSION = "schema-version";

export interface Listener {
  pubkey: string;
  plays: number;
  seconds: number;
  first_seen: number;
  last_seen: number;
  blocked: number;
}

export async function setting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function putSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).bind(key, value).run();
}

/**
 * The key this node signs listening tokens with.
 *
 * Made once, on demand, and never leaves the artist's account. If it is ever
 * lost every outstanding token stops working, which logs listeners out and
 * costs nothing else.
 */
let cachedSecret: string | null = null;

export async function signingKey(db: D1Database): Promise<string> {
  // Held in the isolate. Every ranged audio request for a guarded track checks
  // a token, and reading the secret from the database each time would make the
  // claim that "checking a token is arithmetic, not a query" untrue.
  if (cachedSecret) return cachedSecret;

  const kept = await setting(db, "token-secret");
  if (kept) {
    cachedSecret = kept;
    return kept;
  }

  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const made = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

  // Do-nothing on conflict, then read back what is actually stored. Two
  // requests arriving together would otherwise each write their own secret, and
  // the loser would have handed out tokens signed with a key that no longer
  // exists.
  await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING")
    .bind("token-secret", made).run();
  cachedSecret = (await setting(db, "token-secret")) ?? made;
  return cachedSecret;
}

export async function listener(db: D1Database, pubkey: string): Promise<Listener | null> {
  return db.prepare("SELECT * FROM listeners WHERE pubkey = ?").bind(pubkey).first<Listener>();
}

/**
 * Note that a known wallet is here. Deliberately an update and not an insert.
 *
 * Saying hello is unauthenticated — it has to be, it is how a stranger becomes
 * known — and a wallet costs nothing to make. If hello created a row, anyone
 * could spend an artist's daily write budget and fill their database with
 * wallets that never listened to anything, for the price of a signature. A row
 * appears when something is actually played instead, which costs the sender
 * bandwidth and the artist nothing they did not want.
 */
export async function seen(db: D1Database, pubkey: string, now = Date.now()): Promise<void> {
  await db.prepare("UPDATE listeners SET last_seen = ? WHERE pubkey = ?").bind(now, pubkey).run();
}

/**
 * Count a play.
 *
 * Called once per track by the client when it has finished playing, not once
 * per request: audio arrives in many ranged pieces, and counting those would
 * count a paused song a hundred times and spend the write budget doing it.
 *
 * A dishonest client could inflate or omit this. That is tolerable, because the
 * number is the artist's own view of their own listeners rather than anything
 * anyone is charged on: money moves on chain, where nobody has to be believed.
 */
export async function counted(
  db: D1Database,
  pubkey: string,
  seconds: number,
  now = Date.now(),
): Promise<void> {
  const clean = Math.max(0, Math.min(Math.round(seconds), 3600));
  await db.prepare(
    `INSERT INTO listeners (pubkey, plays, seconds, first_seen, last_seen) VALUES (?, 1, ?, ?, ?)
     ON CONFLICT(pubkey) DO UPDATE SET
       plays = plays + 1,
       seconds = seconds + excluded.seconds,
       last_seen = excluded.last_seen`,
  ).bind(pubkey, clean, now, now).run();
}

/**
 * The artist's listeners, each with when their subscription runs to, if they
 * have one. A subscriber pays by card, not by the minute, so the Paid column
 * would otherwise show them owing for every minute they played — exactly the
 * kind of honest listener an artist must not be invited to stop serving.
 */
export async function listeners(db: D1Database, limit = 500): Promise<(Listener & { subscribed_until: number | null })[]> {
  const { results } = await db.prepare(
    `SELECT l.*, s.until AS subscribed_until
       FROM listeners l LEFT JOIN subscriptions s ON s.wallet = l.pubkey
      ORDER BY l.seconds DESC LIMIT ?`,
  ).bind(Math.min(limit, 1000)).all<Listener & { subscribed_until: number | null }>();
  return results ?? [];
}

/** An upsert, so that blocking a wallet sticks even when there is no row for it
 *  yet — otherwise a decision the artist made would quietly do nothing. */
export async function setBlocked(db: D1Database, pubkey: string, blocked: boolean, now = Date.now()): Promise<void> {
  await db.prepare(
    `INSERT INTO listeners (pubkey, first_seen, last_seen, blocked) VALUES (?, ?, ?, ?)
     ON CONFLICT(pubkey) DO UPDATE SET blocked = excluded.blocked`,
  ).bind(pubkey, now, now, blocked ? 1 : 0).run();
}

/**
 * Forget a listener at their own request.
 *
 * They hold the key, so they can prove the row is theirs by signing for it, and
 * the node erases it there and then. No identity documents, no mailbox, no
 * judgement call by a musician. It is a better erasure process than most
 * companies manage, and this is all of it.
 *
 * **One thing survives, and only for a wallet the artist has stopped serving:**
 * the address itself, with the block still on it, and every number wiped. A
 * plain delete would make the ban button useless — the banned party could lift
 * their own ban by asking to be forgotten, and again every time it was reapplied. So
 * what is kept is the minimum that enforces the artist's decision, holding
 * nothing about what anyone listened to. Erasure is not absolute where a
 * controller has grounds to refuse it, and "this person is barred" is the
 * textbook one. A wallet nobody has blocked is deleted outright.
 */
export async function forget(db: D1Database, pubkey: string): Promise<void> {
  await db.prepare(
    `UPDATE listeners SET plays = 0, seconds = 0, first_seen = 0, last_seen = 0
     WHERE pubkey = ? AND blocked = 1`,
  ).bind(pubkey).run();
  await db.prepare("DELETE FROM listeners WHERE pubkey = ? AND blocked = 0").bind(pubkey).run();
}

// ── what an artist needs to meet their obligations ─────────────────────────
//
// The artist is the data controller for everything in the listeners table, and
// almost none of them will know what that means. These are the pieces that let
// them meet the obligations without having to: a listener can see and erase
// their own record, an artist can delete or export one on request, and nothing
// is kept longer than it is useful. See /why#gdpr on amply.stream.

/**
 * How long a wallet's totals are kept after it was last heard from.
 *
 * A year: long enough that a returning listener still shows up with their
 * history, which is what an artist deciding whether someone pays needs, and
 * short enough to be an honest answer to "why do you still have this?" The
 * record of a barred wallet is kept regardless, holding nothing but the bar —
 * see forget().
 */
export const KEEP_FOR = 365 * 86400_000;

/**
 * Delete the totals of wallets not heard from within KEEP_FOR.
 *
 * Run opportunistically rather than on a timer, so it needs nothing an artist
 * would have to set up: whenever the artist looks at their listeners, and now
 * and then as music is played. A table of one artist's listeners is small, and
 * one delete against it costs next to nothing.
 */
export async function pruneStale(db: D1Database, now = Date.now()): Promise<void> {
  await db.prepare("DELETE FROM listeners WHERE blocked = 0 AND last_seen < ?")
    .bind(now - KEEP_FOR).run();
}

/**
 * Remove a wallet completely, at the artist's own hand.
 *
 * Unlike forget(), which a listener calls and which keeps a bar standing, this
 * is the artist acting on their own data: a request that arrived by email, a
 * record they no longer want. It takes the bar with it, because it is their
 * bar to lift.
 */
export async function remove(db: D1Database, pubkey: string): Promise<void> {
  await db.prepare("DELETE FROM listeners WHERE pubkey = ?").bind(pubkey).run();
  await db.prepare("DELETE FROM subscriptions WHERE wallet = ?").bind(pubkey).run();
}

// ── subscriptions ───────────────────────────────────────────────────────────
//
// Kept separately from the listening totals because they rest on something
// different: a contract the listener paid for. Asking to be forgotten erases
// what was recorded about their listening, but not the record that they have
// paid for the year — erasing that would take away what they bought. It goes
// when the subscription does, a year after it ends at the latest.

export interface Subscription {
  wallet: string;
  subscription: string;
  customer: string | null;
  until: number;
  updated: number;
}

/** When this wallet's subscription runs out, or null if it has none. */
export async function subscribedUntil(db: D1Database, wallet: string): Promise<number | null> {
  const row = await db.prepare("SELECT until FROM subscriptions WHERE wallet = ?").bind(wallet)
    .first<{ until: number }>();
  return row?.until ?? null;
}

export async function subscriptionOf(db: D1Database, wallet: string): Promise<Subscription | null> {
  return db.prepare("SELECT * FROM subscriptions WHERE wallet = ?").bind(wallet).first<Subscription>();
}

/** A new subscription, once Stripe confirms its checkout was paid. */
export async function recordSubscription(
  db: D1Database,
  s: { wallet: string; subscription: string; customer: string | null; until: number },
  now = Date.now(),
): Promise<void> {
  await db.prepare(
    `INSERT INTO subscriptions (wallet, subscription, customer, until, updated) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(wallet) DO UPDATE SET
       subscription = excluded.subscription, customer = excluded.customer,
       until = excluded.until, updated = excluded.updated`,
  ).bind(s.wallet, s.subscription, s.customer, s.until, now).run();
}

/** A renewal, a cancellation or an ending, as learned from Stripe, which
 *  names the subscription but not the wallet. */
export async function updateSubscription(
  db: D1Database, subscription: string, until: number, now = Date.now(),
): Promise<void> {
  await db.prepare("UPDATE subscriptions SET until = ?, updated = ? WHERE subscription = ?")
    .bind(until, now, subscription).run();
}

/** Subscriptions that ended more than KEEP_FOR ago. */
export async function pruneSubscriptions(db: D1Database, now = Date.now()): Promise<void> {
  await db.prepare("DELETE FROM subscriptions WHERE until < ?").bind(now - KEEP_FOR).run();
}
