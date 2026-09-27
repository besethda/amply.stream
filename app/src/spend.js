/**
 * What the listener is prepared to spend, and on whose word.
 *
 * A manifest is a file from a stranger that names a price. Everything in here
 * exists because of that sentence. The spec says as much (`spec/README.md`,
 * "What a client must do"), and this is the file that keeps its promises.
 *
 * Four rules:
 *
 * 1. **A price is agreed once, and honoured as agreed.** What accrues is money,
 *    at the rate in force while the audio played, never seconds to be priced
 *    later. Otherwise an artist could raise their rate after you listened and be
 *    paid the new price for the old listening.
 * 2. **No rate is adopted silently.** Every rate needs agreement before it can
 *    cost anything, and so does any increase.
 * 3. **There is a ceiling the app will not pay past**, whatever any file says.
 * 4. **There is a daily limit**, so a fault anywhere upstream costs a listener
 *    one bad day rather than their wallet.
 */
import { toMicros, toUsd } from "./money.js";

const AGREED = "amply.agreed.v1";
const LEDGER = "amply.owed.v2";
const SPENT = "amply.spent.v1";

/** Ten cents a minute: twice the most the editor will let an artist set, and a
 *  long way under the spec's 1.00 validator ceiling, which a hostile node can
 *  ignore anyway. Nothing above this is paid, ever, by any route. */
export const MAX_RATE = 0.10;

/** Any price is put to the listener once, before that artist's first paid
 *  song plays — then not again unless it rises. Agreement is what lets a paid
 *  song play at all, so nothing is adopted without asking. */
export const ASK_ABOVE = 0;     // per minute, in micros

/** No single automatic payment may exceed this, and no day may total more. */
export const MAX_PAYMENT = toMicros(2);
export const DAILY_LIMIT = toMicros(10);

const read = (key, fallback) => {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
  catch { return fallback; }
};
const write = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
};

/** The rate, as this app is willing to honour it. */
export function clampRate(perMinute) {
  const n = Number(perMinute);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, MAX_RATE);
}

// ── what the listener has agreed to ─────────────────────────────────────────

export const agreements = () => read(AGREED, {});

/**
 * Whether this artist's current rate may be charged without asking.
 *
 * A new artist's rate, or one dearer than last time, has to be put to the
 * listener. A rate that has gone *down* needs no asking; the lower figure is
 * simply what applies from now on.
 */
export function rateStatus(url, perMinute, agreed = agreements()) {
  const rate = clampRate(perMinute);
  if (rate <= 0) return { rate, ask: false, why: "free" };

  const micros = toMicros(rate);
  const before = agreed[url];

  if (before == null) {
    return micros <= ASK_ABOVE
      ? { rate, ask: false, why: "small" }
      : { rate, ask: true, why: "new" };
  }
  if (micros > before) return { rate, ask: true, why: "increase", was: toUsd(before) };
  return { rate, ask: false, why: "agreed" };
}

export function agreeRate(url, perMinute, agreed = agreements()) {
  const next = { ...agreed, [url]: toMicros(clampRate(perMinute)) };
  write(AGREED, next);
  return next;
}

// ── the ledger ──────────────────────────────────────────────────────────────

/**
 * What is owed, per artist: micros, and the seconds behind them for display.
 *
 * `since` is when the oldest unpaid listening began, which is what the spec's
 * seven-day rule counts from.
 */
export const loadLedger = () => read(LEDGER, {});

/**
 * Bank some listening, priced now.
 *
 * Returns the ledger unchanged when the rate has not been agreed, which is how
 * listening stays free until the listener says otherwise: the music plays, and
 * nothing accrues behind their back.
 */
export function accrue(ledger, url, seconds, perMinute, { agreed = agreements(), now = Date.now(), network = null } = {}) {
  if (!(seconds > 0)) return ledger;
  const status = rateStatus(url, perMinute, agreed);
  if (status.ask || status.rate <= 0) return ledger;

  const micros = Math.round((seconds / 60) * status.rate * 1e6);
  if (micros <= 0 && seconds < 1) return ledger;

  const had = ledger[url] || { micros: 0, seconds: 0, since: now };
  const next = {
    ...ledger,
    [url]: {
      micros: had.micros + micros,
      seconds: had.seconds + seconds,
      since: had.since ?? now,
      // Which money this debt is in, fixed when it was incurred. An artist can
      // change their mind afterwards — turn testing on, or off — and what was
      // already earned must still be payable in the money it was earned in.
      // Keeping the first answer also stops a debt being a mixture of two.
      network: had.network ?? network ?? undefined,
    },
  };
  write(LEDGER, next);
  return next;
}

export function settled(ledger, url, micros) {
  const had = ledger[url];
  if (!had) return ledger;
  const left = Math.max(0, had.micros - micros);
  const next = { ...ledger };
  if (left === 0) delete next[url];
  else next[url] = { ...had, micros: left, seconds: 0, since: Date.now() };
  write(LEDGER, next);
  return next;
}

// ── the daily limit ─────────────────────────────────────────────────────────

const today = (now) => new Date(now).toISOString().slice(0, 10);

export function spentToday(now = Date.now()) {
  const kept = read(SPENT, {});
  return kept.day === today(now) ? kept.micros || 0 : 0;
}

export function recordSpend(micros, now = Date.now()) {
  write(SPENT, { day: today(now), micros: spentToday(now) + micros });
}

/**
 * May this payment go automatically?
 *
 * Says no rather than trimming: paying part of what is owed and leaving the
 * rest is harder to explain than waiting, and the debt does not expire.
 */
export function withinLimits(micros, now = Date.now()) {
  if (micros > MAX_PAYMENT) {
    return { ok: false, why: "payment", limit: toUsd(MAX_PAYMENT) };
  }
  if (spentToday(now) + micros > DAILY_LIMIT) {
    return { ok: false, why: "daily", limit: toUsd(DAILY_LIMIT), spent: toUsd(spentToday(now)) };
  }
  return { ok: true };
}
