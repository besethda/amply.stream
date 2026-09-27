/**
 * Which tracks have to be paid for, and what is for sale.
 *
 * One rule, in one file, imported by both sides: the artist's server, which
 * refuses audio to anyone it cannot identify, and the listening app, which
 * has to know in advance which tracks to identify itself for. If the two ever
 * disagreed, a track would either play for free or refuse to play at all.
 *
 * The rule: **if an artist charges, their music is paid for.** Every track
 * needs a wallet, except the ones the artist has deliberately made free.
 *
 * The other way round — open unless the artist marked a track — a listener
 * with no wallet could hear everything an artist was charging for. Free is
 * the exception an artist chooses, not the default they have to work around.
 */

/**
 * The longest a listener's app holds on to what it owes an artist. Below the
 * artist's amount a debt waits, but no longer than this from the listening —
 * after which it is sent the next time the app is opened. The editor uses the
 * same number to call a listener overdue.
 */
export const SETTLE_WITHIN_DAYS = 7;

/** Does this artist charge by the minute? A price with nowhere to send it is
 *  not a charge — the editor publishes no payment until there is an address. */
export function perMinute(manifest) {
  return (manifest?.payment || []).some(
    (p) => p && p.type === "solana-usdc" && Number(p.ratePerMinute) > 0,
  );
}

/** The subscription plans an artist offers, if any. */
export function plans(manifest) {
  const sub = (manifest?.payment || []).find((p) => p && p.type === "stripe-subscription");
  return Array.isArray(sub?.plans) ? sub.plans.filter((p) => p && p.url && p.months && p.price > 0) : [];
}

/**
 * Does this artist charge at all — by the minute, by subscription, or both?
 * Either way their paid music is paid for; only how is the listener's choice.
 */
export function charges(manifest) {
  return perMinute(manifest) || plans(manifest).length > 0;
}

/**
 * Subscription and nothing else: then a paid track needs an active
 * subscription, because there is no other way to pay for it. With per-minute
 * offered too, anyone with a wallet can listen and pay as they go.
 */
export function subscriptionOnly(manifest) {
  return plans(manifest).length > 0 && !perMinute(manifest);
}

/** Must a listener identify themselves with a wallet to play this track? */
export function needsWallet(manifest, track) {
  if (!track) return false;
  if (track.free === true) return false;         // the artist chose to give it away
  if (track.needsWallet === true) return true;   // asked for explicitly, priced or not
  return charges(manifest);
}

// ── selling songs and albums to keep ────────────────────────────────────────
//
// A bought song is the listener's to keep: the file, from the artist's own
// server, into their app. Both sides read the same answers from here — what
// is for sale, how it can be paid for, and which purchases include a song.

/** How many times each song of a purchase may be downloaded: a new phone or
 *  two, and a reinstall, without the file being handed out forever. */
export const DOWNLOADS_PER_PURCHASE = 5;

/** The artist's wallet payment, if they take USDC: who is paid, on which chain. */
export function walletOf(manifest) {
  const w = (manifest?.payment || []).find((p) => p && p.type === "solana-usdc");
  if (!w) return null;
  const recipients = Array.isArray(w.recipients) && w.recipients.length
    ? w.recipients.filter((r) => r && r.address)
    : (w.address ? [{ address: w.address, split: 100 }] : []);
  return recipients.length ? { recipients, network: w.network || "solana" } : null;
}

/**
 * How an album or a song can be bought, or null if it isn't for sale:
 * `card` when the artist's Stripe made a link for it, `wallet` when they take
 * USDC. The price is the same either way, in dollars.
 */
export function saleOf(manifest, item) {
  const s = item?.sale;
  if (!s || typeof s.price !== "number" || !(s.price >= 0.5) || (s.currency && s.currency !== "usd")) return null;
  const card = typeof s.url === "string" && /^https:\/\/([a-z0-9-]+\.)*stripe\.com\//.test(s.url) ? s.url : null;
  const wallet = walletOf(manifest);
  if (!card && !wallet) return null;
  return { price: s.price, card, wallet };
}

/** Everything for sale: albums and songs, by id (ids are unique across a manifest). */
export function forSale(manifest) {
  const out = [];
  for (const r of manifest?.releases || []) {
    const rs = saleOf(manifest, r);
    if (rs) out.push({ id: r.id, kind: "album", title: r.title, tracks: (r.tracks || []).map((t) => t.id), ...rs });
    for (const t of r.tracks || []) {
      const ts = saleOf(manifest, t);
      if (ts) out.push({ id: t.id, kind: "song", title: t.title, tracks: [t.id], ...ts });
    }
  }
  return out;
}

/** The purchases that include a song: the song itself, and its album. */
export function includes(manifest, trackId) {
  for (const r of manifest?.releases || []) {
    if ((r.tracks || []).some((t) => t.id === trackId)) return [trackId, r.id];
  }
  return [];
}
