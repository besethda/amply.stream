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
 * One exception, kept as small as it can be: `served`, how many seconds of
 * each paid track were sent to each wallet on each day (meter.ts). Without it
 * an app that never reports its listening would listen for nothing. It holds
 * no times, only the day, and is deleted after three days (pruneStale).
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
  // How much of each paid track this server sent each wallet, per UTC day, in
  // seconds of audio (meter.ts): `delivered` worked out from the bytes it
  // served, `reported` what the listener's app said it played (/listen/played),
  // and `billed` how much of the two has been added to `owed` already. So
  // listening is paid for even by an app that never reports it. The one place
  // a track is kept beside a wallet, and only for three days (pruneStale).
  // Beside the other tables, so nothing existing changes; without it, metering
  // is simply off.
  `CREATE TABLE IF NOT EXISTS served (
     pubkey TEXT NOT NULL,
     track TEXT NOT NULL,
     day INTEGER NOT NULL,
     delivered REAL NOT NULL DEFAULT 0,
     reported REAL NOT NULL DEFAULT 0,
     billed REAL NOT NULL DEFAULT 0,
     PRIMARY KEY (pubkey, track, day)
   ) WITHOUT ROWID`,
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
  // What was sent to this wallet in the last three days goes too. Not swept
  // with the others below: a wallet whose listening hasn't cost anything yet
  // (still within the metering's slack) has rows here and no record in
  // listeners, and those rows are what lets it be charged. They go by age
  // instead (pruneStale).
  if (pubkey) {
    try { await db.prepare("DELETE FROM served WHERE pubkey = ?").bind(pubkey).run(); } catch { /* no such table yet */ }
  }
}

// ── what was sent, metered (meter.ts) ──────────────────────────────────────

/** How many days of `served` are kept: today and the two before it. Long
 *  enough for a play that runs past midnight, or a report that arrives late,
 *  to find the row it belongs with; short enough to be no history. */
export const SERVED_KEEP_DAYS = 3;

/** A UTC day as a whole number (days since 1970), as `served.day` holds it. */
export const servedDay = (now = Date.now()) => Math.floor(now / 86_400_000);

/** Who and what one `served` row is about. */
export interface ServedKey { pubkey: string; track: string; day: number }

/**
 * Bring a `served` row's billing up to date from what the listener's app
 * reported, as statements to run after the one that changed it, in the same
 * batch (one transaction).
 *
 * **Only the report is billed here.** What the node sent is not: a browser
 * reads ahead, and a song skipped ten seconds in may already be mostly
 * downloaded, so bytes sent say nothing about what was heard. A wallet whose
 * app reports is billed exactly what it reported. What was sent counts only
 * for a wallet that reported nothing at all that day, and only after a day's
 * grace (billUnreported, below).
 *
 * Whatever of the report hasn't been billed yet is added to `owed` exactly as
 * a reported play always was (counted(), below: the same upsert, priced at
 * `perMinute` now), and to the wallet's totals in `listeners`. `plays` is 1
 * for a report from the app. Then `billed` catches up. Written so nothing is
 * written when nothing is due.
 */
export function billServed(
  db: D1Database, k: ServedKey, { perMinute, plays = 0, now = Date.now() }: { perMinute: number; plays?: number; now?: number },
): D1PreparedStatement[] {
  // The mark a report leaves (REPORT_MARK) is a fraction of a second: whole seconds only.
  const B = "CAST(reported AS INTEGER)";
  const row = "pubkey = ?1 AND track = ?2 AND day = ?3";
  const perSecond = perMinute > 0 ? (perMinute * 1_000_000) / 60 : 0;
  return [
    db.prepare(
      `INSERT INTO owed (pubkey, micros, seconds)
         SELECT pubkey, CAST(ROUND((${B} - billed) * ?4) AS INTEGER), ${B} - billed FROM served
          WHERE ${row} AND ${B} > billed
       ON CONFLICT(pubkey) DO UPDATE SET micros = micros + excluded.micros, seconds = seconds + excluded.seconds`,
    ).bind(k.pubkey, k.track, k.day, perSecond),
    db.prepare(
      `INSERT INTO listeners (pubkey, plays, seconds, first_seen, last_seen)
         SELECT pubkey, ?4, MAX(0, ${B} - billed), ?5, ?5 FROM served
          WHERE ${row} AND (${B} > billed OR ?4 > 0)
       ON CONFLICT(pubkey) DO UPDATE SET
         plays = plays + excluded.plays, seconds = seconds + excluded.seconds, last_seen = excluded.last_seen`,
    ).bind(k.pubkey, k.track, k.day, plays, now),
    db.prepare(`UPDATE served SET billed = ${B} WHERE ${row} AND ${B} > billed`)
      .bind(k.pubkey, k.track, k.day),
  ];
}

/**
 * Added to `reported` by every report, whatever its seconds, so that "this
 * wallet's app reported this track" is known even for a song skipped at 0 s.
 * A ten-thousandth of a second: billing counts whole seconds, and a day has
 * far fewer reports than it would take to make one.
 */
export const REPORT_MARK = 0.0001;

/**
 * How long after a UTC day ends what was sent that day, unreported, may be
 * billed: thirty hours. A report can arrive late — a play that ran past
 * midnight, or one the app couldn't send and sends again, which it does for
 * up to a day (app/src/identify.js, REPORT_KEEP_MS) — and the reported row is
 * the one that's billed, so every late report lands before this. Still inside
 * SERVED_KEEP_DAYS, so rows are billed before they're pruned.
 */
export const UNREPORTED_GRACE_MS = 30 * 3_600_000;

/** The last UTC day whose unreported sends may be billed at `now`. */
export const lastBillableDay = (now = Date.now()) => servedDay(now - UNREPORTED_GRACE_MS) - 1;

/**
 * Bill what was sent to wallets that reported nothing at all.
 *
 * The one case metering is for: an app that takes paid audio and never says
 * it played anything (a copier). For a wallet that has never reported a play
 * here, each UTC day that ended at least UNREPORTED_GRACE_MS ago with no
 * report of any kind has every track sent billed at what was sent less the
 * slack (meter.ts), once.
 *
 * A wallet whose app has ever reported a play (`listeners.plays`), or that
 * reported anything that day — even a single song, even 0 s — is billed only
 * what it reports. So an honest listener whose report is lost (an app closed
 * mid-song, a rate limit, a dropped connection, a phone that killed the app)
 * is never billed for what their browser read ahead.
 *
 * Nothing is billed while the wallet's price is 0 (a subscriber, or payments
 * paused): it waits, and what was sent while it was free was never counted
 * (meter.ts). `slackOf(track)` is the allowance for a track (Infinity for one
 * no longer published: its length can't be known, so nothing is billed for
 * it); `perMinute(pubkey)` the price for that wallet now. `pubkey` limits it
 * to one wallet (its pass being asked for).
 *
 * Safe to run twice at once (a pass asked for while the hourly prune runs):
 * each track's increment is worked out inside its own transaction from the
 * row as it stands, so a second run finds it billed and adds nothing.
 */
export async function billUnreported(
  db: D1Database,
  { slackOf, perMinute, pubkey = null, now = Date.now() }:
    { slackOf: (track: string) => number; perMinute: (pubkey: string) => Promise<number>; pubkey?: string | null; now?: number },
): Promise<number> {
  const last = lastBillableDay(now);
  const { results } = await db.prepare(
    `SELECT pubkey, day FROM served WHERE day <= ?1 ${pubkey ? "AND pubkey = ?2" : ""}
        AND pubkey NOT IN (SELECT pubkey FROM listeners WHERE plays > 0)
      GROUP BY pubkey, day HAVING MAX(reported) = 0 AND SUM(delivered) > SUM(billed)`,
  ).bind(...(pubkey ? [last, pubkey] : [last])).all<{ pubkey: string; day: number }>();
  let rows = 0;
  for (const g of results || []) {
    const rate = await perMinute(String(g.pubkey)).catch(() => 0);
    if (!(rate > 0)) continue;
    const perSecond = (rate * 1_000_000) / 60;
    const { results: tracks } = await db.prepare(
      "SELECT track, delivered FROM served WHERE pubkey = ? AND day = ? AND reported = 0 AND delivered > billed",
    ).bind(g.pubkey, g.day).all<{ track: string; delivered: number }>();
    for (const t of tracks || []) {
      const slack = Math.max(0, Number(slackOf(String(t.track))));
      const due = Math.floor(Math.max(0, Number(t.delivered) - slack));
      if (!Number.isFinite(due) || due <= 0) continue;
      // Read and moved on in one transaction: the increment comes from the
      // row as it is inside it, so a run that got here first leaves nothing.
      const row = "pubkey = ?1 AND track = ?2 AND day = ?3 AND reported = 0 AND billed < ?4";
      await inOneGo(db, [
        db.prepare(
          `INSERT INTO owed (pubkey, micros, seconds)
             SELECT pubkey, CAST(ROUND((?4 - billed) * ?5) AS INTEGER), ?4 - billed FROM served WHERE ${row}
           ON CONFLICT(pubkey) DO UPDATE SET micros = micros + excluded.micros, seconds = seconds + excluded.seconds`,
        ).bind(g.pubkey, t.track, g.day, due, perSecond),
        db.prepare(
          `INSERT INTO listeners (pubkey, plays, seconds, first_seen, last_seen)
             SELECT pubkey, 0, ?4 - billed, ?5, ?5 FROM served WHERE ${row}
           ON CONFLICT(pubkey) DO UPDATE SET seconds = seconds + excluded.seconds`,
        ).bind(g.pubkey, t.track, g.day, due, now),
        db.prepare(`UPDATE served SET billed = ?4 WHERE ${row}`).bind(g.pubkey, t.track, g.day, due),
      ]);
      rows++;
    }
  }
  return rows;
}

/**
 * Add to a `served` row: seconds sent (`delivered`, never past `cap`, see
 * meter.ts) and seconds the app reported (`reported`). A statement, so it can
 * go in one batch with billServed's.
 */
export function addServed(
  db: D1Database, k: ServedKey,
  { delivered = 0, reported = 0, cap, report = false, atLeast = false }:
    { delivered?: number; reported?: number; cap: number; report?: boolean; atLeast?: boolean },
): D1PreparedStatement {
  // A report, of any length, leaves its mark (REPORT_MARK).
  const add = Math.max(0, reported) + (report ? REPORT_MARK : 0);
  // A report sent again (`atLeast`) may have arrived the first time: it
  // raises the row to at least its seconds, never adds to them, so sending
  // it twice — or three times — bills it once.
  const merge = atLeast ? "MAX(reported, excluded.reported)" : "reported + excluded.reported";
  return db.prepare(
    `INSERT INTO served (pubkey, track, day, delivered, reported, billed) VALUES (?1, ?2, ?3, MIN(?4, ?6), ?5, 0)
     ON CONFLICT(pubkey, track, day) DO UPDATE SET
       delivered = MAX(delivered, MIN(?6, delivered + excluded.delivered)),
       reported = ${merge}`,
  ).bind(k.pubkey, k.track, k.day, Math.max(0, delivered), add, Math.max(0, cap));
}

/** Run statements as one transaction: D1's batch. A stand-in database
 *  without batch runs them in turn. */
export async function inOneGo(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  if (typeof (db as { batch?: unknown }).batch === "function") { await db.batch(statements); return; }
  for (const s of statements) await s.run();
}

/** Which row today's (or a late) report for this track belongs to: today's
 *  if there is one, else yesterday's if the track was sent then (a play that
 *  ran past midnight), else today's. Throws without the table. */
export async function servedDayFor(db: D1Database, pubkey: string, track: string, now = Date.now()): Promise<number> {
  const today = servedDay(now);
  const { results } = await db.prepare("SELECT day FROM served WHERE pubkey = ? AND track = ? AND day IN (?, ?)")
    .bind(pubkey, track, today, today - 1).all<{ day: number }>();
  const days = (results || []).map((r) => Number(r.day));
  return days.includes(today) || !days.length ? today : today - 1;
}

/** For a report that doesn't say which track (an app from before it did):
 *  the track sent to this wallet today or yesterday that is furthest ahead of
 *  what was reported for it, which is almost always the one that just ended.
 *  Null when nothing sent is waiting for a report. Throws without the table. */
export async function unreportedServed(db: D1Database, pubkey: string, now = Date.now()): Promise<{ track: string; day: number } | null> {
  const today = servedDay(now);
  const row = await db.prepare(
    `SELECT track, day FROM served WHERE pubkey = ? AND day IN (?, ?) AND track != '' AND delivered > reported
      ORDER BY delivered - reported DESC LIMIT 1`,
  ).bind(pubkey, today, today - 1).first<{ track: string; day: number }>();
  return row ? { track: String(row.track), day: Number(row.day) } : null;
}

/** How many tracks this wallet has rows for (/listen/mine): null without the table. */
export async function servedCount(db: D1Database, pubkey: string): Promise<number | null> {
  try {
    const row = await db.prepare("SELECT COUNT(*) AS n FROM served WHERE pubkey = ?").bind(pubkey).first<{ n: number }>();
    return Number(row?.n) || 0;
  } catch {
    return null;
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
export async function pruneStale(db: D1Database, now = Date.now(), beforeServed: (() => Promise<unknown>) | null = null): Promise<void> {
  await db.prepare("DELETE FROM listeners WHERE blocked = 0 AND last_seen < ?")
    .bind(now - KEEP_FOR).run();
  await forgetOwed(db);
  // What was sent, after three days (SERVED_KEEP_DAYS) — billed first if it's
  // due (billUnreported), so nothing is deleted before it's been looked at.
  // If that couldn't be done (the page couldn't be read), the rows wait for
  // the next prune rather than go unlooked-at.
  if (beforeServed) {
    const looked = await beforeServed().then(() => true, () => false);
    if (!looked) return;
  }
  try {
    await db.prepare("DELETE FROM served WHERE day <= ?").bind(servedDay(now) - SERVED_KEEP_DAYS).run();
  } catch { /* no such table yet */ }
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
export async function pruneHourly(db: D1Database, now = Date.now(), beforeServed: (() => Promise<unknown>) | null = null): Promise<boolean> {
  const last = Number(await setting(db, PRUNED_AT).catch(() => null)) || 0;
  // A time in the future (a clock that jumped) doesn't stop it for ever.
  if (last <= now && now - last < PRUNE_EVERY) return false;
  await putSetting(db, PRUNED_AT, String(now));
  await pruneStale(db, now, beforeServed);
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
