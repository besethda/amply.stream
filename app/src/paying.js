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
  loadLedger, accrue, settled, rateStatus, recordSpend, clampRate, spentToday, agreements, MAX_PAYMENT, DAILY_LIMIT,
} from "./spend.js";
import {
  claimOf, noteClaim, clearClaim, paidTowards, backOff, claimDue, noteCredit, pieces,
} from "./owes.js";
import { toUsd } from "./money.js";
import { recordReceipt } from "./receipts.js";

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
export async function settle(pair, entry, ledger, { ending = false, report = noReport } = {}) {
  const owed = owing(entry, ledger, { ending });
  if (!owed?.due) return { ledger, paid: null };

  const where = payees(entry, ledger);
  if (where.refused) return { ledger, paid: null, refused: where.refused };
  const { recipients } = where;

  const { pay } = await machinery();

  // The last payment to them wasn't seen landing: find out before sending more.
  const before = await lookAgain(pair, entry, recipients, pay, { report });
  if (before.wait) return { ledger, paid: null };
  if (before.landed > 0) {
    return { ledger: loadLedger(), paid: { micros: before.landed, usd: toUsd(before.landed), recovered: true } };
  }

  // At most one payment's worth, and what's left of today's limit: a debt
  // bigger than that goes in pieces, rather than never.
  const room = DAILY_LIMIT - spentToday();
  const micros = Math.min(owed.micros, MAX_PAYMENT, room);
  if (micros < LISTEN_MIN_MICROS) {
    return { ledger, paid: null, refused: { ok: false, why: "daily", limit: toUsd(DAILY_LIMIT), spent: toUsd(spentToday()) } };
  }

  const result = await sendPiece(pair, entry, recipients, micros, pay, { report });
  // Taken off the debt as it stands now: listening banked meanwhile, here or
  // in another tab, still counts.
  return { ledger: loadLedger(), paid: { ...result, usd: toUsd(micros) } };
}

/** Nobody to tell: the default for `report`, which the app sets to
 *  identify.js reportPaid (passed in, so this file needn't import it). */
const noReport = async () => false;

/**
 * Who to pay for this artist, from this wallet, or why it can't be done.
 *
 * Settled in the money it was earned in, which is not necessarily what the
 * manifest says today. An artist who switches to testing after somebody has
 * listened is still owed for the listening: refusing on today's setting
 * would strand a real debt for good. What their change does stop is any
 * further debt accruing — see bank().
 *
 * The wallet still has to be on that network, because that is where the
 * money is. An older debt from before this was recorded is payable wherever
 * the listener is now, rather than stranded for want of a field.
 */
function payees(entry, ledger) {
  const rate = rateOf(entry.manifest);
  if (!rate) return { refused: "nobody to pay" };
  const owedOn = ledger[entry.url]?.network;
  if (owedOn && owedOn !== networkName()) {
    return { refused: NETWORKS[owedOn]?.real
      ? "This was owed in real money. Switch your wallet back to Solana to send it."
      : "This was owed in play money, on the test network. Switch your wallet there to send it." };
  }
  if (!owedOn) {
    const wrong = mismatch(rate);
    if (wrong) return { refused: wrong };
  }
  const recipients = (rate.recipients || []).filter((r) => r.address);
  if (!recipients.length) return { refused: "nobody to pay" };
  return { recipients };
}

/**
 * The last payment to this artist wasn't seen landing: did it? Until the
 * network can say, nothing more is sent (`wait`). What landed comes off the
 * debt — the device's, and any the artist's server has claimed — and the
 * server is told, in case it hadn't counted it.
 */
async function lookAgain(pair, entry, recipients, pay, { report = noReport } = {}) {
  const unsure = unsureOf(entry.url);
  if (!unsure) return { landed: 0 };
  if (Date.now() - (unsure.looked || 0) < 30_000) return { wait: true };
  noteUnsure(entry.url, { ...unsure, looked: Date.now() });
  const landed = await pay.landedSince(pair, recipients, { since: unsure.at, signature: unsure.signature, upTo: unsure.micros });
  if (landed === null) return { wait: true };          // can't tell yet: wait
  forgetUnsure(entry.url);
  if (landed > 0) {
    recordReceipt({ micros: landed, signature: unsure.signature || null, origin: originOf(entry.url), artist: entry.manifest?.artist?.name, network: networkName() });
    recordSpend(landed);
    settled(loadLedger(), entry.url, landed);
    paidTowards(entry.url, landed);
    // Its server may not know: that answer was what got lost.
    noteCredit(entry.url, unsure.signature || `unsure:${unsure.at}`, landed);
    if (unsure.signature) report(originOf(entry.url), unsure.signature).catch(() => {});
  }
  return { landed };
}

/**
 * Send one payment and book it. A payment that may have gone out is
 * remembered before anything else happens, so it is never sent twice; one
 * that went out is taken off what is owed, here and in any claim from the
 * artist's server. If that server hadn't seen it land when it answered, it
 * may not have counted it, so it's told (once, without waiting) and, until
 * it says it has, the app doesn't pay that money again on its word.
 */
async function sendPiece(pair, entry, recipients, micros, pay, { report = noReport } = {}) {
  let result;
  // Remembered before it goes, not after: if the app is closed while the
  // payment is in flight, the next start looks for it on the network
  // (lookAgain) before sending anything, instead of sending it again.
  noteUnsure(entry.url, { micros, signature: null });
  try {
    result = await pay.payArtist(pair, recipients, micros, {
      artistName: entry.manifest.artist?.name,
      // Their node pays the network fee (node/src/settle.ts).
      node: { origin: originOf(entry.url) },
    });
  } catch (e) {
    // Maybe sent: kept, with its signature to look it up by. Anything else
    // is a definite no — nothing went out.
    if (e?.kind === "unconfirmed") noteUnsure(entry.url, { micros, signature: e.signature || null });
    else forgetUnsure(entry.url);
    throw e;
  }
  forgetUnsure(entry.url);
  recordSpend(micros);
  settled(loadLedger(), entry.url, micros);
  paidTowards(entry.url, micros);
  if (result?.nodeConfirmed === false && result.signature) {
    noteCredit(entry.url, result.signature, micros);
    report(originOf(entry.url), result.signature).catch(() => {});
  }
  return result;
}

const originOf = (url) => { try { return new URL(url).origin; } catch { return null; } };

// ── paying what an artist's server says is owed (Auto-block) ────────────────

/**
 * Pay what this artist's server says is owed, after it refused this wallet a
 * pass (owes.js). Unlike the ledger, there's no waiting for the artist's
 * amount or the week: the listener can't hear them until it's paid.
 *
 * The server's number is a stranger's, and nothing is paid on it alone:
 *
 * - **Sent without asking** only as far as this device's own ledger for that
 *   artist goes (what it counted itself), to an artist the listener has
 *   agreed a price with here, within the daily limit and a dollar a day per
 *   artist. An empty ledger (a new device) pays nothing without asking.
 * - **Anything more** waits for the listener's tap (`explicit`), which is
 *   their agreement to at most the amount shown to them (`max`); the daily
 *   limit doesn't hold that back, as a debt over it could otherwise never be
 *   paid in one go.
 * - **In pieces** of no more than one payment's worth (the most an artist's
 *   server takes for listening, which is also the app's own per-payment
 *   limit), at least a cent, and never more than the wallet holds: what the
 *   wallet can pay goes now, and the rest when money is added.
 * - **Never twice**: a payment not yet seen landing is looked up first, and
 *   one the server may not have counted is taken off its number.
 *
 * Returns `{ state, paid: [micros…], message? }`. `state` is "paid" (nothing
 * left to send: ask the server for a pass again), "counting" (paid, the server
 * hasn't caught up), "ask" (needs the listener's tap; `why` says why),
 * "funds" (not enough in the wallet), "unsure" (a payment's fate unknown
 * yet), "mismatch" (wrong network: `message`), or "none". A failure to send
 * throws, with the payment error's `kind` ("paused" when the artist's fees
 * account can't pay, "network", …), and leaves the claim to be tried again.
 */
export async function settleClaim(pair, entry, { explicit = false, max = null, balanceMicros = null, report = noReport, agreed = agreements(), now = Date.now() } = {}) {
  const url = entry.url;
  if (!claimOf(url)) return { state: "none", paid: [] };
  const where = payees(entry, loadLedger());
  if (where.refused) return { state: "mismatch", paid: [], message: typeof where.refused === "string" ? where.refused : "" };
  if (!explicit && agreed[url] == null) return { state: "ask", why: "consent", paid: [] };

  const { pay } = await machinery();
  const paid = [];
  const before = await lookAgain(pair, entry, where.recipients, pay, { report });
  if (before.wait) return { state: "unsure", paid };
  if (before.landed > 0) paid.push(before.landed);

  let left = claimOf(url)?.remaining ?? 0;
  if (left <= 0) return { state: paid.length ? "paid" : "counting", paid };

  // The server's number is a stranger's, and this app relies on nothing an
  // artist's server says about what's owed. Without a tap, only as much of it
  // is paid as this device itself counted — what its ledger says is owed to
  // them, which every payment takes down — and no more than a dollar a day to
  // any one artist. Anything beyond that is the listener's call, shown both
  // figures. With a tap, never more than the amount the tap was for, however
  // the server's number has changed since.
  let more = false;
  if (explicit && max != null) {
    if (left > max) { left = Math.max(0, max); more = true; }
  } else if (!explicit) {
    const vouched = loadLedger()[url]?.micros || 0;
    const room = Math.min(vouched, UNATTENDED_DAY_MICROS - autoPaidToday(url, now));
    if (room < LISTEN_MIN_MICROS) return { state: "ask", why: "claim", paid };
    if (left > room) { left = room; more = true; }
  }

  // Less than a cent can't be sent on its own (pieces() would round it up to
  // one): it waits, rather than pay more than was counted or shown.
  if (left < LISTEN_MIN_MICROS) return { state: "ask", why: "claim", paid };

  let wallet = balanceMicros;
  for (const piece of pieces(left)) {
    let micros = piece;
    if (!explicit && micros > DAILY_LIMIT - spentToday()) return { state: "ask", why: "daily", paid };
    if (wallet != null && wallet < micros) {
      // What the wallet holds goes now, if it's enough to send; the rest
      // when money is added.
      if (wallet < LISTEN_MIN_MICROS) return { state: "funds", paid };
      micros = wallet;
    }
    try {
      await sendPiece(pair, entry, where.recipients, micros, pay, { report });
    } catch (e) {
      e.paid = paid;
      throw e;
    }
    paid.push(micros);
    if (!explicit) noteAutoPaid(url, micros, now);
    if (wallet != null) {
      wallet -= micros;
      if (micros < piece) return { state: "funds", paid };
    }
  }
  return more ? { state: "ask", why: "claim", paid } : { state: "paid", paid };
}

/** The most a server's claim draws from one artist in a day without a tap. */
export const UNATTENDED_DAY_MICROS = 1_000_000;
const AUTO = "amply.claimauto.v1";
const dayOf = (now) => new Date(now).toISOString().slice(0, 10);
function autoPaidToday(url, now) {
  try { const a = JSON.parse(localStorage.getItem(AUTO) || "{}"); return a.day === dayOf(now) ? a.paid?.[url] || 0 : 0; } catch { return 0; }
}
function noteAutoPaid(url, micros, now) {
  try {
    const a = JSON.parse(localStorage.getItem(AUTO) || "{}");
    const today = a.day === dayOf(now) ? a : { day: dayOf(now), paid: {} };
    today.paid[url] = (today.paid[url] || 0) + micros;
    localStorage.setItem(AUTO, JSON.stringify(today));
  } catch { /* fine: the daily limit still holds */ }
}

/**
 * One go at an artist's claim, start to finish: pay it (settleClaim), then
 * ask their server for a pass again (`token(origin)`, identify.js tokenFor).
 * A pass means it's settled, and the claim is forgotten. A fresh refusal
 * updates what's owed, to be tried again shortly — never straight away, so a
 * server whose books lag can't draw payment after payment in a loop.
 *
 * Whatever doesn't finish it is booked as a back-off on the claim, kept on
 * the device: every try is followed by another, sooner or later, until the
 * server says it's paid. Nothing here gives up.
 */
export async function payClaim(pair, entry, { explicit = false, max = null, balanceMicros = null, report = noReport, token = null, now = () => Date.now() } = {}) {
  const url = entry.url;
  let r;
  try {
    r = await settleClaim(pair, entry, { explicit, max, balanceMicros, report, now: now() });
  } catch (e) {
    backOff(url, e.kind || "unknown", e.message, now());
    throw e;
  }
  if (r.state === "none") return r;
  if ((r.state === "paid" || r.state === "counting") && token) {
    try {
      await token(originOf(url));
      clearClaim(url);
      return { ...r, state: "clear" };
    } catch (e) {
      if (e?.unpaid) {
        const c = noteClaim(url, e.owes, now());
        backOff(url, c.remaining > 0 ? "owes" : "counting", null, now());
        return { ...r, state: c.remaining > 0 ? "owes" : "counting", owes: e.owes };
      }
      backOff(url, "token", e?.message || null, now());
      return { ...r, state: "token", message: e?.message || "" };
    }
  }
  backOff(url, r.state === "ask" ? `ask-${r.why}` : r.state, r.message || null, now());
  return r;
}

/**
 * Settle everyone who is due.
 *
 * One artist failing must not stop the others being paid, so each is attempted
 * on its own and the failures are reported rather than thrown.
 *
 * An artist whose server has said what's owed (a claim, owes.js) is paid
 * that way instead, as its back-off allows, and not from the ledger as well:
 * the server's number already covers the ledger's, and paying both would pay
 * the same listening twice.
 */
export async function settleAll(pair, entries, ledger, { ending = false, report = noReport, token = null, balanceMicros = null, now = Date.now(), fromLedger = true } = {}) {
  let next = ledger;
  const paid = [];
  const failed = [];
  const claimed = [];

  for (const entry of entries) {
    const claim = claimOf(entry.url);
    if (claim) {
      if (!claimDue(claim, now)) continue;
      try {
        const r = await payClaim(pair, entry, { balanceMicros, report, token });
        claimed.push({ entry, ...r });
        const sum = r.paid.reduce((n, m) => n + m, 0);
        if (sum > 0) {
          paid.push({ entry, micros: sum, usd: toUsd(sum) });
          if (balanceMicros != null) balanceMicros = Math.max(0, balanceMicros - sum);
        }
      } catch (e) {
        failed.push({ entry, message: e.message, kind: e.kind, claim: true });
      }
      next = loadLedger();
      continue;
    }
    // `fromLedger: false`: only claims are due this time (the ledger's own
    // retry is still waiting out its minute).
    if (!fromLedger || !owing(entry, next, { ending })?.due) continue;
    try {
      const result = await settle(pair, entry, next, { ending, report });
      next = result.ledger;
      if (result.paid) {
        paid.push({ entry, ...result.paid });
        if (balanceMicros != null) balanceMicros = Math.max(0, balanceMicros - result.paid.micros);
      }
    } catch (e) {
      failed.push({ entry, message: e.message, kind: e.kind });
    }
  }

  return { ledger: next, paid, failed, claimed };
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

/**
 * Every payment for listening goes through here: one at a time in this tab,
 * and one tab at a time (oneTabAtATime). A second caller while one is under
 * way — the background loop, a Pay button, unfollowing an artist — gets null
 * at once, rather than reading a debt the first is part-way through paying
 * and paying it again.
 */
let busy = false;
export async function exclusive(job) {
  if (busy) return null;
  busy = true;
  try { return await oneTabAtATime("amply-pay", job); } finally { busy = false; }
}
export const paymentUnderWay = () => busy;
