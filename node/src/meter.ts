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
 * What of each track sent isn't billed, in seconds of audio: 70 seconds, or
 * 35% of the track, whichever is more (70 s: the 30 s burst and 1.25 x 30 s
 * more, so a skip before a play counts in the app is never billed here). With
 * the pacing below, a listener who
 * starts a song and plays it without pausing, stopping at any point, has
 * been sent at most PACE.burst + PACE.rate x what they played; less this,
 * that is never more than they played, for a track of any length (the worst
 * case, stopping just as the whole file has gone, is 24 - 0.15 x length
 * seconds, below zero from 160 s; under 160 s the 70 s floor covers it).
 * Bytes this copy has already counted aren't counted again (newBytes), so
 * picking a paused song up again — the app asks afresh from where it was —
 * adds only what's new, and so does starting it again from the top and
 * skipping it before it counts (REPLAY_AFTER_S).
 *
 * Where it can still bill a little more than was heard, and doesn't try to
 * tell: a player that keeps downloading while paused is paced like one
 * playing (1.25 s of audio a second, never past the song's end). The
 * listener's app stops downloading 1.5 s into a pause, 10 s on the lock
 * screen (app/src/player.js), which the slack covers; another app or browser
 * may not. And requests that land on different copies of the Worker are
 * each counted, which the slack covers for a handful of starts.
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
 * the database (store.ts `served`), not this copy's memory, and the row is
 * made before a burst is given; two copies starting the same song in the
 * same instant can still both give one.
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
  /** The wait before a write that came due inside FLUSH.gapMs. */
  gap: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
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
 * When what's built up is written: as it's sent, but at most once every
 * FLUSH.gapMs (30 s) for one (wallet, track, day) — what comes sooner is
 * written when the gap is up, in the background, with whatever else came
 * meanwhile. So a four-minute song paced out over three minutes is about
 * eight writes, and many small ranged requests share them. The artist's
 * database has a daily allowance of writes shared with everything else
 * (100,000 on Cloudflare's free plan). Nothing waits for the app to report
 * anything. What's lost if this copy of the Worker is stopped (Cloudflare
 * does that whenever it likes) is at most what came in the last gap:
 * counted short, the listener's way.
 */
export const FLUSH = { gapMs: 30_000 } as const;

/** How often a long response reads the wallet's price again (see metered). */
export const PRICE_EVERY_MS = 5_000;

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

/**
 * Which bytes of each file this copy has already counted, per (wallet,
 * track, day), as sorted spans [from, to). A player that stops its download
 * while paused (app/src/player.js) asks again from where it was on play, and
 * the bytes it had read ahead come again: counted once, here. So do bytes
 * fetched again after seeking back within a play. A request from the file's
 * first byte that reads on past REPLAY_AFTER_S is a new play (the song
 * again), and counts afresh (startOver). Kept apart from the tallies, which an
 * erase drops: the bytes were still sent.
 *
 * In this copy's memory only: another copy of the Worker counts what it
 * sends afresh, which DELIVERED_CAP bounds. At most MAX_SPANS a key; past
 * that, the two spans closest together become one, the bytes between them
 * taken as counted (the listener's way).
 */
const covered = new Map<string, number[][]>();
const MAX_SPANS = 64;

/**
 * How far a request from a file's start reads before it's a new play: 45 s
 * of audio. Past the 30 s a play needs to count (spec/pricing.mjs), with what
 * the pacing lets a player read ahead by then (PACE.restart + 1.25 x 30 s is
 * 40.5 s). So the song played again and skipped before it counts is never
 * billed again; played on, it's billed again in full. And a player picking a
 * paused song back up, which reads the start for its headers before it jumps
 * to where it was, isn't taken for a replay.
 */
export const REPLAY_AFTER_S = 45;

/** A new play of this file from its start: nothing of it counted yet. */
function startOver(id: string): void { covered.delete(id); }

/** How many of the bytes [from, to) of this file haven't been counted here
 *  yet for this key; and they are now. */
export function newBytes(id: string, from: number, to: number): number {
  if (!(to > from)) return 0;
  let spans = covered.get(id);
  if (!spans) {
    if (covered.size >= MAX_KEYS) covered.delete(covered.keys().next().value as string);
    spans = [];
    covered.set(id, spans);
  }
  let seen = 0;
  for (const [a, b] of spans) seen += Math.max(0, Math.min(b, to) - Math.max(a, from));
  // Merge [from, to) in.
  const merged: number[][] = [];
  let lo = from, hi = to, placed = false;
  for (const [a, b] of spans) {
    if (b < lo) merged.push([a, b]);
    else if (a > hi) { if (!placed) { merged.push([lo, hi]); placed = true; } merged.push([a, b]); }
    else { lo = Math.min(lo, a); hi = Math.max(hi, b); }
  }
  if (!placed) merged.push([lo, hi]);
  while (merged.length > MAX_SPANS) {
    let k = 0;
    for (let i = 1; i < merged.length - 1; i++) if (merged[i + 1][0] - merged[i][1] < merged[k + 1][0] - merged[k][1]) k = i;
    merged.splice(k, 2, [merged[k][0], merged[k + 1][1]]);
  }
  covered.set(id, merged);
  return to - from - seen;
}

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
 * Count a response's body as it is sent: each piece is added to this
 * wallet's tally as the listener's connection takes it, at the price then,
 * so a request the browser abandons after a few seconds counts a few
 * seconds, not the whole range it asked for. Returns the body to send instead.
 */
export function metered(
  body: ReadableStream<Uint8Array>,
  length: number | null,
  t: {
    pubkey: string; track: string; size: number; duration: number | null; now?: number;
    /** Where in the file the body starts (a range's first byte). */
    start?: number;
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
  let ended = false;
  // The price for this wallet, read on the first piece and again every
  // PRICE_EVERY_MS: each piece is counted at the price when it was sent, and a
  // piece sent while it was free (a subscriber, payments paused) isn't
  // counted at all. Unknown (couldn't be read): counted, priced when written.
  let price: number | null = null, priceAt = -Infinity;
  const priceNow = async () => {
    const now = paceHooks.now();
    if (now - priceAt >= PRICE_EVERY_MS) {
      price = await deps.perMinute(t.pubkey).then((p) => p, () => null);
      priceAt = now;
    }
    return price;
  };
  let first = true;
  // Where in the file the next piece is: bytes counted already aren't again.
  let at = Number.isFinite(t.start) && (t.start as number) >= 0 ? (t.start as number) : 0;
  let fromStart = at === 0, skipped = 0;
  const replayAt = REPLAY_AFTER_S * (t.duration && t.duration > 0 && t.size > 0 ? t.size / t.duration : FALLBACK_BYTES_PER_SECOND);
  const end = () => { ended = true; };
  const reader = body.getReader();
  const counting = new ReadableStream<Uint8Array>({
    async pull(c) {
      try {
        const { done, value } = await reader.read();
        if (done) { c.close(); end(); return; }
        const perMinute = await priceNow();
        const freshNow = await isFresh();
        // The first piece of a fresh start, where it costs something: its row
        // is made before the burst is given, so another copy of the Worker
        // asked for the same song sees it was sent today.
        if (first && freshNow && perMinute !== 0 && t.markSent) await t.markSent().catch(() => {});
        first = false;
        // Not sent until it may be (PACE): what's sent follows what's heard.
        const seconds = secondsOf(value.byteLength, t.size, t.duration);
        await paced(pace, seconds, freshNow);
        c.enqueue(value);
        const from = at;
        at += value.byteLength;
        if (perMinute !== 0) {
          try {
            let fresh = newBytes(idOf(key), from, at);
            // From the file's first byte: perhaps a new play (the song again).
            // Perhaps not: a player picking a paused song back up reads the
            // start for its headers, then jumps to where it was. So it counts
            // as a new play only once it has read REPLAY_AFTER_S on from the
            // start without stopping; then what it had sent of it counts too.
            if (fromStart) {
              skipped += (at - from) - fresh;
              if (at >= replayAt) {
                fromStart = false;
                startOver(idOf(key));
                newBytes(idOf(key), 0, at);
                fresh += skipped;
              }
            }
            add(key, secondsOf(fresh, t.size, t.duration), trackSeconds, deps, Date.now(), perMinute);
          } catch { /* never the listener's problem */ }
        }
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
  deps.later(paceHooks.gap(wait).then(() => { t.waiting = false; return flush(t, deps); }));
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

/**
 * A wallet asked to be forgotten, or was removed: what this copy has counted
 * for it and not yet written is written now, before the erase, and its
 * tallies dropped. Written, not dropped: the audio was sent, and the bytes
 * stay counted (newBytes), so dropping them would let a wallet erase every
 * few seconds and never be billed. Another copy of the Worker writes what it
 * holds on its own schedule.
 */
export async function flushTallies(pubkey: string, deps: MeterDeps): Promise<void> {
  const mine = [...tallies.entries()].filter(([, t]) => t.key.pubkey === pubkey);
  for (const [id, t] of mine) {
    tallies.delete(id);
    await flush(t, deps);
  }
}

/** The artist removed a wallet's record: what this copy counted for it and
 *  hadn't written is dropped, as theirs to give up. */
export function forgetTallies(pubkey: string): void {
  for (const [id, t] of tallies) if (t.key.pubkey === pubkey) { t.pending = 0; tallies.delete(id); }
}

/** For tests: start again with nothing counted. */
export function resetTallies(): void { tallies.clear(); buckets.clear(); covered.clear(); }

/** For tests: as another copy of the Worker would be, knowing no bytes sent. */
export function resetCovered(): void { covered.clear(); }
