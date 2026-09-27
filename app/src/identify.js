/**
 * Saying who we are to an artist's node.
 *
 * Only for paid tracks. Everything else is fetched anonymously, which is the
 * default and the reason a link someone shares still works for a stranger.
 *
 * The wallet does both jobs: it pays, and it identifies. So there is no signup,
 * no password and nothing for an artist to store safely. Adding a second artist
 * costs the listener nothing at all.
 */
import { machinery } from "./paying.js";

const TOKENS = "amply.tokens.v1";

const read = () => {
  try { return JSON.parse(localStorage.getItem(TOKENS) || "{}"); } catch { return {}; }
};
const write = (all) => {
  try { localStorage.setItem(TOKENS, JSON.stringify(all)); } catch { /* nothing to do */ }
};

/** The node's own origin, from any URL belonging to it. */
export const originOf = (url) => {
  try { return new URL(url).origin; } catch { return null; }
};

/**
 * Sign a challenge with the wallet, the way the node expects.
 *
 * Ed25519 over the challenge text. A Solana secret key is a 32-byte seed
 * followed by the public key, and WebCrypto wants PKCS8, which for Ed25519 is a
 * fixed header and then the seed.
 */
const PKCS8 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
  0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

/**
 * Never sign anything but a challenge, and never one addressed elsewhere.
 *
 * This key is the listener's money. The string being signed arrives from a
 * stranger's server — anyone can run one, that is the entire design — so
 * signing it as handed over would be signing a blank cheque. Two things go
 * wrong without this check:
 *
 * 1. **It need not be a challenge at all.** A signature is over bytes, and
 *    Solana transactions are bytes. A server that can choose those bytes is
 *    trying to get a transaction signed by a wallet that holds funds. Hard to
 *    pull off through a JSON string, and not a thing to leave to chance.
 * 2. **It need not be addressed to the server that sent it.** The node checks
 *    that a challenge names its own host, but nothing would stop a hostile artist
 *    handing over a challenge naming *another* artist's node, pocketing the
 *    signature, and introducing themselves there as this listener — enough to
 *    inflate their totals, get them banned, or erase their record.
 *
 * So: exactly the shape this protocol defines, naming exactly the host we
 * asked, timed to now, and short. Anything else is refused and nothing is
 * signed.
 */
const CHALLENGE = /^amply:([A-Za-z0-9.:-]{1,255}):(\d{10,16}):([A-Za-z0-9-]{1,64})$/;
const SKEW = 5 * 60_000;

export function challengeIsOurs(text, host, now = Date.now()) {
  if (typeof text !== "string" || text.length > 400) return false;
  const found = CHALLENGE.exec(text);
  if (!found) return false;
  // The host it names must be the host we are talking to. This is the line
  // that stops a signature collected here being spent somewhere else.
  if (found[1].toLowerCase() !== String(host).toLowerCase()) return false;
  return Math.abs(now - Number(found[2])) < SKEW;
}

async function sign(pair, text) {
  const pkcs8 = new Uint8Array(PKCS8.length + 32);
  pkcs8.set(PKCS8);
  pkcs8.set(pair.secretKey.slice(0, 32), PKCS8.length);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(text)));
  const { wallet } = await machinery();
  return wallet.bs58(sig);
}

/** A fresh challenge from this server, checked, then signed: the proof its routes ask for. */
async function signChallenge(pair, origin) {
  const { challenge } = await (await fetch(`${origin}/listen/challenge`, { method: "POST" })).json();
  if (!challengeIsOurs(challenge, new URL(origin).host)) {
    throw new Error("That artist's streaming service asked this app to sign something that is not a valid challenge. Nothing was signed.");
  }
  return { address: pair.publicKey.toBase58(), message: challenge, signature: await sign(pair, challenge) };
}

/**
 * Get a token for this node, using the stored one while it lasts.
 *
 * Tokens are short-lived by design, so that an artist who stops serving a
 * wallet is not waited out for long. Refreshing is one round trip and happens
 * without the listener noticing.
 */
export async function tokenFor(pair, origin) {
  if (!pair || !origin) return null;

  const all = read();
  const kept = all[origin];
  // A minute's margin, so a token cannot expire between here and the request.
  if (kept?.token && kept.until > Date.now() + 60_000) return kept.token;

  let challenge;
  try {
    const res = await fetch(`${origin}/listen/challenge`, { method: "POST" });
    if (!res.ok) return null;
    ({ challenge } = await res.json());
  } catch {
    return null;
  }

  // Before the key touches it. See challengeIsOurs.
  if (!challengeIsOurs(challenge, new URL(origin).host)) {
    throw new Error("That artist's streaming service asked this app to sign something that is not a valid challenge. Nothing was signed.");
  }

  const address = pair.publicKey.toBase58();
  const signature = await sign(pair, challenge);

  const res = await fetch(`${origin}/listen/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, message: challenge, signature }),
  });

  if (res.status === 403) {
    // Refused. Usually this artist has stopped serving this wallet, which the
    // listener should be told plainly rather than shown a dead play button.
    const { error } = await res.json().catch(() => ({}));
    throw new Error(error || "This artist has stopped serving this wallet.");
  }
  if (res.status === 402) {
    // This artist is paid by subscription only, and this wallet has none.
    const e = new Error("Subscribe to hear this artist's paid tracks — the plans are on their page.");
    e.subscribe = true;
    throw e;
  }
  if (!res.ok) return null;

  const { token, subscribedUntil = null } = await res.json();
  // The node's tokens last half an hour; keep ours a little shorter. Whether
  // the wallet is subscribed comes with it, so there is nothing extra to ask.
  all[origin] = { token, until: Date.now() + 25 * 60_000, subscribedUntil };
  write(all);
  return token;
}

/**
 * When this wallet's subscription to this artist runs out, as last told by
 * their server, or null. Known only once a token has been fetched, which the
 * app does before playing anything paid.
 */
export function subscriptionUntil(origin) {
  const until = read()[origin]?.subscribedUntil;
  return Number.isFinite(until) ? until : null;
}

export const isSubscribed = (origin, now = Date.now()) => (subscriptionUntil(origin) ?? 0) > now;

/** Forget the cached pass for an artist, so the next one says whether a
 *  subscription has just started. */
export function forgetToken(origin) {
  const all = read();
  delete all[origin];
  write(all);
}

/** An https page on Stripe's own domain. */
export function isStripePage(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "stripe.com" || u.hostname.endsWith(".stripe.com"));
  } catch { return false; }
}

/**
 * Stripe's page for managing this wallet's subscription to an artist —
 * cancelling it, or changing the card. Signed for, like everything else.
 */
export async function manageSubscription(pair, origin, returnTo = "https://amply.stream/app/") {
  const proof = await signChallenge(pair, origin);
  const res = await fetch(`${origin}/listen/subscription`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...proof, returnTo }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.url) throw new Error(body.error || "Couldn't open the subscription page. Try again in a moment.");
  // The app goes wherever this says, so it must be Stripe's own page: an
  // artist's server (or one pretending) must not be able to send a listener
  // to a look-alike asking for their card.
  if (!isStripePage(body.url)) throw new Error("That artist's streaming service offered a page that isn't Stripe's. It wasn't opened.");
  return body.url;
}

/**
 * Back from Stripe's checkout: tell the artist's server which checkout was
 * ours. Signed for, and believed only if Stripe says it was paid for this
 * wallet. Without a checkout id, the server looks for one — for a listener
 * who paid but never made it back to the app.
 */
export async function claimSubscription(pair, origin, session = "") {
  const proof = await signChallenge(pair, origin);
  const res = await fetch(`${origin}/listen/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...proof, session }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 403) return { outcome: "refused", error: body.error };
  if (!res.ok) throw new Error(body.error || "Couldn't check with Stripe. Try again in a moment.");
  forgetToken(origin); // the next pass says so
  return body;
}

/**
 * A request signed for with the wallet, to an artist's server. One signed
 * challenge serves several requests for a few minutes — a whole album's
 * downloads, say — since the server accepts it until it's five minutes old.
 */
const proofs = new Map();   // origin → { proof, at }
async function proofFor(pair, origin) {
  const kept = proofs.get(origin);
  if (kept && kept.address === pair.publicKey.toBase58() && Date.now() - kept.at < 4 * 60_000) return kept.proof;
  const proof = await signChallenge(pair, origin);
  proofs.set(origin, { proof, at: Date.now(), address: proof.address });
  return proof;
}
export async function signedPost(pair, origin, path, extra = {}) {
  const proof = await proofFor(pair, origin);
  return fetch(`${origin}/listen${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...proof, ...extra }),
  });
}

/** Tell the node a track finished, so the artist can see how much was played. */
export async function reportPlayed(pair, origin, seconds) {
  const token = await tokenFor(pair, origin).catch(() => null);
  if (!token) return;
  try {
    await fetch(`${origin}/listen/played`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ seconds: Math.round(seconds) }),
      keepalive: true,
    });
  } catch { /* the artist's tally is not worth interrupting playback for */ }
}

/**
 * Ask to be forgotten, and prove the row is ours by signing for it.
 *
 * The listener holds the key, so no documents and no mailbox: the node deletes
 * the row on the spot.
 */
export async function askToBeForgotten(pair, origin) {
  const proof = await signChallenge(pair, origin);
  const res = await fetch(`${origin}/listen/forget`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(proof),
  });
  if (!res.ok) throw new Error("That artist's streaming service refused the request.");
  const all = read();
  delete all[origin];
  write(all);
}

/**
 * Ask what this artist's server holds about our wallet.
 *
 * The right of access, answered without anyone's involvement: the listener
 * signs for their wallet, and the server sends back the one row it keeps.
 */
export async function whatTheyHold(pair, origin) {
  const proof = await signChallenge(pair, origin);
  const res = await fetch(`${origin}/listen/mine`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(proof),
  });
  if (res.status === 404) {
    throw new Error("This artist's streaming service is older than this feature. They need to update it.");
  }
  if (!res.ok) throw new Error("That artist's streaming service refused the request.");
  return res.json();
}

/** Audio for a paid track needs the token in the URL: a media element sends
 *  no headers of ours. */
export const audioUrl = (url, token) =>
  (token ? `${url}${url.includes("?") ? "&" : "?"}t=${encodeURIComponent(token)}` : url);
