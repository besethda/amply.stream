/**
 * Tips: money a listener chooses to send an artist, over and above anything
 * their listening costs, from Now playing.
 *
 * A tip goes the same way as a payment for listening — straight from the
 * listener's wallet to the artist's, split between the people the artist
 * names — and is sent only after the listener has confirmed that amount.
 * Artists who take tips some other way (a Ko-fi page, Bandcamp) say so in
 * their manifest's payment links, and those are offered alongside.
 *
 * And Amply itself can be tipped: the same kind of payment, to the people
 * who make it, when an address is set here.
 */
import { rateOf } from "./manifest.js";
import { toMicros } from "./money.js";

export const TIP_AMOUNTS = [1, 3, 5];     // dollars, offered as buttons
export const MAX_TIP = 50;                // no single tip above this, ever

/** Who a tip to Amply goes to; unset, Amply isn't offered. Real money only. */
export const AMPLY = {
  name: "Amply",
  network: "solana",
  recipients: [],                          // e.g. [{ name: "Amply", address: "…", split: 100 }]
};

/**
 * How an artist can be tipped: from the listener's wallet (if the artist
 * has one set up), and through whatever tip links they publish.
 */
export function tipsFor(manifest) {
  const rate = manifest ? rateOf(manifest) : null;
  const recipients = (rate?.recipients || []).filter((r) => r.address);
  const links = (manifest?.payment || [])
    .filter((p) => p.type === "link" && /^https:\/\//.test(p.url || "") && p.label)
    .map((p) => ({ label: p.label, url: p.url }));
  return {
    wallet: recipients.length ? { recipients, network: rate.network } : null,
    links,
  };
}

/** Amply, as something to tip — or null while no address is set. */
export const amplyTips = () => (AMPLY.recipients.some((r) => r.address) ? { recipients: AMPLY.recipients, network: AMPLY.network } : null);

/**
 * What stands between this listener and sending `dollars`, as the kind of
 * refusal the app already has a sheet for — or null if nothing does.
 */
export function tipBlocked(dollars, { hasWallet, balance, mismatch }) {
  if (!(dollars > 0) || dollars > MAX_TIP) return "amount";
  if (!hasWallet) return "nowallet";
  if (mismatch) return "mismatch";
  // Only once the balance is known: a slow network is no reason to refuse.
  if (balance && !(balance.usdc >= dollars)) return "empty";
  if (balance && !(balance.sol > 0.001)) return "nosol";
  return null;
}

export const tipMicros = (dollars) => toMicros(Math.min(MAX_TIP, dollars));
