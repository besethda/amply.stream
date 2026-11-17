/**
 * The editor before signup: a key from setup, for a cookie, for an hour.
 * The key travels in a link's fragment and is posted by the node's own page.
 *
 *   node --experimental-strip-types node/test-preview.mjs
 */
import { hashKey, readPreviewKey, previewSession, openPreview } from "./src/preview-key.ts";

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
  ok("  with a cookie scripts can't read", /HttpOnly/.test(cookie) && /Secure/.test(cookie) && /Path=\/manage/.test(cookie));
  ok("  that lasts until the account would expire", /Max-Age=1800\b/.test(cookie), cookie);
  ok("  and only this site's own pages send it", /SameSite=Strict/.test(cookie));
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
