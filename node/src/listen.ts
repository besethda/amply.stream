/**
 * Letting a listener say who they are.
 *
 * The listener's wallet is their identity. They ask the node for a challenge,
 * sign it with the key that also pays, and get back a short-lived token.
 *
 * If the artist charges, every track is served only with that token, except
 * the ones they have made free — see spec/pricing.mjs, which the app reads
 * too. A listener with no wallet hears the free tracks and nothing else.
 *
 * What this does not check is whether the listening was paid for. It
 * identifies, and the artist's editor reads the chain to show who has listened
 * without paying, so the artist can stop serving them. A stopped wallet is
 * refused here, and loses the music within a token's lifetime. See
 * docs/identity.md.
 */
import { verifySignature, challengeIsFresh, fromBase58 } from "./identity";
import { listener, seen, signingKey } from "./store";
import { needsWallet } from "../../spec/pricing.mjs";

/** Half an hour. Short enough that a block takes effect soon, long enough that
 *  an album does not stop halfway through to ask again. */
const TOKEN_LIFE = 30 * 60_000;

const enc = new TextEncoder();

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message))));
}

/**
 * A token is the wallet and an expiry, signed by this node.
 *
 * Deliberately not a database lookup: audio arrives in many ranged requests and
 * every one of them would otherwise be a query. Checking a signature is
 * arithmetic, so playback never waits on storage.
 */
export async function issueToken(db: D1Database, pubkey: string, now = Date.now()): Promise<string> {
  const body = `${pubkey}.${now + TOKEN_LIFE}`;
  return `${body}.${await hmac(await signingKey(db), body)}`;
}

export async function readToken(db: D1Database, token: string, now = Date.now()): Promise<string | null> {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [pubkey, until, mac] = parts;

  const expected = await hmac(await signingKey(db), `${pubkey}.${until}`);
  // Length-safe comparison; these are short fixed-length strings either way.
  if (mac.length !== expected.length) return null;
  let same = 0;
  for (let i = 0; i < mac.length; i++) same |= mac.charCodeAt(i) ^ expected.charCodeAt(i);
  if (same !== 0) return null;

  if (!Number.isFinite(Number(until)) || Number(until) < now) return null;
  return pubkey;
}

export interface Introduction {
  ok: boolean;
  token?: string;
  why?: string;
}

/**
 * Does this request prove it comes from the holder of this wallet?
 *
 * Nothing else: no token, no record that they were here, and no refusal for a
 * wallet the artist has stopped serving. That is what a listener exercising
 * their rights needs — being barred from the music is not being barred from
 * seeing or erasing what the artist holds about you.
 */
export async function proveOwnership(
  host: string,
  body: { address?: string; message?: string; signature?: string },
  now = Date.now(),
): Promise<{ ok: true; address: string } | { ok: false; why: string }> {
  const address = String(body?.address || "");
  const message = String(body?.message || "");
  const signature = String(body?.signature || "");

  const key = fromBase58(address);
  if (!key || key.length !== 32) return { ok: false, why: "that is not a wallet address" };
  if (!challengeIsFresh(message, host, now)) return { ok: false, why: "that challenge is not one of ours, or it has expired" };
  if (!(await verifySignature(address, message, signature))) return { ok: false, why: "that signature does not match that wallet" };
  return { ok: true, address };
}

/**
 * Check a signed challenge and hand back a token.
 *
 * A blocked wallet is refused here rather than at every audio request, which is
 * what keeps playback free of database reads. The cost is that a block takes up
 * to a token's lifetime to bite, which is half an hour and fine: nobody needs
 * banning within the minute.
 */
export async function introduce(
  db: D1Database,
  host: string,
  body: { address?: string; message?: string; signature?: string },
  now = Date.now(),
): Promise<Introduction> {
  const proof = await proveOwnership(host, body, now);
  if (!proof.ok) return { ok: false, why: proof.why };
  const address = proof.address;

  const known = await listener(db, address);
  if (known?.blocked) return { ok: false, why: "this artist has stopped serving this wallet" };

  await seen(db, address, now);
  return { ok: true, token: await issueToken(db, address, now) };
}

/**
 * Which audio a listener must identify themselves for.
 *
 * Read from the manifest the artist published, so the answer is whatever they
 * last said it was. Keys rather than URLs, because that is what a request
 * carries, and an artist may move house.
 */
export function guardedKeys(manifest: unknown): Set<string> {
  const keys = new Set<string>();
  type Track = { url?: string; needsWallet?: boolean; free?: boolean };
  const releases = (manifest as { releases?: { tracks?: Track[] }[] })?.releases ?? [];
  for (const release of releases) {
    for (const track of release.tracks ?? []) {
      // The same rule the app uses, from the same file: an artist who charges
      // is paid for every track they have not deliberately made free.
      if (!track?.url || !needsWallet(manifest, track)) continue;
      try {
        const path = new URL(track.url).pathname;
        if (path.startsWith("/audio/")) keys.add(decodeURIComponent(path.slice("/audio/".length)));
      } catch {
        /* a URL that will not parse protects nothing; the validator catches it */
      }
    }
  }
  return keys;
}
