/**
 * Reading an artist's manifest.
 *
 * The rules come from spec/manifest-rules.mjs, the same file the command-line
 * validator and the artist's editor use. A listening app that accepted
 * manifests the spec rejects would make the spec a suggestion.
 */
import { needsWallet } from "../../spec/pricing.mjs";
import { validate, MAX_BYTES } from "../../spec/manifest-rules.mjs";
import { bareDomain, lookup, confirms } from "../../spec/domain.mjs";
import { COLOR_RE } from "../../spec/colors.mjs";

/** Accept a pasted address in any of the forms a person might have. */
export function manifestUrl(input) {
  let raw = String(input || "").trim();
  if (!raw) throw new Error("Paste an artist's link first.");
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("That doesn't look like a web address.");
  }
  // Plain http would let anyone on the network swap the payment address, which
  // is the one thing in a manifest worth tampering with.
  if (url.protocol !== "https:") throw new Error("An artist's link has to start with https.");

  if (!/\/manifest\.json$/.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/+$/, "") + "/manifest.json";
  }
  url.hash = "";
  return url.toString();
}

/**
 * Fetch an artist's manifest from whatever the listener typed.
 *
 * A bare domain — "taylorswift.com" — is looked up first: if its owner has
 * linked it to a streaming service with a DNS record, that is where the music
 * is, and the domain is kept as proof of who it belongs to. Otherwise it is
 * tried as an address in its own right, which is how a service hosted at
 * listen.theirname.com is reached.
 */
export async function fetchManifest(input) {
  const domain = bareDomain(input);
  if (domain) {
    const linked = await lookup(domain).catch(() => null);
    if (linked) {
      // Fetched directly, never looked up again: a record pointing at another
      // bare domain must not be able to send this round in circles.
      const found = await fetchAt(manifestUrl(linked));
      return { ...found, domain };
    }
  }
  return fetchAt(manifestUrl(input));
}

/**
 * Is this artist really who their domain says?
 *
 * The manifest can name a domain (artist.domain) and the domain can name the
 * manifest (its _amply record). Only both together mean anything: either one
 * alone could be written by anybody. Returns the domain when they agree.
 */
export async function verifiedDomain(url, manifest, alreadyShown = null) {
  const claimed = bareDomain(manifest?.artist?.domain || alreadyShown || "");
  if (!claimed) return null;
  return (await confirms(claimed, url).catch(() => false)) ? claimed : null;
}

async function fetchAt(url) {
  let res;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch {
    throw new Error("Couldn't reach that address. It may be offline, or the link may be wrong.");
  }
  if (res.status === 404) throw new Error("There's no music published at that address yet.");
  if (!res.ok) throw new Error(`That address answered with an error (${res.status}).`);
  if (Number(res.headers.get("Content-Length") || 0) > MAX_BYTES) throw new Error("That manifest is too large to be genuine.");

  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error("That manifest is too large to be genuine.");

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("That address didn't return a music manifest.");
  }

  const { errors } = validate(parsed);
  if (errors.length) {
    throw new Error(`That manifest isn't valid, so it can't be trusted: ${errors[0]}`);
  }

  return { url, manifest: parsed };
}

/** An image address from a manifest, made absolute against the manifest's own
 *  address. Only https is kept. */
function absolute(src, base) {
  if (!src) return null;
  try { const u = new URL(src, base); return u.protocol === "https:" ? u.href : null; } catch { return null; }
}

/** A release's colours, keeping only well-formed ones; null if none. */
function colorsOf(c) {
  if (!c || typeof c !== "object") return null;
  const out = {};
  for (const k of ["accent", "deep"]) if (COLOR_RE.test(String(c[k]))) out[k] = c[k];
  return Object.keys(out).length ? out : null;
}

/** Every track in one list, in release order, each knowing where it came from. */
export function tracksOf(entry) {
  if (entry.local) return entry.tracks;          // songs on this phone (local.js), already tracks
  const out = [];
  for (const release of entry.manifest.releases || []) {
    for (const track of release.tracks || []) {
      out.push({
        ...track,
        // Decided by the same rule the artist's server enforces, so the app
        // identifies itself for exactly the tracks that will demand it. If the
        // two disagreed, a paid track would refuse to play.
        needsWallet: needsWallet(entry.manifest, track),
        // Artwork as a full address — the lock screen can't resolve a relative
        // one — and the artist's photo when a release has none.
        releaseId: release.id, releaseTitle: release.title, from: entry.url,
        art: absolute(release.art, entry.url) || absolute(entry.manifest.artist?.image, entry.url),
        // For the waveform: how loud the song is moment by moment, and the
        // cover's colours (spec/waves.mjs, spec/colors.mjs). Either may be missing.
        waves: absolute(track.waves, entry.url),
        colors: colorsOf(release.colors),
      });
    }
  }
  return out;
}

/** The metered payment method, if the artist offers one this client understands. */
export function rateOf(manifest) {
  const wallet = (manifest.payment || []).find((p) => p.type === "solana-usdc");
  if (!wallet) return null;
  return {
    perMinute: wallet.ratePerMinute,
    settleAt: wallet.settleAt ?? 1,
    // Absent means real money. A manifest written before this field existed
    // was asking for real money, and a manifest that does not raise the
    // question is not asking to be paid in something worthless.
    network: wallet.network || "solana",
    recipients: wallet.recipients
      || [{ name: manifest.artist?.name, address: wallet.address, split: 100 }],
  };
}
