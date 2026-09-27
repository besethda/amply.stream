/**
 * Paying, as the app uses it.
 *
 * Everything that needs the Solana libraries lives behind a dynamic import, so
 * the 344kB of them is fetched the first time a listener sets up a wallet and
 * never by anyone who is only listening. The player is 30kB and should stay
 * that way for the people who never pay anyone.
 *
 * This module holds no policy of its own. What may be charged is spend.js, what
 * a payment is worth is pay.js, and this is the part that decides when to ask
 * either of them.
 */
import { rateOf } from "./manifest.js";
import { SETTLE_WITHIN_DAYS } from "../../spec/pricing.mjs";
import { payableHere, networkName, networkFor, NETWORKS } from "./networks.js";
import {
  loadLedger, accrue, settled, rateStatus, withinLimits, recordSpend, clampRate,
} from "./spend.js";

let modules = null;

/**
 * Is there a wallet on this device?
 *
 * Reads for the key's presence directly rather than importing wallet.js, so
 * that merely drawing a screen does not pull in the payment libraries.
 */
export function hasWallet() {
  try { return !!localStorage.getItem("amply.wallet.v1"); } catch { return false; }
}

/**
 * Has the listener saved this wallet's backup key?
 *
 * Tied to the address, so a different wallet on the same device starts
 * unsaved. Only the device's word for it: nothing can check a piece of paper.
 */
const SAVED = "amply.backup.saved.v1";
export function backupSaved(address) {
  try { return !!address && localStorage.getItem(SAVED) === address; } catch { return false; }
}
export function markBackupSaved(address) {
  try { localStorage.setItem(SAVED, address); } catch { /* asked again next time */ }
}

/** Opened from the home screen rather than a browser tab. Deleting that icon
 *  deletes everything the app keeps — the wallet included. */
export const onHomeScreen = () => {
  try {
    return window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
  } catch { return false; }
};

/** Load the payment machinery, once, on demand. */
export async function machinery() {
  if (!modules) {
    const [wallet, pay] = await Promise.all([import("./wallet.js"), import("./pay.js")]);
    modules = { wallet, pay };
  }
  return modules;
}

/** Already loaded? Used to avoid pulling it in just to draw a screen. */
export const loaded = () => modules;

/**
 * Bank listening against the artist it belongs to.
 *
 * The rate comes from the manifest as it stands now, and spend.js decides
 * whether it may be charged at all. Anything not yet agreed accrues nothing:
 * the music still plays, because the licence says it may.
 */
export function bank(ledger, entries, seconds) {
  let next = ledger;
  for (const [url, secs] of Object.entries(seconds)) {
    const entry = entries.find((e) => e.url === url);
    const rate = entry && rateOf(entry.manifest);
    if (!rate) continue;
    // An artist asking to be paid somewhere this wallet's money is not. Build
    // no debt: it could never be settled, and a growing number the listener
    // cannot discharge is worse than nothing owed at all. The app says so
    // rather than letting it happen silently.
    if (!payableHere(rate)) continue;
    next = accrue(next, url, secs, rate.perMinute, { network: networkName() });
  }
  return next;
}

/**
 * Why an artist cannot be paid from this device, in words a listener can act
 * on. Null when they can.
 */
export function mismatch(rate, mine = networkName()) {
  if (!rate || payableHere(rate, mine)) return null;
  const theirs = networkFor(rate.network);
  if (!theirs) return "This artist asks to be paid in a way this app doesn't understand.";
  return NETWORKS[theirs]?.real
    ? "Your wallet is on the test network, so it can't pay this artist. Switch it to Solana under Paying."
    : "This artist is testing and takes play money only. Switch your wallet to the test network under Paying to hear their paid tracks.";
}

/**
 * What this artist is owed, and whether it should be sent now.
 *
 * `ending` means the listener is done with this artist — removing them from
 * the library — and what is owed is sent then, however small. Pausing or
 * closing the app is not an ending: the debt waits for the artist's amount or
 * the week, whichever comes first.
 */
export function owing(entry, ledger, { ending = false, now = Date.now() } = {}) {
  const held = ledger[entry.url];
  const rate = rateOf(entry.manifest);
  if (!held || !held.micros || !rate) return null;

  const threshold = Math.round((rate.settleAt ?? 1) * 1e6);
  const old = held.since != null && now - held.since >= SETTLE_WITHIN_DAYS * 86400e3;
  const due = held.micros >= threshold || ending || old;

  return {
    micros: held.micros,
    usd: held.micros / 1e6,
    seconds: held.seconds,
    due,
    why: held.micros >= threshold ? "threshold" : old ? "age" : "session",
  };
}

/**
 * Send what is owed to one artist.
 *
 * The ledger is only cleared once the network has confirmed the transfer. A
 * payment that fails, times out or is refused leaves the debt exactly where it
 * was, because the alternative is an artist going unpaid for listening that the
 * app has already forgotten about.
 */
export async function settle(pair, entry, ledger, { ending = false } = {}) {
  const owed = owing(entry, ledger, { ending });
  if (!owed?.due) return { ledger, paid: null };

  const rate = rateOf(entry.manifest);

  // Settled in the money it was earned in, which is not necessarily what the
  // manifest says today. An artist who switches to testing after somebody has
  // listened is still owed for the listening: refusing on today's setting
  // would strand a real debt for good. What their change does stop is any
  // further debt accruing — see bank().
  //
  // The wallet still has to be on that network, because that is where the
  // money is. An older debt from before this was recorded is payable wherever
  // the listener is now, rather than stranded for want of a field.
  const owedOn = ledger[entry.url]?.network;
  if (owedOn && owedOn !== networkName()) {
    return { ledger, paid: null, refused: NETWORKS[owedOn]?.real
      ? "This was owed in real money. Switch your wallet back to Solana to send it."
      : "This was owed in play money, on the test network. Switch your wallet there to send it." };
  }
  if (!owedOn) {
    const wrong = mismatch(rate);
    if (wrong) return { ledger, paid: null, refused: wrong };
  }

  const recipients = (rate.recipients || []).filter((r) => r.address);
  if (!recipients.length) return { ledger, paid: null, refused: "nobody to pay" };

  const allowed = withinLimits(owed.micros);
  if (!allowed.ok) return { ledger, paid: null, refused: allowed };

  const { pay } = await machinery();
  const result = await pay.payArtist(pair, recipients, owed.micros, {
    artistName: entry.manifest.artist?.name,
  });

  recordSpend(owed.micros);
  return { ledger: settled(ledger, entry.url, owed.micros), paid: { ...result, usd: owed.usd } };
}

/**
 * Settle everyone who is due.
 *
 * One artist failing must not stop the others being paid, so each is attempted
 * on its own and the failures are reported rather than thrown.
 */
export async function settleAll(pair, entries, ledger, { ending = false } = {}) {
  let next = ledger;
  const paid = [];
  const failed = [];

  for (const entry of entries) {
    if (!owing(entry, next, { ending })?.due) continue;
    try {
      const result = await settle(pair, entry, next, { ending });
      next = result.ledger;
      if (result.paid) paid.push({ entry, ...result.paid });
    } catch (e) {
      failed.push({ entry, message: e.message });
    }
  }

  return { ledger: next, paid, failed };
}

/** Everything owed across the library, for one honest number on screen. */
export function totalOwed(ledger) {
  return Object.values(ledger).reduce((n, held) => n + (held.micros || 0), 0) / 1e6;
}

export { loadLedger, rateStatus, clampRate };
