/**
 * The editor's CSP, asserted directive by directive.
 *
 * A CSP failure is invisible to every check that isn't a browser: the build
 * succeeds, the types check, the page loads, and then one feature quietly does
 * nothing. `media-src` shipped without blob: and every upload failed at the
 * first step, inside an artist's own account, where the only fix is asking them
 * to run setup again.
 *
 * So this pins both halves: what the editor needs in order to work, and what it
 * must never be allowed to do. Loosening a directive means changing a line here
 * and reading why it was tight.
 *
 *   node node/test-csp.mjs
 */
import { MANAGE_CSP } from "./src/constants.ts";

const directives = new Map(
  MANAGE_CSP.split(";").map((d) => {
    const [name, ...values] = d.trim().split(/\s+/);
    return [name, values];
  }),
);

const checks = [];
const needs = (name, value, why) =>
  checks.push([`${name} allows ${value}`, why, () => directives.get(name)?.includes(value)]);
const forbids = (name, value, why) =>
  checks.push([`${name} does NOT allow ${value}`, why, () => !directives.get(name)?.includes(value)]);
const present = (name, why) =>
  checks.push([`${name} is set`, why, () => directives.has(name)]);

// What the editor needs to function.
needs("default-src", "'none'", "everything is denied unless named below");
needs("script-src", "'unsafe-inline'", "the whole editor is one inline module");
needs("style-src", "'unsafe-inline'", "the stylesheet is inlined into the page");
needs("img-src", "'self'", "cover art and avatars are served from this node");
needs("img-src", "data:", "small inline glyphs");
needs("media-src", "'self'", "playing back a track already uploaded");
needs("media-src", "blob:", "reading a file's duration before uploading it");
needs("connect-src", "'self'", "PUTting the manifest and files back to this node");
needs("connect-src", "https://solana-rpc.publicnode.com", "reading who has paid on the real network; Solana's own server refuses browsers");
needs("connect-src", "https://api.devnet.solana.com", "the same, on the test network");
needs("connect-src", "https://amply.stream", "reading the latest version, so an artist learns theirs is old");
needs("connect-src", "https://1.1.1.1", "checking an artist's domain record, on networks that block resolver names");
needs("connect-src", "https://cloudflare-dns.com", "checking an artist's domain record has appeared");
needs("connect-src", "https://dns.google", "the same, through the second resolver");

// What it must never be able to do. These are the reason the editor being
// self-contained is a rule and not just a habit.
forbids("script-src", "'unsafe-eval'", "no dynamic code execution, ever");
forbids("script-src", "https:", "no code from anywhere but this page");
forbids("connect-src", "*", "an artist's work must not be able to leave this node");
forbids("connect-src", "https:", "same");
// And nothing beyond the three named above may ever creep in: an allowance
// here is the one way an artist's work could leave their node.
checks.push([
  "connect-src names only this node, Solana's RPCs, amply.stream and two DNS resolvers",
  "every other destination is a way out for an artist's work",
  () => (directives.get("connect-src") || []).every((v) => [
    "'self'", "https://solana-rpc.publicnode.com", "https://api.devnet.solana.com",
    "https://amply.stream", "https://1.1.1.1", "https://cloudflare-dns.com", "https://dns.google",
  ].includes(v)),
]);
forbids("default-src", "*", "the deny-by-default floor must stay a floor");
present("form-action", "no form may post anywhere");
present("base-uri", "no rewriting where relative URLs resolve");
present("frame-ancestors", "the editor must not be framable");

let pass = 0, fail = 0;
for (const [name, why, run] of checks) {
  let ok = false;
  try { ok = !!run(); } catch { ok = false; }
  ok ? pass++ : fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `\n        ${why}`}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(MANAGE_CSP);
process.exit(fail ? 1 : 0);
