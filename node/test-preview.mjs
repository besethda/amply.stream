/**
 * The editor before signup: a key from setup, for a cookie, for an hour.
 * The key travels in a link's fragment and is posted by the node's own page.
 *
 *   node --experimental-strip-types node/test-preview.mjs
 */
import { hashKey, readPreviewKey, previewSession, openPreview, previewNotice, claimedYet, afterClaim, arriving } from "./src/preview-key.ts";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

const KEY = "A".repeat(42) + "w";          // 43 Base64url characters, as setup makes
const NOW = Date.parse("2026-11-17T12:00:00Z");
const stored = { hash: await hashKey(KEY), until: NOW + 30 * 60_000 };
const raw = JSON.stringify(stored);

const open = (key, s = stored, now = NOW) => openPreview(new Request("https://a.b.workers.dev/manage/open", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(key === undefined ? {} : { key }),
}), s, now);
const withCookie = (c) => new Request("https://a.b.workers.dev/manage/whoami", { headers: { Cookie: c } });

ok("a stored key is read back", readPreviewKey(raw)?.hash === stored.hash);
ok("  and nonsense isn't", readPreviewKey("{") === null && readPreviewKey(JSON.stringify({ hash: "x", until: 1 })) === null && readPreviewKey(null) === null);

{
  const res = await open(KEY);
  const cookie = res.headers.get("Set-Cookie") || "";
  ok("the right key opens the editor", res.status === 204);
  ok("  with a cookie scripts can't read", /HttpOnly/.test(cookie) && /Secure/.test(cookie) && /Path=\/;/.test(cookie));
  ok("  that lasts until the account would expire", /Max-Age=1800\b/.test(cookie), cookie);
  ok("  and is sent when the artist arrives from Cloudflare's dashboard", /SameSite=Lax/.test(cookie));
}
ok("a wrong key doesn't", (await open("B".repeat(43))).status === 403);
ok("no key doesn't", (await open(undefined)).status === 403);
ok("a key of the wrong shape isn't even tried", (await open("short")).status === 403);
ok("the right key after the hour doesn't", (await open(KEY, stored, stored.until)).status === 403);
ok("nothing stored, nothing opens", (await open(KEY, null)).status === 403);

ok("the cookie is a session", await previewSession(withCookie(`x=1; amply_preview=${KEY}`), stored, NOW));
ok("  until the hour is up", !(await previewSession(withCookie(`amply_preview=${KEY}`), stored, stored.until)));
ok("  and not with someone else's key", !(await previewSession(withCookie(`amply_preview=${"C".repeat(43)}`), stored, NOW)));
ok("  and not with none", !(await previewSession(new Request("https://a.b.workers.dev/manage"), stored, NOW)));

// ── what the editor is told ─────────────────────────────────────────────────
{
  const CLAIM = "https://dash.cloudflare.com/claim-preview/abc?claimToken=t";
  const withClaim = readPreviewKey(JSON.stringify({ ...stored, claim: CLAIM, claimUntil: NOW + 20 * 60_000 }));
  ok("the editor is told when the hour ends", previewNotice(withClaim, false, NOW).until === new Date(stored.until).toISOString());
  ok("  and given the claim link while it works", previewNotice(withClaim, false, NOW).claim === CLAIM);
  ok("  but not after", previewNotice(withClaim, false, NOW + 20 * 60_000).claim === null);
  const elsewhere = readPreviewKey(JSON.stringify({ ...stored, claim: "https://evil.test/claim", claimUntil: NOW + 1e6 }));
  ok("a claim link that isn't Cloudflare's is dropped", elsewhere?.hash === stored.hash && previewNotice(elsewhere, false, NOW).claim === null);
  const script = readPreviewKey(JSON.stringify({ ...stored, claim: "javascript:alert(1)", claimUntil: NOW + 1e6 }));
  ok("  and so is anything that isn't a link at all", previewNotice(script, false, NOW).claim === null);
}

// ── the artist arriving at the home page ────────────────────────────────────
{
  const visit = (site, cookie = `amply_preview=${KEY}`, method = "GET") => new Request("https://a.b.workers.dev/", {
    method, headers: { ...(site ? { "Sec-Fetch-Site": site } : {}), ...(cookie ? { Cookie: cookie } : {}) },
  });
  ok("the artist from Cloudflare's dashboard is arriving", arriving(visit("cross-site")));
  ok("  and from a typed address", arriving(visit("none")));
  ok("  but not clicking around their own page", !arriving(visit("same-origin")));
  ok("  nor anyone without the cookie, who sees the page", !arriving(visit("cross-site", null)));
  ok("  nor a browser that doesn't say where it came from", !arriving(visit(null)));
  ok("  nor anything but a plain visit", !arriving(visit("cross-site", undefined, "HEAD")));
}

// ── telling when the page has been kept ─────────────────────────────────────
{
  const TOKEN = "temporary.token_" + "x".repeat(30);
  const k = readPreviewKey(JSON.stringify({ ...stored, claim: "https://dash.cloudflare.com/claim-preview/a?claimToken=b", claimUntil: NOW + 1e6, token: TOKEN }));
  ok("the temporary token is read back", k?.token === TOKEN);
  ok("  but not one of the wrong shape", readPreviewKey(JSON.stringify({ ...stored, token: "a b" }))?.token === undefined);

  const real = globalThis.fetch;
  const answer = (status) => { globalThis.fetch = async (url, init) => { answer.sent = { url: String(url), auth: new Headers(init?.headers).get("Authorization") }; return new Response("{}", { status }); }; };
  answer(200);
  ok("a token that still works: not kept yet", (await claimedYet(k)) === false);
  ok("  asked of Cloudflare's API, with that token", answer.sent?.url.startsWith("https://api.cloudflare.com/client/v4/") && answer.sent?.auth === `Bearer ${TOKEN}`);
  answer(401);
  ok("a refused token: kept", (await claimedYet(k)) === true);
  answer(500);
  ok("Cloudflare having trouble: can't say", (await claimedYet(k)) === null);
  globalThis.fetch = async () => { throw new Error("offline"); };
  ok("no connection: can't say", (await claimedYet(k)) === null);
  globalThis.fetch = real;

  const after = readPreviewKey(JSON.stringify(afterClaim(k)));
  ok("once kept, the token and claim link are dropped", after.claimed === true && !after.token && !after.claim);
  ok("  the key still opens the editor until the hour is up", after.hash === k.hash && after.until === k.until);
  ok("  and it's known without asking again", (await claimedYet(after)) === true);
  ok("the editor is told it's kept, and given no claim link", previewNotice(k, true, NOW).claimed === true && previewNotice(k, true, NOW).claim === null);
  ok("  and before, that it isn't", previewNotice(k, false, NOW).claimed === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
