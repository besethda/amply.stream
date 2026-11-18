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
import { SETTLE_WITHIN_DAYS, LISTEN_MIN_MICROS } from "../../spec/pricing.mjs";
import { payableHere, networkName, networkFor, NETWORKS } from "./networks.js";
import {
  loadLedger, accrue, settled, rateStatus, recordSpend, clampRate, spentToday, MAX_PAYMENT, DAILY_LIMIT,
} from "./spend.js";
import { toUsd } from "./money.js";

// ── payments that may have gone out ────────────────────────────────────────
//
// A payment whose answer was lost may still land. Until the network says
// whether it did, nothing more is sent to that artist, so a debt is never
// paid twice. Kept on the device, beside the debt it belongs to.
const UNSURE = "amply.unsure.v1";
const readUnsure = () => { try { return JSON.parse(localStorage.getItem(UNSURE) || "{}"); } catch { return {}; } };
const writeUnsure = (all) => { try { localStorage.setItem(UNSURE, JSON.stringify(all)); } catch { /* asked again */ } };
export function noteUnsure(url, { micros, signature = null, at = Date.now(), looked = 0 }) {
  writeUnsure({ ...readUnsure(), [url]: { micros, signature, at, looked } });
}
export function forgetUnsure(url) {
  const all = readUnsure();
  if (!(url in all)) return;
  delete all[url];
  writeUnsure(all);
}
export const unsureOf = (url) => readUnsure()[url] || null;

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

/** Whether this wallet came from a passkey (wallet.js adoptSeed). Cheap: no
 *  wallet library needed to ask. */
export function passkeyWallet(address) {
  try { return !!address && localStorage.getItem("amply.wallet.passkey") === address; } catch { return false; }
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

/** Tests stand in for the payment libraries here. */
export const useMachinery = (m) => { modules = m; };

/** Already loaded? Used to avoid pulling it in just to draw a screen. */
export const loaded = () => modules;

/**
 * Bank listening against the artist it belongs to.
 *
 * The rate comes from the manifest as it stands now, and spend.js decides
 * whether it may be charged at all. Anything not yet agreed accrues nothing:
 * the music still plays, because the licence says it may.
 *
 * Nor does an artist who can't be paid: one whose fees account, checked by
 * this app on the network (identify.js nodePaysFees), can't pay the network
 * fee. Listeners never pay that fee, so until the artist does, listening to
 * them is free, and nothing builds up to be asked for later.
 */
export function bank(ledger, entries, seconds) {
  let next = ledger;
  for (const [url, secs] of Object.entries(seconds)) {
    const entry = entries.find((e) => e.url === url);
    const rate = entry && rateOf(entry.manifest);
    if (!rate || !canPay(entry)) continue;
    // An artist asking to be paid somewhere this wallet's money is not. Build
    // no debt: it could never be settled, and a growing number the listener
    // cannot discharge is worse than nothing owed at all. The app says so
    // rather than letting it happen silently.
    if (!payableHere(rate)) continue;
    next = accrue(next, url, secs, rate.perMinute, { network: networkName() });
  }
  return next;
}

/** Whether this artist's node paid the network fee at the last check. */
export const canPay = (entry) => !!entry?.feesPaid;

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
  // Below a cent, a payment isn't worth its network fee: it waits for more.
  // And nothing is due to an artist who can't be paid right now; it waits
  // for their fees account rather than being tried and refused.
  const due = (held.micros >= threshold || ending || old) && held.micros >= LISTEN_MIN_MICROS && canPay(entry);

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

  const { pay } = await machinery();

  // The last payment to them wasn't seen landing: find out before sending more.
  const unsure = unsureOf(entry.url);
  if (unsure && Date.now() - (unsure.looked || 0) < 30_000) return { ledger, paid: null };
  if (unsure) {
    noteUnsure(entry.url, { ...unsure, looked: Date.now() });
    const landed = await pay.landedSince(pair, recipients, { since: unsure.at, signature: unsure.signature });
    if (landed === null) return { ledger, paid: null };          // can't tell yet: wait
    forgetUnsure(entry.url);
    if (landed > 0) {
      recordSpend(landed);
      return { ledger: settled(loadLedger(), entry.url, landed), paid: { micros: landed, usd: toUsd(landed), recovered: true } };
    }
  }

  // At most one payment's worth, and what's left of today's limit: a debt
  // bigger than that goes in pieces, rather than never.
  const room = DAILY_LIMIT - spentToday();
  const micros = Math.min(owed.micros, MAX_PAYMENT, room);
  if (micros < LISTEN_MIN_MICROS) {
    return { ledger, paid: null, refused: { ok: false, why: "daily", limit: toUsd(DAILY_LIMIT), spent: toUsd(spentToday()) } };
  }

  let result;
  try {
    result = await pay.payArtist(pair, recipients, micros, {
      artistName: entry.manifest.artist?.name,
      // Their node pays the network fee (node/src/settle.ts).
      node: { origin: new URL(entry.url).origin },
    });
  } catch (e) {
    if (e?.kind === "unconfirmed") noteUnsure(entry.url, { micros, signature: e.signature || null });
    throw e;
  }

  recordSpend(micros);
  // Taken off the debt as it stands now: listening banked meanwhile, here or
  // in another tab, still counts.
  return { ledger: settled(loadLedger(), entry.url, micros), paid: { ...result, usd: toUsd(micros) } };
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
      failed.push({ entry, message: e.message, kind: e.kind });
    }
  }

  return { ledger: next, paid, failed };
}

/** Everything owed across the library, for one honest number on screen. */
export function totalOwed(ledger) {
  return Object.values(ledger).reduce((n, held) => n + (held.micros || 0), 0) / 1e6;
}

export { loadLedger, rateStatus, clampRate };

/** Run `job` in one tab at a time, across every tab of this app; a tab that
 *  finds another already paying skips its turn rather than waiting. */
export async function oneTabAtATime(name, job) {
  const locks = typeof navigator !== "undefined" ? navigator.locks : null;
  if (!locks) return job();
  return locks.request(name, { ifAvailable: true }, (lock) => (lock ? job() : null));
}
