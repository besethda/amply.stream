/**
 * Buying songs and albums to keep.
 *
 * The artist sells; their own server confirms each purchase (with Stripe, or
 * on the chain) and hands the files to the wallet that bought them, a few
 * downloads per song. This file is the app's side of that: asking, claiming,
 * downloading, and remembering a purchase that's still on its way — a card
 * payment happens on Stripe's page, and a USDC one can take a moment to show.
 *
 * Nothing here is Amply's: the money goes to the artist, and what was bought
 * is recorded on the artist's server and kept on this phone.
 */
import { signedPost, originOf } from "./identify.js";
import { forSale, includes } from "../../spec/pricing.mjs";

/** Everything an artist sells, by id. */
export const offersOf = (entry) => (entry?.manifest ? forSale(entry.manifest) : []);
export const offerFor = (entry, id) => offersOf(entry).find((o) => o.id === id) || null;

/** What can be bought that includes this song: the song itself, then its album. */
export function offersFor(entry, trackId) {
  const ids = includes(entry?.manifest, trackId);
  return ids.map((id) => offerFor(entry, id)).filter(Boolean);
}

/** The note a USDC purchase carries, naming the artist's server and the item. */
export const purchaseMemo = (entry, item) => `amply:buy:${new URL(entry.url).host}:${item}`;

async function answer(res) {
  const body = await res.json().catch(() => ({}));
  if (res.status === 404 && !body.error) throw new Error("This artist's streaming service needs an update before it can sell music.");
  if (!res.ok && !(res.status === 403 && body.outcome)) throw new Error(body.error || "The artist's streaming service didn't answer. Try again in a moment.");
  return body;
}

/** Back from Stripe: which checkout was ours, and whether it's a gift. */
export async function claimCard(pair, origin, session, gift) {
  return answer(await signedPost(pair, origin, "/buy/claim", { session: session || "", gift: !!gift }));
}

/** A USDC payment made: the transaction, and what it bought. */
export async function claimWallet(pair, origin, tx, item, gift) {
  return answer(await signedPost(pair, origin, "/buy/wallet", { tx, item, gift: !!gift }));
}

/** What this wallet owns from an artist, downloads used, and unclaimed gifts it bought. */
export async function purchases(pair, origin) {
  return answer(await signedPost(pair, origin, "/purchases"));
}

/** Claim a gift sent to us. */
export async function redeemGift(pair, origin, code) {
  return answer(await signedPost(pair, origin, "/gift", { code }));
}

/** One song's file, for a wallet that owns it. Uses up one download. */
export async function downloadTrack(pair, origin, track) {
  const res = await signedPost(pair, origin, "/download", { track });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "That download didn't work. Try again in a moment.");
  }
  const blob = await res.blob();
  const left = Number(res.headers.get("X-Downloads-Left"));
  const disposition = res.headers.get("Content-Disposition") || "";
  const name = decodeURIComponent((/filename\*=UTF-8''([^;]+)/.exec(disposition) || [])[1] || "") || (/filename="([^"]+)"/.exec(disposition) || [])[1] || `${track}.mp3`;
  return { file: new File([blob], name, { type: blob.type || "audio/mpeg" }), left: Number.isFinite(left) ? left : null };
}

/** The link that gives a gift: the artist, and the code. */
export const giftLink = (manifestUrl, code) =>
  `https://amply.stream/app/?gift=${encodeURIComponent(manifestUrl)}&code=${encodeURIComponent(code)}`;

// ── purchases on their way ──────────────────────────────────────────────────

const BUYING = "amply.buying.v1";       // a card checkout we sent the listener to
const UNCLAIMED = "amply.unclaimed.v1"; // USDC paid, not yet confirmed by the artist
const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage off */ } };

/** Remember, across the trip to Stripe, what's being bought and whether it's a gift. */
export const rememberCheckout = (origin, item, gift) => write(BUYING, { origin, item, gift: !!gift, at: Date.now() });
export function takeCheckout(origin) {
  const b = read(BUYING, null);
  write(BUYING, null);
  return b && b.origin === origin && Date.now() - b.at < 86400_000 ? b : null;
}

export const unclaimed = () => read(UNCLAIMED, []);
export const keepUnclaimed = (p) => write(UNCLAIMED, [...unclaimed().filter((u) => u.tx !== p.tx), { ...p, at: Date.now() }]);
export const dropUnclaimed = (tx) => write(UNCLAIMED, unclaimed().filter((u) => u.tx !== tx));

/**
 * Claim a USDC purchase, a few times over: the artist's server asks the chain,
 * and a transaction just sent can take a few seconds to be visible there.
 */
export async function claimWalletPatiently(pair, entry, tx, item, gift, { tries = 8, wait = 3000 } = {}) {
  const origin = originOf(entry.url);
  for (let i = 0; i < tries; i++) {
    const r = await claimWallet(pair, origin, tx, item, gift).catch((e) => ({ outcome: "pending", error: e.message }));
    if (r.outcome !== "pending") return r;
    await new Promise((ok) => setTimeout(ok, wait));
  }
  return { outcome: "pending" };
}

// ── keeping a copy elsewhere ────────────────────────────────────────────────

/**
 * Offer the files to the phone's share sheet, where "Save to Files" puts them
 * in iCloud Drive or on the phone — somewhere that survives deleting the app.
 * Where a browser can't share files, each is downloaded instead.
 */
export async function saveCopies(files, title = "Music") {
  if (!files.length) return "none";
  try {
    if (navigator.canShare?.({ files })) {
      await navigator.share({ files, title });
      return "shared";
    }
  } catch (e) {
    if (e?.name === "AbortError") return "cancelled";
  }
  for (const f of files) {
    const url = URL.createObjectURL(f);
    const a = document.createElement("a");
    a.href = url; a.download = f.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  return "downloaded";
}
