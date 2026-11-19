/**
 * Every payment this device has sent: to whom, how much, when, and what for.
 *
 * Kept on the device only, like everything else the app knows about the
 * listener. The chain has the same facts in public, but reading it back means
 * asking an RPC node about this wallet, and the listener shouldn't need the
 * network — or to tell anyone — to see where their own money went.
 *
 * Written once a payment is confirmed (pay.js), or found to have landed after
 * all (paying.js lookAgain). Never edited after. The newest 500 are kept.
 */
const KEY = "amply.receipts.v1";
const MAX = 500;

const read = () => {
  try { const all = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(all) ? all : []; } catch { return []; }
};

/** Newest first. */
export const receipts = () => read();

/**
 * Record one payment. `kind` is "listen", "tip", "purchase" or "owed" (what
 * an artist's server said was owed). A signature already recorded isn't
 * recorded again, so a payment found twice is still one receipt.
 */
export function recordReceipt({ micros, origin = null, artist = "", kind = "listen", signature = null, network = null, at = Date.now() }) {
  if (!(micros > 0)) return;
  const all = read();
  if (signature && all.some((r) => r.signature === signature)) return;
  const next = [{ at, micros: Math.round(micros), origin, artist: String(artist || "").slice(0, 200), kind, signature, network }, ...all].slice(0, MAX);
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* full: the payment still happened */ }
}

/** Erase the history (the wallet removed, or on request). */
export function forgetReceipts() {
  try { localStorage.removeItem(KEY); } catch { /* fine */ }
}
