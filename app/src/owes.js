/**
 * What an artist's server says this wallet still owes them.
 *
 * The app keeps its own ledger of listening (spend.js), and normally pays from
 * that. But an artist can turn on Auto-block, and then their server stops
 * handing out passes to a wallet that is behind on paying: it refuses
 * `/listen/token` with `{ code: "unpaid", owes }`, in micros. The ledger on
 * this device may not know about that debt at all — a new phone, cleared
 * storage, listening priced at a rate this app never banked — so the server's
 * number is the one that lifts the block, and the one that gets paid.
 *
 * This file is only bookkeeping, with no network and no payment libraries:
 * what each artist's server last said, how long to wait before trying again
 * (kept on the device, so a reload or a closed app doesn't lose it), and the
 * payments the server may not have counted yet, so the same debt is never
 * paid twice while its server catches up. paying.js does the paying.
 */
import { LISTEN_MIN_MICROS, LISTEN_MAX_MICROS } from "../../spec/pricing.mjs";

const CLAIMS = "amply.nodeowes.v1";
const CREDITS = "amply.nodecredits.v1";
const REPORTED = "amply.reported.v1";

const read = (key, fallback) => {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
};
const write = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
};

// ── reading the server's answer ─────────────────────────────────────────────

/**
 * A `/listen/token` refusal that means "pay first", or null for any other.
 *
 * The number is a stranger's, so it has to be a whole, non-negative number of
 * micros, and not an absurd one: a server can say anything, and what it says
 * here decides what is put to the listener as owed.
 */
export const MAX_CLAIM_MICROS = 1_000_000_000;   // $1,000: past this it's nonsense, not a debt
export function unpaidRefusal(status, body) {
  if (status !== 403 || !body || body.code !== "unpaid") return null;
  const owes = Number(body.owes);
  if (!Number.isSafeInteger(owes) || owes < 0 || owes > MAX_CLAIM_MICROS) return null;
  return { owes, error: typeof body.error === "string" ? body.error.slice(0, 300) : "" };
}

/**
 * What a pass (a `/listen/token` success) says is still owed, in micros, or
 * null when it doesn't say or says nonsense. Read as strictly as a refusal.
 */
export function passOwes(body) {
  if (!body || body.owes == null) return null;
  const owes = Number(body.owes);
  if (!Number.isSafeInteger(owes) || owes < 0 || owes > MAX_CLAIM_MICROS) return null;
  return owes;
}

/** The artist's payment point (settleAt, dollars) in micros: $1 when unset,
 *  as the spec says. */
export function settleAtMicros(manifest) {
  const usdc = (manifest?.payment || []).find((p) => p?.type === "solana-usdc");
  const at = Number(usdc?.settleAt);
  return Math.round((at > 0 ? at : 1) * 1_000_000);
}

/**
 * Whether what a server said was owed alongside a pass is to be paid now, as
 * if it had refused the pass: when it's at least the artist's payment point
 * (and at least a cent, the least one payment can be). That covers "behind"
 * as the server judges it too (more than one and a half payment points
 * unpaid, spec/standing.mjs), which is always past the point. Below it,
 * nothing is done: the app's own ledger settles as usual, at the point or
 * within the week, and the server's number is the artist's to see.
 */
export function passOwesDue(owes, manifest) {
  return Number.isSafeInteger(owes) && owes >= LISTEN_MIN_MICROS && owes >= settleAtMicros(manifest);
}

/**
 * A pass said this much is owed: note it as a claim, exactly as a refusal's
 * would be (so it's paid the same way, with the same back-off and sheet),
 * when it's due (passOwesDue). Returns the claim, or null.
 */
export function claimFromPass(entry, owes, now = Date.now()) {
  if (!entry?.url || !passOwesDue(owes, entry.manifest)) return null;
  return noteClaim(entry.url, owes, now);
}

// ── what each server last said ──────────────────────────────────────────────

/** `{ [manifestUrl]: { owes, remaining, at, tries, next, kind, message } }` */
export const claims = () => read(CLAIMS, {});
export const claimOf = (url) => claims()[url] || null;

/**
 * Record what an artist's server says is owed.
 *
 * `remaining` is what is still to send: the server's number, less payments
 * it may not have counted yet (credits). A claim already on file keeps its
 * back-off, so tapping play again and again doesn't hammer anyone; a new one
 * is due straight away.
 */
export function noteClaim(url, owes, now = Date.now()) {
  const all = claims();
  const had = all[url];
  const next = {
    owes, remaining: Math.max(0, owes - pendingCredit(url, now)), at: now,
    tries: had?.tries || 0, next: had ? had.next || 0 : 0,
    kind: had?.kind || null, message: had?.message || null,
  };
  write(CLAIMS, { ...all, [url]: next });
  return next;
}

/** Some of it has been paid: less to send. */
export function paidTowards(url, micros) {
  const all = claims();
  if (!all[url]) return null;
  const remaining = Math.max(0, all[url].remaining - micros);
  write(CLAIMS, { ...all, [url]: { ...all[url], remaining } });
  return remaining;
}

/** Paid, and the server agrees: nothing more to do for this artist. */
export function clearClaim(url) {
  const all = claims();
  if (!(url in all)) return;
  delete all[url];
  write(CLAIMS, all);
}

// ── trying again, patiently ─────────────────────────────────────────────────

/** How long to wait after each failed try in a row: quick at first, then no
 *  more than an hour apart. It never stops: an hour is the slowest. */
export const BACKOFF_MS = [30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000];
export const backoffFor = (tries) => BACKOFF_MS[Math.min(Math.max(tries, 1), BACKOFF_MS.length) - 1];

/** A try didn't finish it: when to try next, and why, kept on the device. */
export function backOff(url, kind = null, message = null, now = Date.now()) {
  const all = claims();
  const had = all[url];
  if (!had) return null;
  const tries = (had.tries || 0) + 1;
  const next = { ...had, tries, next: now + backoffFor(tries), kind, message };
  write(CLAIMS, { ...all, [url]: next });
  return next;
}

/** Whether this artist's claim may be tried now. */
export const claimDue = (claim, now = Date.now()) => !!claim && !(claim.next > now);

/**
 * Something changed that may be what was missing: money arrived, the network
 * came back. Those waiting for that (or every claim, with no kinds given) may
 * be tried at once.
 */
export function wakeClaims(kinds = null) {
  const all = claims();
  let changed = false;
  for (const [url, c] of Object.entries(all)) {
    if (kinds && !kinds.includes(c.kind)) continue;
    if (c.next) { all[url] = { ...c, next: 0 }; changed = true; }
  }
  if (changed) write(CLAIMS, all);
  return changed;
}

// ── payments the server may not have counted yet ────────────────────────────
//
// A payment the artist's server sent but hadn't seen land (`confirmed: false`
// from /listen/settle) isn't on its books until the app reports it at
// /listen/paid, or the server finds it. Until then, its next refusal still
// counts it as owed. Held here for a day and taken off what the server says,
// so the app waits for the server to catch up rather than paying again.

// A day: told again every couple of minutes meanwhile (identify.js
// resendPaid), so a server down for a while still hears of it before the app
// would take its word that the money is owed.
const CREDIT_MS = 24 * 60 * 60_000;
export function noteCredit(url, signature, micros, now = Date.now()) {
  const all = read(CREDITS, []).filter((c) => now - c.at < CREDIT_MS && c.signature !== signature);
  all.push({ url, signature, micros, at: now });
  write(CREDITS, all.slice(-50));
}
/** The server has it on its books now. */
export function dropCredit(signature) {
  const all = read(CREDITS, []);
  const left = all.filter((c) => c.signature !== signature);
  if (left.length !== all.length) write(CREDITS, left);
}
/** Payments still waiting for the server to count them, with a signature to tell it by. */
export const pendingCredits = (now = Date.now()) =>
  read(CREDITS, []).filter((c) => now - c.at < CREDIT_MS && c.signature && !String(c.signature).startsWith("unsure:"));
export const pendingCredit = (url, now = Date.now()) =>
  read(CREDITS, []).filter((c) => c.url === url && now - c.at < CREDIT_MS).reduce((n, c) => n + (c.micros || 0), 0);

// ── telling the server about a payment, once ────────────────────────────────

export const reported = (signature) => read(REPORTED, []).includes(signature);
export function markReported(signature) {
  const all = read(REPORTED, []).filter((s) => s !== signature);
  all.push(signature);
  write(REPORTED, all.slice(-200));
}

// ── how to send it ──────────────────────────────────────────────────────────

/**
 * A debt as the payments that send it.
 *
 * At least a cent — a server pays no network fee for less, so less than that
 * is rounded up to a cent rather than left blocking someone — and no single
 * payment over the most a server takes for listening. A debt bigger than that
 * is cut into equal pieces rather than full ones and a crumb, so the last
 * piece is never too small to send.
 */
export function pieces(micros) {
  if (!(micros > 0)) return [];
  const total = Math.max(Math.round(micros), LISTEN_MIN_MICROS);
  const n = Math.ceil(total / LISTEN_MAX_MICROS);
  const base = Math.floor(total / n), extra = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}
