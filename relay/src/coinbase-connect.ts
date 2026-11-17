/**
 * "Connect Coinbase": an artist signs in to Coinbase and approves two narrow
 * permissions, the relay creates a USDC deposit address on Solana in their
 * account, revokes the access, and hands the address back to their editor.
 *
 * Nothing is stored. The state that travels through Coinbase is signed with
 * the OAuth client secret, and PKCE's verifier is derived from that state, so
 * the callback can check both without a database. The editor accepts the
 * address only with the one-time nonce it chose (manage/src/coinbase.js).
 */

export interface ConnectEnv {
  /** Amply's Coinbase OAuth app (CDP portal → OAuth). Worker secrets. */
  COINBASE_CLIENT_ID?: string;
  COINBASE_CLIENT_SECRET?: string;
}

const AUTH = "https://login.coinbase.com/oauth2/auth";
const TOKEN = "https://login.coinbase.com/oauth2/token";
const REVOKE = "https://login.coinbase.com/oauth2/revoke";
const API = "https://api.coinbase.com";
// Reading which accounts exist, and making a receive address. Never sending.
export const CONNECT_SCOPES = "wallet:accounts:read,wallet:addresses:create";
const CB_VERSION = "2024-01-01";
const STATE_TTL_MS = 15 * 60_000;

/** An artist's editor: `<worker>.<subdomain>.workers.dev`, nothing else. */
export const EDITOR_HOST = /^[a-z0-9-]{1,63}\.[a-z0-9-]{1,63}\.workers\.dev$/;
export const NONCE = /^[A-Za-z0-9_-]{16,64}$/;

export class ConnectError extends Error {}

export const connectReady = (env: ConnectEnv) => !!(env.COINBASE_CLIENT_ID && env.COINBASE_CLIENT_SECRET);

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

async function hmac(secret: string, text: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function makeState(secret: string, host: string, nonce: string, now = Date.now()): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify({ h: host, n: nonce, t: now })));
  return `${body}.${b64url(await hmac(secret, `state:${body}`))}`;
}

export async function readState(secret: string, state: string, now = Date.now()): Promise<{ host: string; nonce: string } | null> {
  const [body, mac, extra] = state.split(".");
  if (!body || !mac || extra !== undefined) return null;
  if (!sameText(b64url(await hmac(secret, `state:${body}`)), mac)) return null;
  try {
    const { h, n, t } = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    if (typeof h !== "string" || !EDITOR_HOST.test(h) || typeof n !== "string" || !NONCE.test(n)) return null;
    if (typeof t !== "number" || now - t < 0 || now - t > STATE_TTL_MS) return null;
    return { host: h, nonce: n };
  } catch {
    return null;
  }
}

const verifierOf = async (secret: string, state: string) => b64url(await hmac(secret, `pkce:${state}`));
const challengeOf = async (verifier: string) =>
  b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))));

/** Coinbase's sign-in page, asking for the two permissions above. */
export async function connectUrl(env: ConnectEnv, redirectUri: string, host: string, nonce: string, now = Date.now()): Promise<string> {
  const secret = env.COINBASE_CLIENT_SECRET!;
  const state = await makeState(secret, host, nonce, now);
  const q = new URLSearchParams({
    response_type: "code",
    client_id: env.COINBASE_CLIENT_ID!,
    redirect_uri: redirectUri,
    scope: CONNECT_SCOPES,
    state,
    code_challenge: await challengeOf(await verifierOf(secret, state)),
    code_challenge_method: "S256",
  });
  return `${AUTH}?${q}`;
}

/** Back to the editor that asked, with the address or why not, and its nonce. */
export function backToEditor(host: string, nonce: string, result: { address: string } | { error: string }): string {
  const f = new URLSearchParams("address" in result
    ? { coinbase: result.address, nonce }
    : { "coinbase-error": result.error, nonce });
  return `https://${host}/manage#${f}`;
}

type Fetch = typeof fetch;

/**
 * Coinbase's answer, turned into a deposit address. `{ error }` alone means
 * the state didn't check out, so there's no editor to send the person back to.
 */
export async function finishConnect(
  env: ConnectEnv, redirectUri: string, params: URLSearchParams, { fetchFn = fetch as Fetch, now = Date.now() } = {},
): Promise<{ host: string; nonce: string; result: { address: string } | { error: string } } | { error: string }> {
  const secret = env.COINBASE_CLIENT_SECRET!;
  const state = params.get("state") || "";
  const back = await readState(secret, state, now);
  if (!back) return { error: "This Coinbase link has expired or isn't Amply's. Go back to your editor and try again" };
  const fail = (error: string) => ({ ...back, result: { error } });
  if (params.get("error")) {
    return fail(params.get("error") === "access_denied"
      ? "You didn't approve the connection, so nothing changed"
      : "Coinbase didn't connect. Try again in a moment");
  }
  const code = params.get("code");
  if (!code) return fail("Coinbase didn't connect. Try again in a moment");

  const res = await fetchFn(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code, client_id: env.COINBASE_CLIENT_ID!, client_secret: secret,
      redirect_uri: redirectUri, code_verifier: await verifierOf(secret, state),
    }),
  });
  const token = ((await res.json().catch(() => null)) as { access_token?: string } | null)?.access_token;
  if (!res.ok || !token) return fail("Coinbase didn't connect. Try again in a moment");
  try {
    return { ...back, result: { address: await usdcAddress(fetchFn, token) } };
  } catch (e) {
    return fail(e instanceof ConnectError ? e.message : "Coinbase didn't make an address. Try again in a moment");
  } finally {
    // Done with it: nothing else is ever asked of their account.
    await fetchFn(REVOKE, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, client_id: env.COINBASE_CLIENT_ID!, client_secret: secret }),
    }).catch(() => {});
  }
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function isSolanaAddress(s: unknown): s is string {
  if (typeof s !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  let bytes = 0;
  while (n > 0n) { bytes++; n >>= 8n; }
  for (const c of s) { if (c === "1") bytes++; else break; }
  return bytes === 32;
}

async function usdcAddress(fetchFn: Fetch, token: string): Promise<string> {
  const headers = { Authorization: `Bearer ${token}`, "CB-VERSION": CB_VERSION };
  let next: string | null = "/v2/accounts?limit=100";
  let account: { id?: string } | null = null;
  for (let page = 0; page < 10 && next && !account; page++) {
    const res = await fetchFn(`${API}${next}`, { headers });
    if (!res.ok) throw new ConnectError("Coinbase didn't share your accounts. Try again in a moment");
    const json = (await res.json()) as { data?: any[]; pagination?: { next_uri?: string | null } };
    account = json.data?.find((a) => a?.currency?.code === "USDC" || a?.currency === "USDC") ?? null;
    const uri = json.pagination?.next_uri;
    next = typeof uri === "string" && uri.startsWith("/v2/accounts") ? uri : null;
  }
  if (!account?.id || !/^[A-Za-z0-9-]{1,64}$/.test(account.id)) {
    throw new ConnectError("Your Coinbase account has no USDC wallet yet. In Coinbase, search for USDC and open it, then try again");
  }
  const made = await fetchFn(`${API}/v2/accounts/${account.id}/addresses`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Amply", network: "solana" }),
  });
  const json = (await made.json().catch(() => null)) as { data?: { address?: string; network?: string } } | null;
  const address = json?.data?.address;
  if (!made.ok || !isSolanaAddress(address) || (json?.data?.network && json.data.network !== "solana")) {
    throw new ConnectError("Coinbase didn't make a Solana address. Try again in a moment");
  }
  return address;
}
