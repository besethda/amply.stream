/**
 * The plain values the streaming service is built with, kept apart from the
 * Worker itself: a Worker module may export only its handlers, and Cloudflare's
 * newer runtime refuses to start one that exports anything else. The release
 * script reads VERSION and SPEC_VERSION from this file; node/test-csp.mjs
 * checks MANAGE_CSP.
 */

export const VERSION = "3.18.4";
export const SPEC_VERSION = 1;

/**
 * The editor's Content-Security-Policy.
 *
 * Exported and asserted in node/test-csp.mjs, because every directive here is
 * the difference between a feature working and failing silently in a browser
 * inside an artist's own account, where we cannot reach it. `media-src` once
 * lacked blob: and every upload failed at the first step.
 *
 * The editor is self-contained by construction. This makes that a rule rather
 * than a property: it cannot load code from anywhere, and cannot send anything
 * anywhere but back to this node, so a tampered copy cannot exfiltrate an
 * artist's work or their session.
 */
export const MANAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  // blob: is load-bearing, not slack. Before an upload starts, the editor reads
  // a track's length by pointing an <audio> element at a Blob of the chosen
  // file: the manifest requires a duration, and a player must never download
  // audio just to learn one. A blob: URL can only refer to data this page
  // already holds, so it reaches nothing 'self' does not.
  "media-src 'self' blob:",
  // The editor PUTs the manifest and every file back to this same node, and
  // asks Solana who has paid. That second one cannot happen on the node: the
  // public RPC refuses a Cloudflare Worker outright. For real money it refuses
  // browsers too, so mainnet is PublicNode, which accepts them; devnet is
  // Solana's own. Two exact hosts, read-only questions, no key involved —
  // narrow enough that the "cannot exfiltrate" property above still holds.
  //
  // amply.stream is for one GET of one public file: the version of the latest
  // software, so this editor can tell the artist theirs is old. Nobody can
  // update an artist's node but the artist, which makes noticing the only
  // mechanism there is — and no artist should have to find out that a security
  // fix exists by reading a changelog. It adds no trust: this editor was
  // downloaded from that address in the first place.
  //
  // The two DNS-over-HTTPS resolvers answer "has my domain been linked yet?"
  // — a public DNS question about a public record, asked of the same two
  // resolvers the listening app uses.
  "connect-src 'self' https://solana-rpc.publicnode.com https://api.devnet.solana.com https://amply.stream https://1.1.1.1 https://cloudflare-dns.com https://dns.google",
  // The manifest that makes the editor installable (studio.ts), from here.
  "manifest-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");
