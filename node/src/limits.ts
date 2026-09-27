/**
 * Limits, so nobody can run an artist's service into the ground.
 *
 * Everything a listener can ask for is open to anyone, which is the point —
 * but some of it costs the artist something: a write to their database (whose
 * free allowance is a daily number), a request on their Stripe key, a question
 * to the chain. Anyone can make fresh wallets for nothing, so "one per wallet"
 * alone limits nobody. So requests are counted per address they come from,
 * with a stricter count on what costs, a per-wallet count on play reports, and
 * a cap on how fast brand-new listeners can be added at all — the one thing a
 * crowd of made-up wallets could otherwise do without end.
 *
 * Counted by Cloudflare's own rate limiter (a binding, set when the service
 * is built or updated), which costs the artist nothing: counting in their
 * database would spend the very allowance this protects. Where the binding
 * isn't there — a service built before it existed, or an account that refused
 * it — a simple count in this Worker's memory stands in: weaker, since
 * Cloudflare runs many copies, but never absent.
 */

export interface Limiter { limit(options: { key: string }): Promise<{ success: boolean }> }

export interface Rule { binding: string; limit: number; period: 10 | 60 }

/** The limits, per minute. Set in the Worker's bindings with these numbers
 *  (site/js/provision.js reads them from here, through node-version.json). */
export const RULES = {
  /** Listener requests that cost: a pass, a play, a purchase, a download. */
  listen: { binding: "LIMIT_LISTEN", limit: 40, period: 60 },
  /** Audio, pictures and pages: many small requests while a song plays. */
  media: { binding: "LIMIT_MEDIA", limit: 600, period: 60 },
  /** Play reports from any one wallet: a song can't finish every ten seconds. */
  wallet: { binding: "LIMIT_WALLET", limit: 6, period: 60 },
  /** Brand-new listeners, across the whole service. */
  newListener: { binding: "LIMIT_NEW", limit: 20, period: 60 },
} satisfies Record<string, Rule>;

// ── the stand-in: counted in this copy of the Worker ────────────────────────
const counts = new Map<string, { n: number; until: number }>();
const MAX_KEYS = 10_000;

function counted(key: string, rule: Rule, now: number): boolean {
  const k = `${rule.binding}|${key}`;
  let c = counts.get(k);
  if (!c || c.until <= now) {
    if (counts.size >= MAX_KEYS) {
      for (const [old, v] of counts) if (v.until <= now) counts.delete(old);
      if (counts.size >= MAX_KEYS) counts.clear();   // under a flood, start over rather than grow
    }
    c = { n: 0, until: now + rule.period * 1000 };
    counts.set(k, c);
  }
  c.n++;
  return c.n <= rule.limit;
}

/** Within the limit? Counts this request either way. */
export async function allow(env: Record<string, unknown>, rule: Rule, key: string, now = Date.now()): Promise<boolean> {
  const binding = env[rule.binding] as Limiter | undefined;
  if (binding && typeof binding.limit === "function") {
    try { return (await binding.limit({ key })).success; } catch { /* fall through to the stand-in */ }
  }
  return counted(key, rule, now);
}

/** Which count a request falls under, if any. The editor is the artist's own,
 *  behind their sign-in; Stripe's notices are signed. */
export function ruleFor(method: string, pathname: string): Rule | null {
  if (pathname === "/manage" || pathname.startsWith("/manage/")) return null;
  if (pathname === "/stripe/webhook") return null;
  if (method === "OPTIONS") return null;
  if (pathname === "/listen/challenge") return RULES.media;   // costs nothing but a random number
  if (pathname.startsWith("/listen/")) return RULES.listen;
  return RULES.media;
}

/** The answer when a limit is reached. */
export function tooMany(headers: Headers): Response {
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Retry-After", "60");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify({ error: "Too many requests. Try again in a minute." }), { status: 429, headers });
}
