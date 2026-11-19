/**
 * Metering: what the node itself saw it send, so listening is paid for even
 * when the listener's app doesn't say it happened.
 *
 * What a wallet owes used to grow only when its app reported a play
 * (/listen/played). A pass lets its holder fetch any paid track for half an
 * hour, so an app changed to skip the reports could take the whole catalogue
 * for nothing, and Auto-block would never see it. So the node counts the
 * audio it sends to each wallet, per track and per UTC day (store.ts,
 * `served`), as seconds: bytes over the file's size, times the track's
 * duration.
 *
 * **What's billed is this server's own count, never the app's word.** The
 * artist doesn't rely on the listener's reports for what they're owed, just
 * as the listener's app pays only what it measured itself (app/src/paying.js).
 * Each side keeps its own books. Here, for each (wallet, track, day):
 *
 *     billed = what was sent, less SLACK
 *
 * as it's sent (store.ts, billSent), at the price then.
 *
 * **Paid audio is paced** so that what was sent tracks what was heard: no
 * more than PACE.burst seconds ahead at first, then PACE.rate times as fast
 * as it plays. A browser reads ahead as far as it's allowed, so without this
 * a song skipped ten seconds in would have been sent whole. With it, what's
 * sent by the time a listener stops is at most the burst plus a quarter more
 * than they played, and SLACK is sized so that, less SLACK, it is never more
 * than they played (see PACE). A copier gets the files no faster than about
 * real time, and pays for them less the slack.
 *
 * **Writes are few.** The artist's database has a daily allowance shared
 * with everything else (limits.ts), and audio arrives in many ranged
 * requests. So what's sent is added up here, in this copy of the Worker, and
 * written in one transaction (a "flush") only once enough has built up; see
 * FLUSH. A typical play is a few writes for the audio and one for the app's
 * report of the play (a play for the artist's record, never money).
 *
 * Nothing here may fail a request: every error is swallowed and the listener
 * gets their audio. Nothing is logged.
 */
import { addServed, billSent, inOneGo, servedDay, type ServedKey } from "./store";

/**
 * What of each track sent isn't billed, in seconds of audio: 60 seconds, or
 * 35% of the track, whichever is more (70 s: the 30 s burst and 1.25 x 30 s
 * more, so a skip before a play counts in the app is never billed here). With
 * the pacing below, a listener who
 * starts a song and plays it without pausing, stopping at any point, has
 * been sent at most PACE.burst + PACE.rate x what they played; less this,
 * that is never more than they played, for a track of any length (the worst
 * case, stopping just as the whole file has gone, is 24 - 0.15 x length
 * seconds, below zero from 160 s; under 160 s the 70 s floor covers it).
 * Starting it again the same day adds only PACE.restart up front, and a
 * paused song isn't downloaded by the app; a listener who restarts one song
 * many times a day can still be counted a little over (each start's 3 s,
 * and a quarter of what they played on top), which the slack covers for a
 * handful of starts.
 */
export const SLACK = { seconds: 70, share: 0.35 } as const;
export const slackFor = (trackSeconds: number) => Math.max(SLACK.seconds, SLACK.share * trackSeconds);

/**
 * The most that counts as sent for one track to one wallet in a day: three
 * times its length. Bytes sent are counted even when they were sent before
 * (seeking back re-fetches, and a re-fetch is what a copier would do too),
 * but a listener seeking around one song all evening mustn't be billed for it
 * many times over. Past three plays' worth, nothing more is counted that day.
 * It also bounds how many writes one track can cause (FLUSH).
 */
export const DELIVERED_CAP = 3;

/**
 * How fast paid audio goes to a wallet, per track: a burst of 30 seconds'
 * worth the first time the track is sent to it that day (enough to begin
 * playing, and to seek within), then 1.25 seconds of audio per second.
 * Faster than anyone listens, so playback never waits once started; slow
 * enough that what's sent follows what's heard. Any later start that day —
 * the song again, a seek, a request landing on another copy of the Worker —
 * gets only `restart` seconds up front, so the one SLACK a day covers one
 * burst, not one per start. Whether it was sent already today is read from
 * the database (store.ts `served`), not this copy's memory.
 *
 * The listener's app does its part for its own sake: it stops downloading
 * while paused (app/src/player.js), since a browser left to itself would go
 * on reading a paused song, and this server can't tell that from listening.
 */
export const PACE = { burst: 30, restart: 3, rate: 1.25 } as const;

/** The clock and the wait the pacing uses: stood in for by tests. */
export const paceHooks = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
};

interface Bucket { tokens: number; at: number; queue: Promise<void> }
const buckets = new Map<string, Bucket>();

/**
 * Wait until `seconds` of audio may go to this wallet for this track. One at
 * a time per wallet and track, so two requests share the allowance. `fresh`:
 * the track hasn't been sent to this wallet today, so it gets the burst;
 * otherwise only the restart allowance. Idle time refills up to the restart
 * allowance, never back to a burst.
 */
function paced(id: string, seconds: number, fresh: boolean): Promise<void> {
  let b = buckets.get(id);
  if (!b) {
    if (buckets.size >= MAX_KEYS) buckets.delete(buckets.keys().next().value as string);
    b = { tokens: fresh ? PACE.burst : PACE.restart, at: paceHooks.now(), queue: Promise.resolve() };
    buckets.set(id, b);
  }
  const bucket = b;
  const turn = bucket.queue.then(async () => {
    const now = paceHooks.now();
    const refilled = bucket.tokens + ((now - bucket.at) / 1000) * PACE.rate;
    bucket.tokens = bucket.tokens >= PACE.restart ? Math.min(bucket.tokens, Math.max(PACE.restart, refilled)) : Math.min(PACE.restart, refilled);
    bucket.at = now;
    if (bucket.tokens < seconds) {
      const wait = ((seconds - bucket.tokens) / PACE.rate) * 1000;
      await paceHooks.sleep(wait);
      bucket.at = paceHooks.now();
      bucket.tokens = 0;
    } else {
      bucket.tokens -= seconds;
    }
  });
  bucket.queue = turn.catch(() => {});
  return turn;
}

/**
 * Seconds per byte when the manifest gives no duration (the validator
 * requires one, so this is a fallback): the bitrate the editor encodes its
 * streaming copies at, 256 kbps (manage/src/stream-copy.js, STREAM_KBPS). A
 * file at a lower bitrate is then counted as shorter than it is, which errs
 * the listener's way.
 */
export const FALLBACK_BYTES_PER_SECOND = (256 * 1000) / 8;

/**
 * When what's built up is written: when each response ends, but at most
 * once every FLUSH.gapMs for one (wallet, track, day) — one that comes due
 * sooner is written when the gap is up, in the background, with whatever
 * else came meanwhile. So a whole-file request is one write, and many small
 * ranged requests share a few. Nothing waits for the app to report anything.
 * What's lost if this copy of the Worker is stopped (Cloudflare does that
 * whenever it likes) is at most what came in the last gap: counted short,
 * the listener's way.
 */
export const FLUSH = { gapMs: 3_000 } as const;

/** How many (wallet, track, day) this copy keeps count of at once. The oldest
 *  goes first, written if it holds a second or more. */
const MAX_KEYS = 2_000;

interface Tally {
  key: ServedKey;
  /** Seconds sent and not yet written. */
  pending: number;
  /** What those seconds cost at the price when each was sent (micros), and
   *  how many of them had a known price then: billed at that price, not at
   *  whatever it is when they're written. */
  pendingMicros: number;
  pendingPriced: number;
  /** Seconds this copy has written for it: past the cap, nothing more is kept. */
  written: number;
  trackSeconds: number;
  lastFlush: number;
  /** A write is waiting out FLUSH.gapMs. */
  waiting: boolean;
}
const tallies = new Map<string, Tally>();
const idOf = (k: ServedKey) => `${k.pubkey}|${k.track}|${k.day}`;

/** What metering needs to write: the database, the price now for a wallet
 *  (dollars a minute, 0 while it's free to them), and somewhere to put work
 *  that outlives the response (ctx.waitUntil). */
export interface MeterDeps {
  db: D1Database;
  perMinute: (pubkey: string) => Promise<number>;
  later: (p: Promise<unknown>) => void;
  /** Writes, counted (tests). */
  onFlush?: () => void;
  /** Now and then after a write: clear out what's past keeping (pruneHourly). */
  tidy?: () => Promise<unknown>;
}

/** Seconds of audio in `bytes` of a file of `size` bytes, of a track
 *  `duration` seconds long (or unknown). */
export function secondsOf(bytes: number, size: number, duration: number | null): number {
  if (!(bytes > 0)) return 0;
  if (duration && duration > 0 && size > 0) return (bytes / size) * duration;
  return bytes / FALLBACK_BYTES_PER_SECOND;
}

/** The track's length for slack and thresholds: as published, or from its size. */
export const lengthOf = (size: number, duration: number | null) =>
  duration && duration > 0 ? duration : size / FALLBACK_BYTES_PER_SECOND;

/**
 * Count a response's body as it is sent: bytes are added to this wallet's
 * tally as the listener's connection takes them, so a request the browser
 * abandons after a few seconds counts a few seconds, not the whole range it
 * asked for. When the body ends (or is abandoned), the tally is written if
 * it's due. Returns the body to send instead.
 */
export function metered(
  body: ReadableStream<Uint8Array>,
  length: number | null,
  t: {
    pubkey: string; track: string; size: number; duration: number | null; now?: number;
    /** Whether this track has gone to this wallet already today, as the
     *  database says. Read once, on the first piece; if it can't be read,
     *  taken as yes (no burst). */
    sentToday?: () => Promise<boolean>;
    /** Note in the database that it has been sent today (sentToday). */
    markSent?: () => Promise<unknown>;
  },
  deps: MeterDeps,
): ReadableStream<Uint8Array> {
  const key: ServedKey = { pubkey: t.pubkey, track: t.track, day: servedDay(t.now ?? Date.now()) };
  const trackSeconds = lengthOf(t.size, t.duration);
  const pace = `${t.pubkey}|${t.track}`;
  let fresh: Promise<boolean> | null = null;
  const isFresh = () => (fresh ??= tallies.has(idOf(key)) || buckets.has(pace)
    ? Promise.resolve(false)
    : (t.sentToday ? t.sentToday().then((sent) => !sent, () => false) : Promise.resolve(true)));
  let bytes = 0, ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    const seconds = secondsOf(bytes, t.size, t.duration);
    if (!(seconds > 0)) return;
    // Priced as it was sent. Free to this wallet then (a subscriber, payments
    // paused): not counted at all. Price unknown: counted, priced when written.
    deps.later(deps.perMinute(t.pubkey).then((p) => p, () => null).then((perMinute) => {
      if (perMinute === 0) return;
      try { add(key, seconds, trackSeconds, deps, Date.now(), perMinute); } catch { /* never the listener's problem */ }
    }));
  };
  const reader = body.getReader();
  const counting = new ReadableStream<Uint8Array>({
    async pull(c) {
      try {
        const { done, value } = await reader.read();
        if (done) { c.close(); end(); return; }
        // Not sent until it may be (PACE): what's sent follows what's heard.
        const first = bytes === 0, freshNow = await isFresh();
        // The first piece of a fresh start: the row is made now, so another
        // copy of the Worker asked for the same song sees it was sent today.
        if (first && freshNow && t.markSent) {
          const mark = t.markSent;
          // Only where it costs something: what's free to a wallet isn't recorded at all.
          deps.later(deps.perMinute(t.pubkey).then((p) => (p > 0 ? mark() : null)).catch(() => {}));
        }
        await paced(pace, secondsOf(value.byteLength, t.size, t.duration), freshNow);
        bytes += value.byteLength;
        c.enqueue(value);
      } catch (e) {
        end();
        c.error(e);
      }
    },
    cancel(reason) {
      end();
      return reader.cancel(reason).catch(() => {});
    },
  });
  // On Cloudflare, a stream of known length keeps its Content-Length (which
  // players rely on to seek); FixedLengthStream is how to say it.
  const Fixed = (globalThis as { FixedLengthStream?: new (n: number) => TransformStream<Uint8Array, Uint8Array> }).FixedLengthStream;
  if (Fixed && length !== null && length >= 0) {
    const { readable, writable } = new Fixed(length);
    counting.pipeTo(writable).catch(() => {});
    return readable;
  }
  return counting;
}

/** Add seconds sent to a tally, and write it if it's due. */
export function add(
  key: ServedKey, seconds: number, trackSeconds: number, deps: MeterDeps, now = Date.now(), perMinute: number | null = null,
): void {
  if (!(seconds > 0)) return;
  const id = idOf(key);
  let t = tallies.get(id);
  if (!t) {
    if (tallies.size >= MAX_KEYS) evictOldest(deps);
    t = { key, pending: 0, pendingMicros: 0, pendingPriced: 0, written: 0, trackSeconds, lastFlush: 0, waiting: false };
    tallies.set(id, t);
  }
  const cap = DELIVERED_CAP * trackSeconds;
  // Past the cap nothing more can count, so nothing more is kept or written.
  const counted = Math.max(0, Math.min(seconds, cap - t.written - t.pending));
  if (!(counted > 0)) return;
  t.pending += counted;
  if (perMinute !== null && perMinute > 0) {
    t.pendingMicros += (counted / 60) * perMinute * 1_000_000;
    t.pendingPriced += counted;
  }
  // Written soon, whatever else happens, so what was sent never waits on a
  // report; writes for one track come at most every FLUSH.gapMs, so many
  // small requests share one.
  due(t, deps, now);
}

function due(t: Tally, deps: MeterDeps, now: number): void {
  if (t.waiting) return;
  const wait = t.lastFlush + FLUSH.gapMs - now;
  if (wait <= 0) { deps.later(flush(t, deps)); return; }
  t.waiting = true;
  deps.later(new Promise((r) => setTimeout(r, wait)).then(() => { t.waiting = false; return flush(t, deps); }));
}

function evictOldest(deps: MeterDeps): void {
  const [id, t] = tallies.entries().next().value as [string, Tally];
  tallies.delete(id);
  if (t.pending >= 1 && !t.waiting) deps.later(flush(t, deps));
}

/** Write what's built up for one tally: one batch (one transaction). */
async function flush(t: Tally, deps: MeterDeps): Promise<void> {
  const seconds = t.pending;
  if (!(seconds > 0)) return;
  const micros = t.pendingMicros, priced = t.pendingPriced;
  t.pending = 0; t.pendingMicros = 0; t.pendingPriced = 0;
  t.lastFlush = Date.now();
  t.written += seconds;
  try {
    // At the price they were sent at (free ones were never counted). Any
    // whose price wasn't known then: at the price now, or, if that can't be
    // read either, written and billed with a later write.
    let perMinute: number | null;
    if (priced >= seconds) perMinute = (micros / priced) * 60 / 1_000_000;
    else {
      const now = await deps.perMinute(t.key.pubkey).then((p) => p, () => null);
      perMinute = now === null ? null : (micros + ((seconds - priced) / 60) * now * 1_000_000) / seconds * 60 / 1_000_000;
    }
    deps.onFlush?.();
    await inOneGo(deps.db, [
      addServed(deps.db, t.key, { delivered: seconds, cap: DELIVERED_CAP * t.trackSeconds }),
      ...(perMinute === null || !(perMinute > 0) ? [] : billSent(deps.db, t.key, { slack: slackFor(t.trackSeconds), perMinute })),
    ]);
    if (deps.tidy && Math.random() < 0.02) await deps.tidy();
  } catch {
    // No `served` table (metering is off there), or the database is busy:
    // these seconds are lost, which errs the listener's way.
  }
}

/** A wallet asked to be forgotten, or was removed: nothing counted for it
 *  here is written afterwards (another copy of the Worker may still write
 *  the few seconds it holds, which the next prune or erase removes). */
export function forgetTallies(pubkey: string): void {
  for (const [id, t] of tallies) if (t.key.pubkey === pubkey) { t.pending = 0; tallies.delete(id); }
}

/** For tests: start again with nothing counted. */
export function resetTallies(): void { tallies.clear(); buckets.clear(); }
