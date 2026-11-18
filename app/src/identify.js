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
import { NETWORKS, networkFor } from "./networks.js";
import { FEES_READY_LAMPORTS } from "../../spec/pricing.mjs";
import { unpaidRefusal, passOwes, reported, markReported, dropCredit } from "./owes.js";

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
    const body = await res.json().catch(() => ({}));
    // Auto-block: their server won't serve this wallet until it has been paid
    // what it says is owed. Not a ban: paying lifts it, so the app is told
    // how much (owes.js), and pays.
    const unpaid = unpaidRefusal(res.status, body);
    if (unpaid) {
      const e = new Error(unpaid.error || "This artist is waiting to be paid for listening you've already done.");
      e.unpaid = true;
      e.owes = unpaid.owes;
      throw e;
    }
    // Refused. Usually this artist has stopped serving this wallet, which the
    // listener should be told plainly rather than shown a dead play button.
    throw new Error(body?.error || "This artist has stopped serving this wallet.");
  }
  if (res.status === 402) {
    // This artist is paid by subscription only, and this wallet has none.
    const e = new Error("Subscribe to hear this artist's paid tracks — the plans are on their page.");
    e.subscribe = true;
    throw e;
  }
  if (!res.ok) return null;

  const body = await res.json();
  const { token, subscribedUntil = null } = body;
  // The node's tokens last half an hour; keep ours a little shorter. Whether
  // the wallet is subscribed comes with it, so there is nothing extra to ask.
  // So does what the node says is still unpaid (`owes`, micros), kept until
  // the app looks at it once (takePassOwes): the node meters what it sends,
  // so it may know of listening this device never banked.
  all[origin] = { token, until: Date.now() + 25 * 60_000, subscribedUntil, owes: passOwes(body) };
  write(all);
  return token;
}

/**
 * What the node said was still owed when it last handed out a pass, in
 * micros, or null; then forgotten, so it's acted on once per pass and an old
 * number can't be paid again after it has been paid.
 */
export function takePassOwes(origin) {
  const all = read();
  const owes = all[origin]?.owes;
  if (owes == null) return null;
  all[origin] = { ...all[origin], owes: null };
  write(all);
  return owes;
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

/** Tell the artist's node a song finished, for its per-song total. Nothing
 *  about the listener is recorded. A paid track is counted only with the
 *  listener's pass (`token`), which goes in the address the way it does for
 *  the audio itself, so no extra header needs the node's leave; a free one
 *  needs none, and is sent without. */
export async function reportHeard(origin, track, seconds, token = null) {
  if (!(seconds >= 30)) return;
  try {
    await fetch(audioUrl(`${origin}/listen/heard`, token), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ track, seconds: Math.round(seconds) }),
      keepalive: true,
      credentials: "omit",
    });
  } catch { /* not worth interrupting playback for */ }
}

/**
 * Tell an artist's server about a payment that landed after it had stopped
 * waiting for it (`/listen/settle` answered `confirmed: false`). Until it
 * knows, it still counts that money as owed, and with Auto-block on it would
 * keep refusing this wallet. It checks the payment on the network itself, so
 * all it needs is the signature.
 *
 * Once per signature, and only after this app has seen it land. Best effort:
 * nothing waits on it, and a failure costs nothing but a wait, since the
 * server finds payments for itself too. Returns whether it was taken.
 */
export async function reportPaid(origin, signature) {
  if (!origin || !signature || reported(signature)) return false;
  let res;
  try {
    res = await fetch(`${origin}/listen/paid`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signature }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return false;          // never reached it: may be told next time it lands
  }
  // An answer of any kind counts as telling it: a refusal won't change by
  // asking again, and this is its own network lookup each time.
  markReported(signature);
  if (res.ok) { dropCredit(signature); return true; }
  return false;
}

/** Tell the node a track finished, so the artist can see how much was played,
 *  and which song (its id): the node bills the larger of this and what it
 *  sent for that song, so naming it is what keeps the two from both being
 *  charged. */
export async function reportPlayed(pair, origin, seconds, track = null) {
  const token = await tokenFor(pair, origin).catch(() => null);
  if (!token) return;
  try {
    // The pass goes in the address, as for audio and /heard: an Authorization
    // header isn't one the artist's server lets other sites send, so the
    // browser would refuse the report before it left.
    await fetch(audioUrl(`${origin}/listen/played`, token), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(track ? { seconds: Math.round(seconds), track: String(track) } : { seconds: Math.round(seconds) }),
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

/**
 * Whether this artist can be paid from this app: their node pays the network
 * fee, so listeners never do. Asked with nothing about the listener, and a no
 * on any doubt.
 *
 * The node's word isn't taken for it. The app looks at the fees account on
 * the network itself, and only an account holding enough to pay counts. A
 * node that says yes and can't pay would have listeners owing money nobody
 * can send. Each payment asks the node again (pay.js); a no then stops
 * charging for this artist too.
 */
export async function nodePaysFees(origin, network) {
  try {
    const res = await fetch(`${origin}/listen/fees`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return false;
    const o = await res.json();
    // The node says the manifest's word for its money ("solana"); this app
    // says its own ("mainnet"). networkFor is the one map between them.
    if (typeof o?.feePayer !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(o.feePayer)) return false;
    if (networkFor(o.network) !== network || !NETWORKS[network]) return false;
    return (await lamportsOf(NETWORKS[network].rpc, o.feePayer)) >= FEES_READY_LAMPORTS;
  } catch {
    return false;
  }
}

/** A wallet's SOL, straight from the network, without the payment libraries. */
async function lamportsOf(rpc, address) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [address, { commitment: "confirmed" }] }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return 0;
  const body = await res.json();
  return Number(body?.result?.value) || 0;
}
