/**
 * Selling songs and albums to keep.
 *
 * The artist is the seller; this is their server, keeping their record of who
 * bought what. A purchase is confirmed here, never taken on a listener's word:
 * by card, Stripe is asked (stripe.ts, claimSale); in USDC, the chain is asked
 * (verifyPayment). Either way the purchase is recorded against the wallet that
 * signed for it, and the files are handed only to that wallet — each song of a
 * purchase a few times (DOWNLOADS_PER_PURCHASE), enough for a new phone or a
 * reinstall, not a file to hand round forever.
 *
 * A purchase can be a gift: then nobody owns it until someone claims it with
 * the code the buyer was given, and whoever does becomes its owner.
 *
 * Rules this file keeps:
 *   - a payment counts once: its reference (a checkout or a transaction) is
 *     the purchase's key, so the same payment can't be claimed twice, even
 *     for two different things;
 *   - the price is this server's, from its own manifest, never the caller's;
 *   - a download is counted before the file is served, in one statement, so
 *     two at once can't both get the last one.
 */
import { verifyPayment, purchaseMemo } from "./payment-check";
import { DOWNLOADS_PER_PURCHASE, forSale, includes, walletOf } from "../../spec/pricing.mjs";

/** Where a chain's payments are asked about, and which token is money there. */
export const CHAINS: Record<string, { rpc: string; mint: string }> = {
  solana: { rpc: "https://solana-rpc.publicnode.com", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  devnet: { rpc: "https://api.devnet.solana.com", mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" },
};

export interface Sale {
  ref: string;
  item: string;
  buyer: string;
  owner: string | null;
  gift: string | null;
  via: string;
  created: number;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** A gift code: 20 characters of base58, about 117 bits — unguessable. */
export function giftCode(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => B58[b % 58]).join("");
}
export const GIFT_RE = /^[1-9A-HJ-NP-Za-km-z]{20}$/;

/**
 * Record a purchase, once. The same payment claimed again returns the record
 * already made — so a listener retrying after a dropped connection gets their
 * purchase (and their gift code) back, rather than an error.
 */
export async function recordSale(
  db: D1Database,
  s: { ref: string; item: string; buyer: string; gift: boolean; via: string },
  now = Date.now(),
): Promise<Sale> {
  const made = await db.prepare(
    `INSERT INTO sales (ref, item, buyer, owner, gift, via, created) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ref) DO NOTHING RETURNING *`,
  ).bind(s.ref, s.item, s.buyer, s.gift ? null : s.buyer, s.gift ? giftCode() : null, s.via, now).first<Sale>();
  if (made) return made;
  return (await db.prepare("SELECT * FROM sales WHERE ref = ?").bind(s.ref).first<Sale>())!;
}

/** What this wallet owns here, and the gifts it bought that nobody has claimed yet. */
export async function purchasesOf(db: D1Database, wallet: string): Promise<{ owned: Sale[]; gifts: Sale[] }> {
  const owned = await db.prepare("SELECT * FROM sales WHERE owner = ? ORDER BY created").bind(wallet).all<Sale>();
  const gifts = await db.prepare("SELECT * FROM sales WHERE buyer = ? AND owner IS NULL ORDER BY created").bind(wallet).all<Sale>();
  return { owned: owned.results ?? [], gifts: gifts.results ?? [] };
}

/** How many times each song of these purchases has been downloaded. */
export async function downloadsOf(db: D1Database, refs: string[]): Promise<Record<string, Record<string, number>>> {
  const out: Record<string, Record<string, number>> = {};
  for (const ref of refs) {
    const rows = await db.prepare("SELECT track, count FROM downloads WHERE ref = ?").bind(ref).all<{ track: string; count: number }>();
    out[ref] = Object.fromEntries((rows.results ?? []).map((r) => [r.track, r.count]));
  }
  return out;
}

/** Claim a gift: the wallet with the code becomes its owner, if nobody has yet. */
export async function redeem(db: D1Database, wallet: string, code: string): Promise<string | null> {
  if (!GIFT_RE.test(code)) return null;
  const row = await db.prepare("UPDATE sales SET owner = ? WHERE gift = ? AND owner IS NULL RETURNING item")
    .bind(wallet, code).first<{ item: string }>();
  return row?.item ?? null;
}

/**
 * May this wallet download this song now? If so, one download is used up —
 * from the first of its purchases that includes the song and has some left —
 * and how many remain is returned. Null means no.
 */
export async function takeDownload(
  db: D1Database, manifest: unknown, wallet: string, track: string,
): Promise<{ ref: string; left: number } | null> {
  const items = includes(manifest, track);
  if (!items.length) return null;
  const marks = items.map(() => "?").join(",");
  const rows = await db.prepare(`SELECT ref FROM sales WHERE owner = ? AND item IN (${marks}) ORDER BY created`)
    .bind(wallet, ...items).all<{ ref: string }>();
  for (const { ref } of rows.results ?? []) {
    const used = await db.prepare(
      `INSERT INTO downloads (ref, track, count) VALUES (?, ?, 1)
       ON CONFLICT(ref, track) DO UPDATE SET count = count + 1 WHERE count < ?
       RETURNING count`,
    ).bind(ref, track, DOWNLOADS_PER_PURCHASE).first<{ count: number }>();
    if (used) return { ref, left: DOWNLOADS_PER_PURCHASE - used.count };
  }
  return null;
}

/** An item this server's manifest offers for sale, by id. */
export function itemFor(manifest: unknown, id: string) {
  return forSale(manifest).find((x: { id: string }) => x.id === id) ?? null;
}

export type WalletClaim = { ok: true; sale: Sale } | { ok: false; why: string; retry?: boolean };

/**
 * A purchase paid in USDC: the listener names the transaction and the item;
 * the chain is asked whether that wallet sent at least the price to this
 * artist. Anything short of that is refused — or, if the network couldn't be
 * asked, left for the listener's app to try again.
 */
export async function claimWalletSale(
  db: D1Database, manifest: unknown,
  { wallet, signature, item, gift, host }: { wallet: string; signature: string; item: string; gift: boolean; host: string },
  { verify = verifyPayment, now = Date.now() }: { verify?: typeof verifyPayment; now?: number } = {},
): Promise<WalletClaim> {
  const sale = itemFor(manifest, item);
  if (!sale || !sale.wallet) return { ok: false, why: "that isn't for sale for USDC here" };
  const pay = walletOf(manifest);
  const chain = pay && CHAINS[pay.network];
  if (!pay || !chain) return { ok: false, why: "this artist isn't taking USDC" };

  // Already recorded? Then only for the wallet that paid it.
  const known = await db.prepare("SELECT * FROM sales WHERE ref = ?").bind(signature).first<Sale>();
  if (known) return known.buyer === wallet && known.item === item ? { ok: true, sale: known } : { ok: false, why: "that payment has already been used" };

  const result = await verify(
    { signature, payer: wallet },
    { rpc: chain.rpc, mint: chain.mint, recipients: pay.recipients.map((r: { address: string }) => r.address), minMicros: Math.round(sale.price * 1e6), memo: purchaseMemo(host, item) },
  );
  if (!result.ok) {
    const retry = /busy|could not reach|refused the question|no such transaction/.test(result.why || "");
    return { ok: false, why: result.why || "that payment couldn't be confirmed", retry };
  }
  return { ok: true, sale: await recordSale(db, { ref: signature, item, buyer: wallet, gift, via: "usdc" }, now) };
}
