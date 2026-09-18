/**
 * Verifying Cloudflare Access on the node.
 *
 * Access protects a hostname or path at Cloudflare's edge, so an unauthenticated
 * request to the protected URL never reaches this Worker. That is the primary
 * guard, and it is why there is no password anywhere in Amply.
 *
 * But edge protection is bound to the URL it was configured for. If an artist
 * later attaches a custom domain, or a preview URL exists, the same Worker is
 * reachable at an address the Access policy does not cover — and the write
 * endpoints would be wide open.
 *
 * So the Worker verifies the assertion itself rather than trusting that it was
 * only reachable through the front door. Presence of the header is not enough:
 * a header is trivially forged by anyone who can reach the Worker directly.
 * The signature is what cannot be.
 */

const CERTS_TTL_MS = 60 * 60 * 1000;

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  use?: string;
  n: string;
  e: string;
}

let cache: { team: string; keys: Map<string, CryptoKey>; at: number } | null = null;

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function loadKeys(team: string): Promise<Map<string, CryptoKey>> {
  if (cache && cache.team === team && Date.now() - cache.at < CERTS_TTL_MS) {
    return cache.keys;
  }

  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error("could not fetch Access certificates");
  const { keys } = (await res.json()) as { keys: Jwk[] };

  const map = new Map<string, CryptoKey>();
  for (const jwk of keys || []) {
    if (jwk.kty !== "RSA") continue;
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    map.set(jwk.kid, key);
  }

  cache = { team, keys: map, at: Date.now() };
  return map;
}

export interface AccessConfig {
  /** e.g. "someteam.cloudflareaccess.com" */
  team: string;
  /** The Access application's AUD tag. */
  aud: string;
}

/**
 * Returns the authenticated email, or null if the request is not a valid,
 * unexpired assertion for this application.
 */
export async function verifyAccess(
  request: Request,
  config: AccessConfig,
): Promise<string | null> {
  const token =
    request.headers.get("Cf-Access-Jwt-Assertion") ||
    (request.headers.get("Cookie") || "").match(/CF_Authorization=([^;]+)/)?.[1];

  if (!token) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  let header: { kid?: string; alg?: string };
  let payload: { aud?: string | string[]; email?: string; exp?: number; iss?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  } catch {
    return null;
  }

  // Only RS256. Never trust `alg` to select the algorithm — that is the classic
  // JWT confusion attack.
  if (header.alg !== "RS256" || !header.kid) return null;

  let keys: Map<string, CryptoKey>;
  try {
    keys = await loadKeys(config.team);
  } catch {
    return null;
  }
  const key = keys.get(header.kid);
  if (!key) return null;

  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) return null;

  // A valid signature from the right team is not enough: the token must have
  // been issued for THIS application, or a token minted for any other app on
  // the same team would open this one.
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(config.aud)) return null;

  if (payload.iss && payload.iss !== `https://${config.team}`) return null;
  if (!payload.exp || payload.exp * 1000 <= Date.now()) return null;

  return payload.email || "authenticated";
}
