/**
 * OAuth Authorization Code flow with PKCE, in the browser, with no client secret.
 *
 * PKCE (RFC 7636) is what makes this safe without a secret. We generate a random
 * `verifier`, send only its SHA-256 hash to Cloudflare, and present the verifier
 * itself when redeeming the code. Anyone who intercepts the redirect gets a code
 * they cannot exchange, because they do not have the verifier — and the verifier
 * never leaves this device.
 *
 * The bright line, enforced here and again in the relay: we never request
 * `offline_access` and never accept a refresh token. Access to an artist's
 * Cloudflare account lasts for one provisioning flow and is then gone for good.
 */

const AUTH_URL = "https://dash.cloudflare.com/oauth2/auth";
const SESSION_KEY = "amply.pkce";

/**
 * The exact scope ids granted to the Amply OAuth client.
 *
 * These are NOT derivable from the dashboard's checkbox labels — "Workers R2
 * Storage" is `workers-r2.write`, not `workers-r2-storage.write`, and there is
 * no `account.read` at all. Read them off Manage Account → OAuth clients rather
 * than inferring them, and keep this list identical to what the client was
 * granted: requesting anything outside it fails the whole authorization before
 * the artist gets anywhere.
 *
 * Minimal by intent. Each one appears on the consent screen an artist reads
 * while deciding whether to trust us with their account.
 */
export const SCOPES = [
  "account-settings.read",      // enumerate which account to build in
  "workers-scripts.write",      // deploy the node, with its bindings declared
                                // in the upload metadata
  "workers-kv-storage.write",   // create the namespace, write the manifest
  "workers-r2.write",           // create the audio bucket
];

/**
 * Only needed to put the editor on the artist's own node behind Cloudflare
 * Access. Everything else works without them, so setup treats the steps that
 * use them as optional and falls back to the hosted editor.
 *
 * Do not infer these ids from their dashboard labels. Four separate wrong
 * guesses in this project so far, and this trio in particular:
 *
 *   - "Access: Apps and Policies" is `zone-access.write` and is ZONE-scoped.
 *     It looks like the obvious choice, it sits in the account-level Zero
 *     Trust section, and it returns 1010 auth.forbidden against
 *     /accounts/{id}/access/apps. Do not reach for it again.
 *   - The account-scoped permissions are the granular ones, and both are
 *     SINGULAR: `access-app.write`, `access-policy.write`.
 *   - `access-acct.write` bundles Organizations, Identity Providers AND
 *     Groups. `access-org.write` plus `access-idp.write` is the same
 *     capability minus Groups, and reads as two precise permissions on the
 *     consent screen rather than one vague one.
 *
 * Read ids off Manage Account → OAuth clients, or from
 * GET https://api.cloudflare.com/client/v4/oauth/scopes.
 */
export const ACCESS_SCOPES = [
  "access-org.write",           // create the Zero Trust organisation
  "access-idp.write",           // enable email sign-in (one-time PIN only —
                                // the relay refuses every other provider type)
  "access-app.write",           // create the Access application
  "access-policy.write",        // allow one email address to sign in
];

export const ALL_SCOPES = [...SCOPES, ...ACCESS_SCOPES];

function base64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(byteLength = 48) {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/**
 * Send the artist to Cloudflare to approve the scopes.
 *
 * The verifier and state go in sessionStorage rather than localStorage: they are
 * single-use, and they should not outlive the tab.
 */
export async function beginAuthorization({
  clientId, redirectUri, scopes = SCOPES, returnTo = location.pathname,
}) {
  const verifier = randomString();
  const state = randomString(16);

  // `returnTo` lets setup and the management page share one registered redirect
  // URI. The callback page reads it and forwards there.
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ verifier, state, redirectUri, returnTo }));

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes.join(" "),
    state,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: "S256",
  });

  window.location.assign(`${AUTH_URL}?${params}`);
}

/** Where the flow should resume after the callback. */
export function returnPath(fallback = "/start") {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    const to = raw && JSON.parse(raw).returnTo;
    // Only same-origin absolute paths — never a caller-supplied URL.
    return typeof to === "string" && /^\/[A-Za-z0-9/_-]*$/.test(to) ? to : fallback;
  } catch {
    return fallback;
  }
}

/** Read `?code=…&state=…` (or `?error=…`) off the callback URL. */
export function readCallback(search = window.location.search) {
  const p = new URLSearchParams(search);
  const error = p.get("error");
  if (error) {
    return {
      ok: false,
      error,
      description: p.get("error_description") || "",
      declined: error === "access_denied",
    };
  }
  const code = p.get("code");
  const state = p.get("state");
  if (!code || !state) return null; // not a callback at all
  return { ok: true, code, state };
}

/**
 * Exchange the authorization code for an access token, via the relay.
 *
 * Returns the token only. Anything resembling a durable credential is refused
 * rather than stored — see the note at the top of this file.
 */
export async function completeAuthorization({ clientId, relay, code, state }) {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) throw new Error("Setup was interrupted. Please start again.");

  const saved = JSON.parse(raw);
  sessionStorage.removeItem(SESSION_KEY); // single use, whatever happens next

  // Guards against an attacker feeding us a code from a different session.
  if (saved.state !== state) throw new Error("Security check failed. Please start again.");

  const res = await fetch(`${relay}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: saved.verifier,
      redirect_uri: saved.redirectUri,
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(body.error_description || body.error || "Could not complete sign-in.");
  }
  if (body.refresh_token) {
    // The relay strips these. Reaching here means something is misconfigured,
    // and quietly holding a durable credential is not an acceptable outcome.
    throw new Error("Unexpected long-lived credential returned; refusing to continue.");
  }

  const granted = (body.scope || "").split(/\s+/).filter(Boolean);
  return {
    token: body.access_token,
    scopes: granted,
    // Cloudflare may return fewer scopes than were asked for — a consent screen
    // can let a user decline the optional ones. Never assume the request was
    // granted in full.
    hasAccessScopes: ACCESS_SCOPES.every((s) => granted.includes(s)),
  };
}

/** Kill the token the moment we are finished with it. */
export async function revoke({ relay, clientId, token }) {
  try {
    await fetch(`${relay}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, client_id: clientId }),
    });
  } catch {
    /* best effort — the token is short-lived regardless */
  }
}
