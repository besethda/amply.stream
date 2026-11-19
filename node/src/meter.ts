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
 * **Billing is a hybrid**, so an honest listener isn't charged twice or for
 * what they didn't hear. For each (wallet, track, day):
 *
 *     billable = max(reported, delivered - SLACK)
 *
 * and only the increase since last time is added to what's owed, at the
 * price now. A full listen the app reports as 240 s, with 240 s sent, bills
 * 240 s once (the report). A copy taken whole with nothing reported bills
 * about two thirds of it. A song replayed from the browser's cache isn't
 * sent again, and its report covers it.
 *
 * **Writes are few.** The artist's database has a daily allowance shared
 * with everything else (limits.ts), and audio arrives in many ranged
 * requests. So what's sent is added up here, in this copy of the Worker, and
 * written in one transaction (a "flush") only once enough has built up; see
 * FLUSH. A typical play is one write for the audio and one for the app's
 * report; a whole-file request, one.
 *
 * Nothing here may fail a request: every error is swallowed and the listener
 * gets their audio. Nothing is logged.
 */
import { addServed, billServed, inOneGo, servedDay, type ServedKey } from "./store";

/**
 * How much more than was heard a browser can be sent, in seconds of audio,
 * before the difference is billed: 60 seconds, or 35% of the track, whichever
 * is more.
 *
 * Browsers read ahead: a player buffers well past where it is playing, and a
 * track skipped after half a minute has often been mostly downloaded already.
 * Seeking around re-fetches. Without this allowance, an honest listener who
 * skips would pay for most of a song they barely heard. With it, someone
 * taking whole files without reporting still pays for about two thirds of
 * each, which makes not reporting no bargain, and an honest app's report is
 * almost always the larger number anyway.
 */
export const SLACK = { seconds: 60, share: 0.35 } as const;
export const slackFor = (trackSeconds: number) => Math.max(SLACK.seconds, SLACK.share * trackSeconds);

/**
 * The most that counts as sent for one track to one wallet in a day: three
 * times its length. Bytes sent are counted even when they were sent before
 * (seeking back re-fetches, and a re-fetch is what a copier would do too),
 * but a listener seeking around one song all evening mustn't be billed for it
 * many times over. Past three plays' worth, the app's reports are what count.
 * It also bounds how many writes one track can cause (FLUSH).
 */
export const DELIVERED_CAP = 3;

/**
 * Seconds per byte when the manifest gives no duration (the validator
 * requires one, so this is a fallback): the bitrate the editor encodes its
 * streaming copies at, 256 kbps (manage/src/stream-copy.js, STREAM_KBPS). A
 * file at a lower bitrate is then counted as shorter than it is, which errs
 * the listener's way.
 */
export const FALLBACK_BYTES_PER_SECOND = (256 * 1000) / 8;

/**
 * When what's built up is written:
 *
 * - once it reaches 15% of the track or 20 seconds of audio, whichever is
 *   larger (a single response that big is written when it ends);
 * - at most once every few seconds for one (wallet, track, day); one that
 *   comes due sooner is written when the time is up, in the background;
 * - never past DELIVERED_CAP, which with the size above bounds the writes
 *   for one track and day at about twenty, however the requests are cut up.
 *
 * What's lost if this copy of the Worker is stopped (Cloudflare does that
 * whenever it likes) is what hadn't reached that size yet: under 15% of a
 * track, or 20 seconds, per track. That's well inside SLACK, the app's report
 * covers it for an honest listener, and the next request for the track adds
 * to it anyway. Writing every piece to be sure of those seconds would spend
 * the artist's write allowance many times over.
 */
export const FLUSH = { share: 0.15, seconds: 20, gapMs: 3_000 } as const;
const flushAt = (trackSeconds: number) => Math.max(FLUSH.seconds, FLUSH.share * trackSeconds);

/** How many (wallet, track, day) this copy keeps count of at once. The oldest
 *  goes first, written if it holds a second or more. */
const MAX_KEYS = 2_000;

interface Tally {
  key: ServedKey;
  /** Seconds sent and not yet written. */
  pending: number;
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
  /** Now and then after a write: clear out what's past keeping (pruneHourly),
   *  since a wallet that never reports never reaches /listen/played, where
   *  that otherwise happens. */
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
  t: { pubkey: string; track: string; size: number; duration: number | null; now?: number },
  deps: MeterDeps,
): ReadableStream<Uint8Array> {
  const key: ServedKey = { pubkey: t.pubkey, track: t.track, day: servedDay(t.now ?? Date.now()) };
  const trackSeconds = lengthOf(t.size, t.duration);
  let bytes = 0, ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    try { add(key, secondsOf(bytes, t.size, t.duration), trackSeconds, deps); } catch { /* never the listener's problem */ }
  };
  const reader = body.getReader();
  const counting = new ReadableStream<Uint8Array>({
    async pull(c) {
      try {
        const { done, value } = await reader.read();
        if (done) { c.close(); end(); return; }
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
export function add(key: ServedKey, seconds: number, trackSeconds: number, deps: MeterDeps, now = Date.now()): void {
  if (!(seconds > 0)) return;
  const id = idOf(key);
  let t = tallies.get(id);
  if (!t) {
    if (tallies.size >= MAX_KEYS) evictOldest(deps);
    t = { key, pending: 0, written: 0, trackSeconds, lastFlush: 0, waiting: false };
    tallies.set(id, t);
  }
  const cap = DELIVERED_CAP * trackSeconds;
  // Past the cap nothing more can count, so nothing more is kept or written.
  t.pending = Math.min(t.pending + seconds, Math.max(0, cap - t.written));
  if (t.pending < flushAt(trackSeconds)) return;
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
  t.pending = 0;
  t.lastFlush = Date.now();
  t.written += seconds;
  try {
    deps.onFlush?.();
    const perMinute = await deps.perMinute(t.key.pubkey).catch(() => 0);
    await inOneGo(deps.db, [
      addServed(deps.db, t.key, { delivered: seconds, cap: DELIVERED_CAP * t.trackSeconds }),
      ...billServed(deps.db, t.key, { slack: slackFor(t.trackSeconds), perMinute }),
    ]);
    if (deps.tidy && Math.random() < 0.02) await deps.tidy();
  } catch {
    // No `served` table (metering is off there), or the database is busy:
    // these seconds are lost, which errs the listener's way.
  }
}

/**
 * What this copy has counted for a wallet's track and not yet written, taken
 * out to go with the app's report of it (which is a write anyway), so the
 * two are written together.
 */
export function takePending(key: ServedKey): { seconds: number; trackSeconds: number } | null {
  const t = tallies.get(idOf(key));
  if (!t) return null;
  // One waiting out its gap is written then, not here.
  const seconds = t.waiting ? 0 : t.pending;
  t.pending -= seconds;
  t.written += seconds;
  return { seconds, trackSeconds: t.trackSeconds };
}

/** A wallet asked to be forgotten, or was removed: nothing counted for it
 *  here is written afterwards (another copy of the Worker may still write
 *  the few seconds it holds, which the next prune or erase removes). */
export function forgetTallies(pubkey: string): void {
  for (const [id, t] of tallies) if (t.key.pubkey === pubkey) { t.pending = 0; tallies.delete(id); }
}

/** For tests: start again with nothing counted. */
export function resetTallies(): void { tallies.clear(); }
