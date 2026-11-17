/**
 * "Connect Coinbase", the editor's half (the relay's is coinbase-connect.ts).
 *
 * The editor opens the relay in a new window with a one-time nonce it keeps;
 * Coinbase's sign-in ends back here at /manage with the new deposit address
 * in the fragment. It's taken only with that nonce, so a link someone sends
 * the artist can't put their own address in Who gets paid.
 */
import { RELAY } from "../../app/src/topup.js";

const PENDING_KEY = "amply.editor.coinbase-pending";
export const ANSWER_KEY = "amply.editor.coinbase-answer";
const CONNECTED_KEY = "amply.editor.coinbase-address";
const FRESH_MS = 20 * 60_000;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const read = (store, k) => { try { return JSON.parse(store.getItem(k) || "null"); } catch { return null; } };
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The relay page that starts it, remembering the nonce it was given. */
export function connectLink({ host = location.host, store = localStorage, now = Date.now() } = {}) {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(18)));
  store.setItem(PENDING_KEY, JSON.stringify({ nonce, at: now }));
  return `${RELAY}/coinbase/connect?${new URLSearchParams({ host, nonce })}`;
}

export function startCoinbaseConnect() {
  const url = connectLink();
  // Opened during the tap, so phones allow it; the editor here keeps any
  // unpublished changes.
  const tab = window.open("", "_blank");
  if (tab) { tab.opener = null; tab.location.href = url; } else location.assign(url);
}

/**
 * At startup: an answer in the address bar, kept for the editor if its nonce
 * is the one this browser is waiting for. Returns whether there was one.
 */
export function takeCoinbaseAnswer({ hash = location.hash, store = localStorage, now = Date.now(), clear = () => history.replaceState(null, "", location.pathname + location.search) } = {}) {
  const f = new URLSearchParams(hash.replace(/^#/, ""));
  if (!f.has("coinbase") && !f.has("coinbase-error")) return false;
  clear();
  const pending = read(store, PENDING_KEY);
  if (!pending || pending.nonce !== f.get("nonce") || now - pending.at > FRESH_MS) return false;
  store.removeItem(PENDING_KEY);
  const address = f.get("coinbase");
  const answer = address
    ? (ADDRESS.test(address) ? { address } : { error: "Coinbase sent back something that isn't an address" })
    : { error: f.get("coinbase-error") || "Coinbase didn't connect" };
  store.setItem(ANSWER_KEY, JSON.stringify({ ...answer, at: now }));
  if (answer.address) store.setItem(CONNECTED_KEY, answer.address);
  return true;
}

/** The waiting answer, once. */
export function readCoinbaseAnswer({ store, now = Date.now() } = {}) {
  try { store ??= localStorage; } catch { return null; }
  const a = read(store, ANSWER_KEY);
  if (!a) return null;
  store.removeItem(ANSWER_KEY);
  return now - (a.at || 0) > FRESH_MS ? null : a;
}

/** Whether this address came from Connect Coinbase on this device. */
export function isCoinbaseAddress(address, { store } = {}) {
  try { return !!address && (store ?? localStorage).getItem(CONNECTED_KEY) === address; } catch { return false; }
}
