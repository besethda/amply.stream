/**
 * Where a listener stands with an artist: what their listening cost, and
 * whether what's unpaid is more than their app is allowed to hold back.
 *
 * One set of rules, in one file, imported by both sides: the artist's editor,
 * which shows who is behind, and the artist's server, which stops serving
 * them when the artist has turned Auto-block on. If the two ever disagreed,
 * the editor would promise one thing and the server do another — and an
 * honest listener could be refused while the editor showed them as fine.
 *
 * Money is in micros (millionths of a dollar), as everywhere else.
 */
import { LISTEN_MIN_MICROS, SETTLE_WITHIN_DAYS } from "./pricing.mjs";

export const DAY = 86_400_000;

/** How far past the payment point a listener may fall before they count as behind. */
export const ALLOWANCE_FACTOR = 1.5;

/**
 * What a listener's listening cost, by the server's count.
 *
 * The server prices listening as it's heard (the `owed` table): the price
 * then, and nothing while it was free. Listening from before it kept that
 * (`seconds` beyond `owed_seconds`) is estimated at today's price, which is
 * the best that can be said about it.
 */
export function owedOf(row, ratePerMinute) {
  const before = Math.max(0, (Number(row?.seconds) || 0) - (Number(row?.owed_seconds) || 0));
  const rate = Number(ratePerMinute) > 0 ? Number(ratePerMinute) : 0;
  return (Number(row?.owed_micros) || 0) + (before / 60) * rate * 1_000_000;
}

/**
 * Is this listener behind on paying, as opposed to simply not yet due?
 *
 * Their app holds back up to one payment's worth — the artist's payment
 * point, `settleAt`, in dollars — before sending. So owing less than that is
 * the artist's own setting at work, not a debt. Half a payment's slack on top
 * absorbs rounding and a price that has since changed.
 */
export function behind(owedMicros, paidMicros, settleAt) {
  const allowance = (Number(settleAt) > 0 ? Number(settleAt) : 1) * 1_000_000;
  return owedMicros - paidMicros > allowance * ALLOWANCE_FACTOR;
}

/**
 * Overdue: owing for listening that finished more than a week ago.
 *
 * Someone who plays one song owes less than the artist's amount and is never
 * "behind" — but their app must still send it within SETTLE_WITHIN_DAYS.
 * Nobody can see when each minute was played, only when the wallet was last
 * heard, so this is certain only once *everything* is that old: last heard
 * over the week ago (and a day's grace, since the app pays when next opened),
 * with money still unpaid.
 *
 * Unpaid means more than rounding: a cent (less is never sent on its own), or
 * a tenth of what they owe, whichever is larger. A wallet never heard from at
 * all (last seen 0: a record whose listening was erased) is not overdue: when
 * it was here is exactly what isn't known.
 */
export function overdue(owedMicros, paidMicros, lastSeen, now = Date.now()) {
  const unpaid = owedMicros - paidMicros;
  const slack = Math.max(LISTEN_MIN_MICROS, owedMicros * 0.1);
  const seen = Number(lastSeen) || 0;
  return seen > 0 && unpaid > slack && now - seen > (SETTLE_WITHIN_DAYS + 1) * DAY;
}

/** What's still unpaid, in whole micros, never below nothing. */
export function unpaidOf(owedMicros, paidMicros) {
  return Math.max(0, Math.round((Number(owedMicros) || 0) - (Number(paidMicros) || 0)));
}

/**
 * Whether the artist's server should stop serving this wallet until it pays,
 * with Auto-block on, and how much it owes. Only ever for a wallet the server
 * has a record of: one never seen owes nothing. Never for a subscriber, who
 * pays by card; never without a price by the minute (`ratePerMinute`), since
 * then nothing is owed; and never for less than a cent, the least one payment
 * can be (LISTEN_MIN_MICROS): it couldn't be paid on its own. Whether the
 * listener can pay at all (the artist's fees account) is the server's to
 * know, and it doesn't ask this when they can't.
 */
export function autoBlock(row, paidMicros, { ratePerMinute, settleAt, subscribed = false, now = Date.now() } = {}) {
  if (!row || !(Number(ratePerMinute) > 0)) return { blocked: false, owes: 0 };
  const owed = owedOf(row, ratePerMinute);
  const paid = Math.max(0, Number(paidMicros) || 0);
  const owes = unpaidOf(owed, paid);
  if (subscribed || owes < LISTEN_MIN_MICROS) return { blocked: false, owes };
  const blocked = behind(owed, paid, settleAt) || overdue(owed, paid, row.last_seen, now);
  return { blocked, owes };
}
