/**
 * Generate site/_headers, including a Content-Security-Policy per page.
 *
 * Why this is generated rather than hand-written: a few pages carry an inline
 * module script, and the only way to allow exactly those while forbidding
 * injected ones is a hash of their contents. A hash typed by hand goes stale
 * the moment somebody edits the page, and a stale hash breaks setup silently.
 * So it is computed from the file, every build.
 *
 * What this origin actually holds, which is the reason any of it matters:
 *
 *   /app     every listener's wallet key, in localStorage. Script injection
 *            here is theft of their money, not defacement of a web page.
 *   /start   an artist's Cloudflare access token, in memory, mid-setup. Script
 *            injection here is their whole account.
 *
 * Both are protected by the same line: script-src without 'unsafe-inline'.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";

const SITE = new URL("../site/", import.meta.url);

const read = (name) => readFileSync(new URL(name, SITE), "utf8");

/** The sha256 of every inline <script> in a page, as CSP source expressions. */
function inlineHashes(html) {
  const out = [];
  for (const [, body] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    if (!body.trim()) continue;   // an external script has an empty body
    out.push(`'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`);
  }
  return out;
}

/** The relay, read out of the page rather than repeated here, so the policy
 *  cannot drift away from the address the page actually calls. */
function relayOrigin(html) {
  const found = /relay:\s*"(https:\/\/[^"]+)"/.exec(html);
  return found ? new URL(found[1]).origin : null;
}

const start = read("start.html");
const repair = read("repair.html");
const domain = read("domain.html");
const relay = relayOrigin(start) || relayOrigin(repair);
if (!relay) throw new Error("could not find the relay origin in start.html");

const FONTS = "https://fonts.googleapis.com";
const FONT_FILES = "https://fonts.gstatic.com";

const policy = (parts) => parts.filter(Boolean).join("; ");

/** Pages that are only words: nothing to load, nothing to call. */
const STATIC = policy([
  "default-src 'none'",
  "style-src 'self' 'unsafe-inline' " + FONTS,
  "font-src " + FONT_FILES,
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
]);

/** The homepage: words, plus its own script (the hero's waveform) and video. */
const HOME = policy([
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' " + FONTS,
  "font-src " + FONT_FILES,
  "img-src 'self' data:",
  "media-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
]);

/**
 * Setup and rebuild. These drive an artist's Cloudflare account with a live
 * token, so where they may *send* things is as important as what may run:
 * their own origin, the relay, and the artist's new server on workers.dev.
 *
 * That last one is easy to lose and breaks both pages quietly: setup's last
 * screen polls the new server to see when its certificate is ready, and
 * rebuild's health check reads it. Refused, setup tells artists not to share
 * their link yet, forever, and rebuild reports "not answering" for a rebuild
 * that worked. An artist's server is always *.workers.dev at this stage, so
 * that pattern, and not "anywhere", is what is allowed.
 */
const setup = (html) => policy([
  "default-src 'none'",
  `script-src 'self' ${inlineHashes(html).join(" ")}`,
  "style-src 'self' 'unsafe-inline' " + FONTS,
  "font-src " + FONT_FILES,
  "img-src 'self' data:",
  `connect-src 'self' ${relay} https://*.workers.dev`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
]);

/**
 * The listening app.
 *
 * It is a client for servers that do not exist yet — any artist, any address —
 * so it must be allowed to fetch and play from anywhere over https. That is
 * the design, not an oversight, and it is why the protection that matters here
 * is script-src: no inline script, no third-party script, no eval. The wallet
 * key is reachable only by code served from this origin.
 */
const APP = policy([
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' " + FONTS,
  "font-src " + FONT_FILES,
  "img-src 'self' data: https:",
  "media-src 'self' blob: https:",
  "connect-src 'self' https:",
  "manifest-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
]);

/**
 * One policy per page, and never a second one.
 *
 * Cloudflare Pages combines the headers of every rule that matches a request.
 * Two Content-Security-Policy headers are not a merge — a browser enforces both
 * and a resource must satisfy each, so a broad `default-src 'none'` on /* would
 * silently forbid the app's own script no matter what the /app rule allowed.
 * So the policies are listed per path, and any page without one of its own
 * gets STATIC.
 */
const pages = readdirSync(SITE)
  .filter((f) => f.endsWith(".html"))
  .map((f) => (f === "index.html" ? "/" : `/${f.replace(/\.html$/, "")}`))
  // The editor is not a page on this site; it is a file uploaded to artists,
  // and it carries its own policy from the node (MANAGE_CSP).
  .filter((p) => p !== "/node-manage");

const special = { "/": HOME, "/start": setup(start), "/repair": setup(repair), "/domain": setup(domain) };

const pageRules = pages
  .map((p) => `${p}\n  Content-Security-Policy: ${special[p] || STATIC}\n`)
  .join("\n");

const out = `# GENERATED by scripts/security-headers.mjs — do not edit by hand.
# Run \`npm run build\` after changing a page with an inline script: its hash
# lives in the policy below, and a stale one stops the page working.

/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  Permissions-Policy: geolocation=(), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()
  Cross-Origin-Opener-Policy: same-origin

# Cloudflare Pages caches static assets for four hours by default. For the
# modules that drive provisioning that is actively dangerous, not merely
# annoying: a browser holding a stale /js/*.js runs last deploy's logic against
# this deploy's HTML, and a stale /node-worker.js would deploy an OUTDATED
# WORKER into an artist's account — including, one day, one with a fixed bug
# still in it.
#
# \`no-cache\` means revalidate every time, not "never store". With etags in play
# a repeat visit is a cheap 304.

/js/*
  Cache-Control: no-cache

/node-worker.js
  Cache-Control: no-cache

# Uploaded into artists' buckets. A stale copy means shipping an out-of-date
# editor into an account we cannot reach afterwards — same hazard as the Worker.
/node-manage
  Cache-Control: no-cache

# Read cross-origin by every artist's editor, running on their own node, to
# find out whether their software is behind. Public by nature: it is a version
# number and a list of table definitions. Uncached, because a stale copy means
# an artist is not told about a fix.
/node-version.json
  Cache-Control: no-cache
  Access-Control-Allow-Origin: *

# One policy per page. /start and /repair hold a live Cloudflare token while
# they run; the rest are words on a screen.

${pageRules}
# Holds every listener's wallet key. The camera is allowed here and nowhere
# else: the listening app scans an artist's QR code to add them. The site-wide
# policy above says camera=(), so it is removed and set again for this path.
/app/*
  Content-Security-Policy: ${APP}
  ! Permissions-Policy
  Permissions-Policy: geolocation=(), camera=(self), microphone=(), payment=(), usb=(), interest-cohort=()
`;

writeFileSync(new URL("_headers", SITE), out);
console.log(`site/_headers  ${out.split("\n").length} lines, ${[start, repair, domain].reduce((n, h) => n + inlineHashes(h).length, 0)} inline script hashes`);
