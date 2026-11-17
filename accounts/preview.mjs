/**
 * A temporary Cloudflare account for an artist who hasn't signed up yet.
 *
 * Two calls with no credential: a proof-of-work challenge, which the artist's
 * browser solves, and the account itself, made with their acceptance of
 * Cloudflare's terms. Back come the account, its token and the claim link,
 * passed through in memory and never written anywhere.
 *
 * This is not in the relay because Cloudflare refuses to make these accounts
 * for a Worker: the relay got `403 worker_subrequest_blocked` (code 1017),
 * while the same request from anywhere else succeeds. Cloudflare's own docs
 * say to make these calls "from your backend", so this is that backend, on a
 * host that isn't Cloudflare's, doing nothing else.
 */
const API = "https://api.cloudflare.com/client/v4";

export const TEMPORARY_TERMS = {
  termsOfService: "https://www.cloudflare.com/terms/",
  privacyPolicy: "https://www.cloudflare.com/privacypolicy/",
};

/**
 * Why a request to create a temporary account is refused, or null.
 *
 * Exactly the fields Cloudflare takes and nothing else, the terms named
 * exactly, and acceptance stated. This can't see whether the artist really
 * ticked the box (setup won't send this until they have); what it can do is
 * make sure the route only ever does the one thing it exists for.
 */
export function temporaryAccountProblem(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "body must be an object";
  const expected = ["termsOfService", "privacyPolicy", "acceptTermsOfService", "challengeToken", "solution"];
  const extra = Object.keys(body).filter((k) => !expected.includes(k));
  if (extra.length) return `unexpected field: ${extra[0]}`;
  if (body.termsOfService !== TEMPORARY_TERMS.termsOfService || body.privacyPolicy !== TEMPORARY_TERMS.privacyPolicy) {
    return "the terms must be Cloudflare's own";
  }
  if (body.acceptTermsOfService !== "yes") return "the terms must be accepted";
  if (typeof body.challengeToken !== "string" || !body.challengeToken || body.challengeToken.length > 4096) {
    return "not a challenge token";
  }
  const solution = body.solution;
  if (!solution || typeof solution !== "object" || Object.keys(solution).join() !== "checkpoints") {
    return "the solution must be checkpoints and nothing else";
  }
  // k + 1 SHA-256 checkpoints, Base64. Wrangler caps k * g at 64 million, so
  // even k alone stays far below this.
  const cp = solution.checkpoints;
  if (typeof cp !== "string" || cp.length > 1_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cp)) {
    return "the checkpoints must be Base64";
  }
  return null;
}

const origins = (env) => (env.ALLOWED_ORIGINS || "https://amply.stream").split(",").map((s) => s.trim()).filter(Boolean);

/**
 * Who is asking, as far as this host can tell. The Origin header proves
 * nothing outside a browser, so two more things stand between a script and a
 * free Cloudflare account per second:
 *
 *   - Turnstile, Cloudflare's check that a person is there, verified here with
 *     the secret (TURNSTILE_SECRET). Off until that secret is set, so setting
 *     it up is a matter of adding it, not a deploy that breaks "Try it free".
 *   - A few accounts per address per window, counted in this instance's memory.
 *     Instances come and go, so it is a speed bump rather than a wall; with
 *     Turnstile on, it only has to slow down someone who passes Turnstile.
 */
export const PER_ADDRESS = 3;
export const WINDOW_MS = 10 * 60_000;
const recent = new Map();   // address -> times accounts were made, in the window

export function addressOf(request) {
  const forwarded = request.headers.get("x-forwarded-for");
  return (forwarded ? forwarded.split(",")[0] : request.headers.get("x-real-ip") || "").trim() || "unknown";
}

export function allowedNow(address, now = Date.now()) {
  const times = (recent.get(address) || []).filter((t) => now - t < WINDOW_MS);
  if (times.length >= PER_ADDRESS) { recent.set(address, times); return false; }
  times.push(now);
  recent.set(address, times);
  if (recent.size > 10_000) recent.clear();   // never a memory problem, at worst a reset
  return true;
}

export async function human(token, address, env) {
  if (!env.TURNSTILE_SECRET) return true;
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, ...(address !== "unknown" ? { remoteip: address } : {}) }),
    });
    const out = await res.json();
    return out.success === true;
  } catch {
    return false;
  }
}

function cors(origin, extra = {}) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Turnstile",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    Vary: "Origin",
    ...extra,
  };
}

const refuse = (status, error, origin) => new Response(JSON.stringify({ error }), {
  status,
  headers: origin ? cors(origin, { "Content-Type": "application/json" }) : { "Content-Type": "application/json" },
});

/** Handle `/preview/challenge` and `/preview/account`. */
export async function handle(request, env = {}) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  const allowed = origin && origins(env).includes(origin) ? origin : null;

  if (request.method === "OPTIONS") {
    return allowed ? new Response(null, { status: 204, headers: cors(allowed) }) : new Response(null, { status: 403 });
  }
  // Browsers always send Origin on cross-origin requests. No match, no service.
  if (!allowed) return refuse(403, "origin not allowed", null);
  if (request.method !== "POST") return refuse(405, "POST only", allowed);

  let upstream;
  if (url.pathname === "/preview/challenge") {
    upstream = await fetch(`${API}/provisioning/previews/challenge`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
  } else if (url.pathname === "/preview/account") {
    const raw = await request.text();
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return refuse(400, "body must be JSON", allowed); }
    const problem = temporaryAccountProblem(parsed);
    if (problem) return refuse(403, problem, allowed);
    const address = addressOf(request);
    if (!(await human(request.headers.get("X-Turnstile"), address, env))) {
      return refuse(403, "the check that a person is here didn't pass", allowed);
    }
    if (!allowedNow(address)) return refuse(429, "too many new pages from here; try again in a few minutes", allowed);
    upstream = await fetch(`${API}/provisioning/previews`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: raw,
    });
  } else {
    return refuse(404, "not found", allowed);
  }
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: cors(allowed, { "Content-Type": "application/json" }),
  });
}
