/**
 * Cloudflare's free plan, saying no.
 *
 * An artist without a card is on Cloudflare's free plan, and its limits are
 * real: KV takes 1,000 writes and 100,000 reads a day and holds 1 GB, and D1
 * has daily row limits too (a temporary account's database holds 100 MB). Past
 * one, the call throws, and the artist would see "internal error" or nothing.
 * This turns those into what happened and when it comes back.
 *
 * Matched on Cloudflare's wording, which is the only signal there is: KV says
 * "KV put() limit exceeded for the day", D1 says it has exceeded a limit or
 * that the database is full. Anything not recognised is left to throw as before.
 *
 * Not here: the daily limit on requests (100,000 on the free plan). Past that
 * the Worker isn't run at all and Cloudflare answers with error 1027 itself,
 * so the editor and the app recognise that page instead.
 */

export interface QuotaFailure { status: number; message: string }

/**
 * How near the free plan's limits a node is, for the editor's bars.
 *
 * Streams: Cloudflare counts requests (100,000 a day), and the node can't see
 * that count without an analytics token it deliberately doesn't hold. It can
 * count plays, so the bar is plays against the requests a play takes: the
 * audio in a few ranged pieces, its play report, the page and the manifest.
 * Six is on the cautious side, so the bar fills a little early, not late.
 *
 * Storage: what KV holds free (1 GB), or R2 (10 GB) on a node that has it.
 */
const FREE_REQUESTS_A_DAY = 100_000;
const REQUESTS_PER_PLAY = 6;
export const FREE_STREAMS_A_DAY = Math.floor(FREE_REQUESTS_A_DAY / REQUESTS_PER_PLAY);
export const FREE_STORAGE = { kv: 1_000_000_000, r2: 10_000_000_000 };

/** Whole hours to the next midnight UTC, when the daily limits reset. */
export function hoursToReset(now = Date.now()): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - now) / 3_600_000));
}

export function quotaFailure(e: unknown, now = Date.now()): QuotaFailure | null {
  const text = String((e as { message?: unknown })?.message ?? e);
  const back = `It resets at midnight UTC, in about ${hoursToReset(now)} hour${hoursToReset(now) === 1 ? "" : "s"}.`;

  if (/storage limit|maximum (db|database) size|database (or disk )?is full|SQLITE_FULL|namespace.*(full|storage)/i.test(text)) {
    return {
      status: 507,
      message: "Your storage is full: that's as much as Cloudflare's free plan holds. Delete some songs, "
        + "or switch on R2 storage in Cloudflare, which holds more (free, but Cloudflare asks for a card).",
    };
  }
  if (/limit exceeded for the day|daily (row )?(read|write)s? limit|exceeded .*daily|daily .*exceeded/i.test(text)) {
    return /put\(\)|delete\(\)|list\(\)|writ/i.test(text)
      ? { status: 429, message: `You've used Cloudflare's free limit for changes today. ${back}` }
      : { status: 503, message: `This page has reached Cloudflare's free daily limit. ${back}` };
  }
  return null;
}
