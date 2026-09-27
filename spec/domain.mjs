/**
 * Linking an artist's own domain to their streaming service.
 *
 * The strongest answer to impersonation is an address only the real artist
 * could have set up. A domain does that — only the owner of taylorswift.com
 * can add a DNS record to it — and adding a TXT record takes a minute on
 * Squarespace, Wix, GoDaddy or anywhere else, with no nameservers to move and
 * nothing about their website to change.
 *
 * The record says where their service is:
 *
 *     _amply.taylorswift.com   TXT   "amply=https://…workers.dev/manifest.json"
 *
 * A listener's app reads it over DNS-over-HTTPS, straight from the browser:
 * no Amply server is involved, and nobody has to be believed. Then a listener
 * can add an artist by typing their domain, and see that domain beside their
 * name. This is the same shape as Bluesky's domain handles.
 *
 * No dependencies, so the app and the editor share it unchanged.
 */

export const TXT_NAME = "_amply";
const PREFIX = "amply=";

/**
 * Public resolvers that answer browsers (they send CORS headers), tried in
 * order. None is Amply.
 *
 * 1.1.1.1 first, by address: some networks block the well-known
 * DNS-over-HTTPS hostnames outright — cloudflare-dns.com and dns.google both
 * time out on the one this was written on, while 1.1.1.1 answers — and an app
 * waiting on a blocked resolver just hangs. Each gets a few seconds before the
 * next is asked.
 */
const RESOLVERS = [
  (name) => [`https://1.1.1.1/dns-query?name=${encodeURIComponent(name)}&type=TXT`,
    { headers: { accept: "application/dns-json" } }],
  (name) => [`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`,
    { headers: { accept: "application/dns-json" } }],
  (name) => [`https://dns.google/resolve?name=${encodeURIComponent(name)}&type=TXT`, {}],
];
const PATIENCE = 4000;   // milliseconds per resolver

/** The value an artist pastes into their DNS settings. */
export const recordFor = (manifestUrl) => `${PREFIX}${manifestUrl}`;

/**
 * A bare domain from whatever was typed, or null if it is something else.
 * "taylorswift.com", "https://taylorswift.com/" and "TaylorSwift.com" all
 * count; anything with a path is a link, not a domain.
 */
export function bareDomain(input) {
  let raw = String(input || "").trim().toLowerCase();
  raw = raw.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!raw || raw.includes("/")) return null;
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(raw)) return null;
  if (/\.(workers|pages)\.dev$/.test(raw)) return null;   // a service address, not a domain
  return raw;
}

/**
 * Read a TXT answer from a DNS-over-HTTPS JSON reply.
 *
 * A TXT record longer than 255 characters comes back as several quoted
 * strings, which DNS means to be read as one. Joined here.
 */
export function manifestFromAnswer(reply) {
  const answers = (reply?.Answer || []).filter((a) => a.type === 16);
  for (const a of answers) {
    const text = [...String(a.data || "").matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join("")
      || String(a.data || "");
    if (!text.startsWith(PREFIX)) continue;
    const url = text.slice(PREFIX.length).trim();
    if (url.length > 500) continue;
    try {
      const u = new URL(url);
      if (u.protocol === "https:") return u.href;
    } catch { /* not a URL; try the next record */ }
  }
  return null;
}

/** Where this domain says its artist's service is, or null. */
export async function lookup(domain, fetchImpl = fetch) {
  const host = bareDomain(domain);
  if (!host) return null;
  const name = `${TXT_NAME}.${host}`;
  for (const resolver of RESOLVERS) {
    try {
      const [url, init] = resolver(name);
      const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout
        ? AbortSignal.timeout(PATIENCE) : undefined;
      const res = await fetchImpl(url, { ...init, signal });
      if (!res.ok) continue;
      return manifestFromAnswer(await res.json());   // an answer, even "none", is final
    } catch { /* this resolver is unreachable; ask the other */ }
  }
  return null;
}

/**
 * Does this domain point at this manifest? Both ways round matter to a
 * listener: an artist claims a domain in their manifest, and the domain's
 * owner confirms it with a record. Either alone could be anyone.
 */
export async function confirms(domain, manifestUrl, fetchImpl = fetch) {
  const found = await lookup(domain, fetchImpl);
  if (!found) return false;
  const norm = (u) => { try { const x = new URL(u); return `${x.origin}${x.pathname}`.replace(/\/+$/, ""); } catch { return ""; } };
  return norm(found) === norm(manifestUrl);
}
