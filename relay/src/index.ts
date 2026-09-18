/**
 * Amply CORS relay.
 *
 * Cloudflare's API sends no CORS headers, so a browser cannot call it directly.
 * This forwards requests and adds the headers the browser needs. That is all it
 * does.
 *
 * It exists because Amply's deploy site has to provision resources in an
 * artist's own Cloudflare account, and the alternative — asking artists to paste
 * an API token, or routing them through a GitHub account they do not have — is
 * worse. See docs/build.md §1A.
 *
 * WHAT THIS MUST NEVER BECOME
 *
 * There are no storage bindings on this Worker. No KV, no R2, no D1, no Durable
 * Objects. That is deliberate and load-bearing: there is nothing here to
 * exfiltrate even if this code is wrong. Adding a binding would make Amply a
 * party that holds something, which the whole architecture exists to avoid
 * (docs/legal.md §1).
 *
 * Nothing is logged. Not headers, not bodies, not tokens, not origins. An
 * artist's access token passes through this Worker in memory for the duration
 * of one request and is never written anywhere.
 *
 * And the bright line: Amply never requests `offline_access` and never accepts
 * a refresh token. Access to an artist's account lasts for one provisioning
 * flow and is then gone permanently. This relay rejects any token response
 * carrying a refresh token rather than passing it on.
 */

export interface Env {
  ALLOWED_ORIGINS: string;
}

const API = "https://api.cloudflare.com/client/v4";
const TOKEN = "https://dash.cloudflare.com/oauth2/token";
const REVOKE = "https://dash.cloudflare.com/oauth2/revoke";

/**
 * Exactly the API paths provisioning needs, and nothing else. An open proxy to
 * the Cloudflare API would be a genuinely dangerous thing to leave running.
 */
const ALLOWED: Array<{ method: string; pattern: RegExp }> = [
  // Discover which account to build in.
  { method: "GET", pattern: /^\/accounts$/ },
  // Storage for audio.
  { method: "POST", pattern: /^\/accounts\/[0-9a-f]{32}\/r2\/buckets$/ },
  { method: "GET", pattern: /^\/accounts\/[0-9a-f]{32}\/r2\/buckets$/ },
  // The manifest.
  { method: "POST", pattern: /^\/accounts\/[0-9a-f]{32}\/storage\/kv\/namespaces$/ },
  { method: "GET", pattern: /^\/accounts\/[0-9a-f]{32}\/storage\/kv\/namespaces$/ },
  { method: "PUT", pattern: /^\/accounts\/[0-9a-f]{32}\/storage\/kv\/namespaces\/[0-9a-f]{32}\/values\/[A-Za-z0-9_-]{1,64}$/ },
  // Read the manifest back, so the management UI edits what is actually live.
  { method: "GET", pattern: /^\/accounts\/[0-9a-f]{32}\/storage\/kv\/namespaces\/[0-9a-f]{32}\/values\/[A-Za-z0-9_-]{1,64}$/ },
  // Audio and artwork. Object keys may contain slashes and dots; no traversal,
  // no query smuggling.
  { method: "PUT", pattern: /^\/accounts\/[0-9a-f]{32}\/r2\/buckets\/[a-z0-9][a-z0-9-]{1,62}\/objects\/(?!.*\.\.)[A-Za-z0-9!_.*'()/-]{1,512}$/ },
  { method: "GET", pattern: /^\/accounts\/[0-9a-f]{32}\/r2\/buckets\/[a-z0-9][a-z0-9-]{1,62}\/objects\/(?!.*\.\.)[A-Za-z0-9!_.*'()/-]{1,512}$/ },
  { method: "DELETE", pattern: /^\/accounts\/[0-9a-f]{32}\/r2\/buckets\/[a-z0-9][a-z0-9-]{1,62}\/objects\/(?!.*\.\.)[A-Za-z0-9!_.*'()/-]{1,512}$/ },
  // Zero Trust, so the artist can host their own editor behind Cloudflare Access.
  // Read first, then create only if absent — these are account-wide objects and
  // must never be clobbered if the artist already uses Zero Trust for something.
  { method: "GET", pattern: /^\/accounts\/[0-9a-f]{32}\/access\/organizations$/ },
  { method: "POST", pattern: /^\/accounts\/[0-9a-f]{32}\/access\/organizations$/ },
  { method: "GET", pattern: /^\/accounts\/[0-9a-f]{32}\/access\/apps$/ },
  // Identity providers. A fresh Zero Trust organisation has none, so nobody can
  // sign in to the editor at all. POST is body-checked below and accepts only
  // one-time PIN — see the note there.
  { method: "GET", pattern: /^\/accounts\/[0-9a-f]{32}\/access\/identity_providers$/ },
  { method: "POST", pattern: /^\/accounts\/[0-9a-f]{32}\/access\/identity_providers$/ },
  { method: "POST", pattern: /^\/accounts\/[0-9a-f]{32}\/access\/apps$/ },
  { method: "POST", pattern: /^\/accounts\/[0-9a-f]{32}\/access\/apps\/[0-9a-f-]{36}\/policies$/ },
  // The node itself.
  { method: "PUT", pattern: /^\/accounts\/[0-9a-f]{32}\/workers\/scripts\/[a-z0-9-]{1,63}$/ },
  { method: "GET", pattern: /^\/accounts\/[0-9a-f]{32}\/workers\/scripts\/[a-z0-9-]{1,63}$/ },
  // Give it a public URL.
  { method: "GET", pattern: /^\/accounts\/[0-9a-f]{32}\/workers\/subdomain$/ },
  { method: "POST", pattern: /^\/accounts\/[0-9a-f]{32}\/workers\/scripts\/[a-z0-9-]{1,63}\/subdomain$/ },
];

function allowedOrigin(req: Request, env: Env): string | null {
  const origin = req.headers.get("Origin");
  if (!origin) return null;
  const list = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : null;
}

function cors(origin: string | null, extra?: HeadersInit): Headers {
  const h = new Headers(extra);
  if (origin) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Vary", "Origin");
  }
  h.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  h.set("Access-Control-Max-Age", "86400");
  return h;
}

function refuse(status: number, message: string, origin: string | null): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: cors(origin, { "Content-Type": "application/json" }),
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = allowedOrigin(request, env);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      if (!origin) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    // Browsers always send Origin on cross-origin requests. No match, no service.
    if (!origin) return refuse(403, "origin not allowed", null);

    // ── token exchange ────────────────────────────────────────────────────
    if (url.pathname === "/token" && request.method === "POST") {
      const body = await request.text();

      // Enforce the no-standing-access rule here as well as at the call site,
      // so a mistake upstream cannot quietly create a durable credential.
      const params = new URLSearchParams(body);
      if (params.get("grant_type") === "refresh_token") {
        return refuse(400, "refresh tokens are not used", origin);
      }
      if ((params.get("scope") ?? "").split(/\s+/).includes("offline_access")) {
        return refuse(400, "offline_access is not requested", origin);
      }

      const upstream = await fetch(TOKEN, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });

      const text = await upstream.text();

      // If Cloudflare ever returns a refresh token unasked, drop it rather than
      // hand the browser a durable credential.
      let payload = text;
      try {
        const json = JSON.parse(text);
        if (json && typeof json === "object" && "refresh_token" in json) {
          delete json.refresh_token;
          payload = JSON.stringify(json);
        }
      } catch {
        /* not JSON — pass through untouched */
      }

      return new Response(payload, {
        status: upstream.status,
        headers: cors(origin, { "Content-Type": "application/json" }),
      });
    }

    // ── token revocation ──────────────────────────────────────────────────
    // Called when provisioning finishes, so the token is dead before the
    // artist has closed the tab rather than merely forgotten.
    if (url.pathname === "/revoke" && request.method === "POST") {
      const upstream = await fetch(REVOKE, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: await request.text(),
      });
      return new Response(null, { status: upstream.status, headers: cors(origin) });
    }

    // ── Cloudflare API ────────────────────────────────────────────────────
    if (url.pathname.startsWith("/api/")) {
      const path = url.pathname.slice("/api".length);

      if (!ALLOWED.some((r) => r.method === request.method && r.pattern.test(path))) {
        return refuse(403, `not a permitted path: ${request.method} ${path}`, origin);
      }

      const auth = request.headers.get("Authorization");
      if (!auth) return refuse(401, "missing authorization", origin);

      /**
       * Creating an identity provider is the most dangerous thing the granted
       * scopes permit: a SAML or OIDC provider would let whoever configured it
       * authenticate as the artist across everything Access protects on that
       * account.
       *
       * Amply needs exactly one kind — one-time PIN, which mails a code to an
       * address the artist already controls and adds no new trust relationship.
       * So the relay reads the body and refuses anything else. The scope
       * permits more than this; the relay does not.
       */
      let forwardBody: BodyInit | null | undefined =
        request.method === "GET" ? undefined : request.body;

      if (request.method === "POST" && /\/access\/identity_providers$/.test(path)) {
        const raw = await request.text();
        let parsed: { type?: unknown };
        try {
          parsed = JSON.parse(raw);
        } catch {
          return refuse(400, "identity provider body must be JSON", origin);
        }
        if (parsed?.type !== "onetimepin") {
          return refuse(403, "only the one-time PIN identity provider is permitted", origin);
        }
        // One-time PIN takes no configuration. Anything in `config` would be
        // settings for a provider type we do not permit in the first place.
        const config = (parsed as { config?: unknown }).config;
        if (config && typeof config === "object" && Object.keys(config).length > 0) {
          return refuse(403, "the one-time PIN provider takes no configuration", origin);
        }
        forwardBody = raw;
      }

      const headers = new Headers({ Authorization: auth });
      const ct = request.headers.get("Content-Type");
      if (ct) headers.set("Content-Type", ct);

      const upstream = await fetch(API + path + url.search, {
        method: request.method,
        headers,
        body: forwardBody,
      });

      const out = cors(origin);
      const upstreamType = upstream.headers.get("Content-Type");
      if (upstreamType) out.set("Content-Type", upstreamType);

      return new Response(upstream.body, { status: upstream.status, headers: out });
    }

    return refuse(404, "not found", origin);
  },
} satisfies ExportedHandler<Env>;
