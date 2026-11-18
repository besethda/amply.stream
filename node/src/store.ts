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
 * controller.
 *
 * D1 rather than KV because KV allows a thousand writes a day on the free plan
 * and a single enthusiastic listener would spend a tenth of that in an evening.
 */

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  // What each wallet's listening cost, priced when it was heard: the price
  // then, and nothing while it was free (paused, subscribed, or no price).
  // Kept beside `listeners` rather than in it, so a database from before
  // needs no change made to an existing table. `seconds` is the listening
  // this covers; anything in `listeners.seconds` beyond it came before.
  `CREATE TABLE IF NOT EXISTS owed (
     pubkey TEXT PRIMARY KEY,
     micros INTEGER NOT NULL DEFAULT 0,
     seconds INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS listeners (
     pubkey TEXT PRIMARY KEY,
     plays INTEGER NOT NULL DEFAULT 0,
     seconds INTEGER NOT NULL DEFAULT 0,
     first_seen INTEGER NOT NULL,
     last_seen INTEGER NOT NULL,
     blocked INTEGER NOT NULL DEFAULT 0
   )`,
  // For pruneStale: finding wallets not heard from in a year without reading
  // every row. A new index on an existing table, so nothing in it changes.
  `CREATE INDEX IF NOT EXISTS listeners_by_last_seen ON listeners (last_seen)`,
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
  // How much each song has been played, by everyone together: a number per
  // song, never per listener, so the artist can see what's popular without
  // anyone's listening being recorded.
  `CREATE TABLE IF NOT EXISTS track_plays (
     track TEXT PRIMARY KEY,
     plays INTEGER NOT NULL DEFAULT 0,
     seconds INTEGER NOT NULL DEFAULT 0
   )`,
  // How many songs were played each day, by everyone together: a number per
  // day, for the editor's "free streams" bar (quota.ts). The last 30 days.
  `CREATE TABLE IF NOT EXISTS play_days (
     day TEXT PRIMARY KEY,
     plays INTEGER NOT NULL DEFAULT 0
   )`,
  // How many listeners' network fees the node paid each day (settle.ts): a
  // number per day, to cap what the fee wallet can spend. Not who, not what.
  `CREATE TABLE IF NOT EXISTS fee_days (
     day TEXT PRIMARY KEY,
     count INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS downloads (
     ref TEXT NOT NULL,
     track TEXT NOT NULL,
     count INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (ref, track)
   )`,
  // What each wallet has paid for listening, as far as this server knows:
  // payments it sent for them (settle.ts), payments their app reported and the
  // server checked on the chain itself, and the totals the artist's editor read
  // from the chain. Only ever grows. Auto-block compares it with what their
  // listening cost (owed). Beside the other tables, so nothing existing changes.
  `CREATE TABLE IF NOT EXISTS paid (
     pubkey TEXT PRIMARY KEY,
     micros INTEGER NOT NULL DEFAULT 0,
     last INTEGER NOT NULL DEFAULT 0
   )`,
  // Which payments have been added to paid, by their transaction, so one
  // payment is never counted twice however often it's reported.
  `CREATE TABLE IF NOT EXISTS paid_sigs (
     sig TEXT PRIMARY KEY,
     pubkey TEXT NOT NULL,
     micros INTEGER NOT NULL,
     at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS paid_sigs_by_pubkey ON paid_sigs (pubkey)`,
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
  /** The price per minute while it was heard, in dollars: 0 when it was free. */
  perMinute = 0,
): Promise<void> {
  const clean = Math.max(0, Math.min(Math.round(seconds), MAX_REPORT_S));
  await db.prepare(
    `INSERT INTO listeners (pubkey, plays, seconds, first_seen, last_seen) VALUES (?, 1, ?, ?, ?)
     ON CONFLICT(pubkey) DO UPDATE SET
       plays = plays + 1,
       seconds = seconds + excluded.seconds,
       last_seen = excluded.last_seen`,
  ).bind(pubkey, clean, now, now).run();
  const micros = perMinute > 0 ? Math.round((clean / 60) * perMinute * 1_000_000) : 0;
  // A database from before this table has no record of cost; the editor
  // then estimates, as it always did. Nothing here is worth failing a play for.
  await db.prepare(
    `INSERT INTO owed (pubkey, micros, seconds) VALUES (?, ?, ?)
     ON CONFLICT(pubkey) DO UPDATE SET micros = micros + excluded.micros, seconds = seconds + excluded.seconds`,
  ).bind(pubkey, micros, clean).run().catch(() => {});
}

/** The longest one report of listening can be: a long mix, not a day. */
export const MAX_REPORT_S = 3 * 3600;

/**
 * The artist's listeners, each with when their subscription runs to, if they
 * have one. A subscriber pays by card, not by the minute, so the Paid column
 * would otherwise show them owing for every minute they played — exactly the
 * kind of honest listener an artist must not be invited to stop serving.
 */
export type ListenerRow = Listener & {
  subscribed_until: number | null;
  owed_micros?: number | null;
  owed_seconds?: number | null;
  paid_micros?: number | null;
};

export async function listeners(db: D1Database, limit = 500): Promise<ListenerRow[]> {
  const n = Math.min(limit, 1000);
  try {
    const { results } = await db.prepare(
      `SELECT l.*, s.until AS subscribed_until, o.micros AS owed_micros, o.seconds AS owed_seconds,
              p.micros AS paid_micros
         FROM listeners l LEFT JOIN subscriptions s ON s.wallet = l.pubkey
         LEFT JOIN owed o ON o.pubkey = l.pubkey
         LEFT JOIN paid p ON p.pubkey = l.pubkey
        ORDER BY l.seconds DESC LIMIT ?`,
    ).bind(n).all<ListenerRow>();
    return results ?? [];
  } catch { /* no paid table yet (a rebuild that stopped halfway): without it */ }
  try {
    const { results } = await db.prepare(
      `SELECT l.*, s.until AS subscribed_until, o.micros AS owed_micros, o.seconds AS owed_seconds
         FROM listeners l LEFT JOIN subscriptions s ON s.wallet = l.pubkey
         LEFT JOIN owed o ON o.pubkey = l.pubkey
        ORDER BY l.seconds DESC LIMIT ?`,
    ).bind(n).all<ListenerRow>();
    return results ?? [];
  } catch {
    // No `owed` table yet (a database from before it): as before.
    const { results } = await db.prepare(
      `SELECT l.*, s.until AS subscribed_until
         FROM listeners l LEFT JOIN subscriptions s ON s.wallet = l.pubkey
        ORDER BY l.seconds DESC LIMIT ?`,
    ).bind(n).all<ListenerRow>();
    return results ?? [];
  }
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
  await forgetOwed(db, pubkey);
}

/**
 * What a wallet's listening cost, and what it has paid, go with the rest of
 * what's held about it. The two go together: one without the other would
 * leave a wallet owing for listening nobody remembers, or credited for
 * payments against listening that's gone.
 *
 * Erasing does wipe what an auto-blocked wallet owes, and so lifts it. That
 * is deliberate: a wallet costs nothing to make, so anyone dodging payment
 * could start again with a new one just as easily, and the right to be
 * forgotten is not something to bargain over a few cents. A block the artist
 * made by hand survives (see forget).
 */
async function forgetOwed(db: D1Database, pubkey?: string): Promise<void> {
  // Each on its own: a database from before one of these tables still has
  // the others cleared.
  for (const table of ["owed", "paid", "paid_sigs"]) {
    try {
      await (pubkey
        ? db.prepare(`DELETE FROM ${table} WHERE pubkey = ?`).bind(pubkey)
        : db.prepare(`DELETE FROM ${table} WHERE pubkey NOT IN (SELECT pubkey FROM listeners)`)
      ).run();
    } catch { /* no such table yet */ }
  }
}

// ── what a wallet has paid, and Auto-block ─────────────────────────────────
//
// The editor reads the chain to see who has paid; the server mostly can't
// (Solana's public endpoint refuses Workers, and reading every payment would
// be slow). It keeps a running total instead, from the payments it learns of,
// so it can stop serving listeners who are behind when the artist asks it to.
// See spec/standing.mjs for what "behind" means, and index.ts for where the
// rule is applied.

/** What this wallet has paid, as far as this server knows: 0 if nothing.
 *  Null on a database from before the table, where nobody can say — and so
 *  Auto-block refuses nobody (a rebuild that stopped halfway mustn't turn
 *  every listener into a debtor). */
export async function paidOf(db: D1Database, pubkey: string): Promise<number | null> {
  try {
    const row = await db.prepare("SELECT micros FROM paid WHERE pubkey = ?").bind(pubkey).first<{ micros: number }>();
    return Number(row?.micros) || 0;
  } catch {
    return null;
  }
}

/**
 * One payment, counted once: keyed by its transaction, so a payment reported
 * twice — the app asking again, two copies of the Worker at once, the same
 * signature sent by someone else — adds to the total only the first time.
 * Returns whether it was new. A database without the tables records nothing.
 */
export async function recordPaid(db: D1Database, pubkey: string, micros: number, sig: string, now = Date.now()): Promise<boolean> {
  const amount = Math.floor(Number(micros));
  if (!pubkey || !sig || !Number.isSafeInteger(amount) || amount <= 0) return false;
  try {
    const fresh = await db.prepare(
      `INSERT INTO paid_sigs (sig, pubkey, micros, at) VALUES (?, ?, ?, ?)
       ON CONFLICT(sig) DO NOTHING RETURNING sig`,
    ).bind(sig, pubkey, amount, now).first<{ sig: string }>();
    if (!fresh) return false;
    // One statement, added to what's there, so payments landing at once each
    // count rather than one overwriting the other.
    await db.prepare(
      `INSERT INTO paid (pubkey, micros, last) VALUES (?, ?, ?)
       ON CONFLICT(pubkey) DO UPDATE SET micros = micros + excluded.micros, last = MAX(last, excluded.last)`,
    ).bind(pubkey, amount, now).run();
    return true;
  } catch {
    return false;
  }
}

/** The payment this signature was counted as, if it has been already. */
export async function paidSigKnown(db: D1Database, sig: string): Promise<{ pubkey: string; micros: number } | null> {
  try {
    return await db.prepare("SELECT pubkey, micros FROM paid_sigs WHERE sig = ?").bind(sig).first<{ pubkey: string; micros: number }>();
  } catch {
    return null;
  }
}

/** The most wallets the editor sends in one go. */
export const MAX_PAID_WALLETS = 1000;

/**
 * Totals the artist's editor read from the chain, merged in: each wallet's
 * becomes the larger of the two, never smaller. The chain is the truth, so
 * this heals anything the server missed (a payment made with another app, one
 * sent before this server counted payments); and a reading a little out of
 * date can't undo a payment the server has seen since. Only for wallets this
 * server already has a record of: nothing is kept about anyone else.
 * Returns how many wallets were written.
 */
export async function mergePaid(db: D1Database, totals: Record<string, number>, now = Date.now()): Promise<number> {
  let n = 0;
  for (const [pubkey, micros] of Object.entries(totals)) {
    const amount = Math.floor(Number(micros));
    if (!Number.isSafeInteger(amount) || amount <= 0) continue;
    await db.prepare(
      `INSERT INTO paid (pubkey, micros, last)
         SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM listeners WHERE pubkey = ?)
       ON CONFLICT(pubkey) DO UPDATE SET micros = MAX(micros, excluded.micros), last = MAX(last, excluded.last)`,
    ).bind(pubkey, amount, now, pubkey).run();
    n++;
  }
  return n;
}

/** Auto-block's setting: on, and since when. In settings, as JSON. */
const AUTO_BLOCK = "auto-block";

export interface AutoBlockSetting { enabled: boolean; since: number | null }

export async function autoBlockSetting(db: D1Database): Promise<AutoBlockSetting> {
  try {
    const v = JSON.parse((await setting(db, AUTO_BLOCK)) || "null") as Partial<AutoBlockSetting> | null;
    return v?.enabled === true ? { enabled: true, since: Number(v.since) || null } : { enabled: false, since: null };
  } catch {
    return { enabled: false, since: null };
  }
}

export async function setAutoBlock(db: D1Database, enabled: boolean, now = Date.now()): Promise<AutoBlockSetting> {
  const was = await autoBlockSetting(db);
  const next = enabled ? { enabled: true, since: was.enabled ? was.since ?? now : now } : { enabled: false, since: null };
  await putSetting(db, AUTO_BLOCK, JSON.stringify(next));
  return next;
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
const KEEP_FOR = 365 * 86400_000;

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
  await forgetOwed(db);
}

/** When pruneStale last ran from listening (pruneHourly), in settings. */
const PRUNED_AT = "pruned-at";
const PRUNE_EVERY = 3_600_000;

/** A wallet's ledger: what its listening cost (owed) beside its record, for
 *  Auto-block. Nothing for a database from before the owed table. */
export async function owedRowOf(db: D1Database, pubkey: string): Promise<{ owed_micros: number; owed_seconds: number } | null> {
  try {
    const row = await db.prepare("SELECT micros, seconds FROM owed WHERE pubkey = ?").bind(pubkey).first<{ micros: number; seconds: number }>();
    return row ? { owed_micros: Number(row.micros) || 0, owed_seconds: Number(row.seconds) || 0 } : null;
  } catch {
    return null;
  }
}

/**
 * pruneStale, at most once an hour. Plays call this now and then, and the
 * owed clean-up reads the whole table, so a burst of plays mustn't run it
 * again and again: the time it last ran is kept in settings, and under an
 * hour since, it does nothing. Returns whether it ran.
 */
export async function pruneHourly(db: D1Database, now = Date.now()): Promise<boolean> {
  const last = Number(await setting(db, PRUNED_AT).catch(() => null)) || 0;
  // A time in the future (a clock that jumped) doesn't stop it for ever.
  if (last <= now && now - last < PRUNE_EVERY) return false;
  await putSetting(db, PRUNED_AT, String(now));
  await pruneStale(db, now);
  return true;
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
  await forgetOwed(db, pubkey);
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

const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);   // UTC, as Cloudflare's limits reset

/** One more finished play of a song, by nobody in particular, and of today. */
export async function heard(db: D1Database, track: string, seconds: number, now = Date.now()): Promise<void> {
  const clean = Math.max(0, Math.min(Math.round(seconds), 3600));
  await db.prepare(
    `INSERT INTO track_plays (track, plays, seconds) VALUES (?, 1, ?)
     ON CONFLICT(track) DO UPDATE SET plays = plays + 1, seconds = seconds + excluded.seconds`,
  ).bind(track, clean).run();
  try {
    await db.prepare(
      `INSERT INTO play_days (day, plays) VALUES (?, 1)
       ON CONFLICT(day) DO UPDATE SET plays = plays + 1`,
    ).bind(dayOf(now)).run();
    if (Math.random() < 0.01) {
      await db.prepare("DELETE FROM play_days WHERE day < ?").bind(dayOf(now - 30 * 86_400_000)).run();
    }
  } catch { /* a database from before play_days: counted per song all the same */ }
}

/** Songs played today (UTC). Nothing on a database from before play_days. */
export async function playsToday(db: D1Database, now = Date.now()): Promise<number> {
  try {
    const row = await db.prepare("SELECT plays FROM play_days WHERE day = ?").bind(dayOf(now)).first<{ plays: number }>();
    return row?.plays ?? 0;
  } catch {
    return 0;
  }
}

/** Every song's totals, most played first. Empty on a database built before
 *  the table existed. */
export async function songTotals(db: D1Database): Promise<{ track: string; plays: number; seconds: number }[]> {
  try {
    const r = await db.prepare("SELECT track, plays, seconds FROM track_plays ORDER BY plays DESC LIMIT 500").all<{ track: string; plays: number; seconds: number }>();
    return r.results || [];
  } catch {
    return [];
  }
}
