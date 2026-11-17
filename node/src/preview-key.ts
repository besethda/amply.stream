/**
 * The editor, before the artist has a Cloudflare account.
 *
 * A page made before signup lives in a temporary account, and temporary
 * accounts can't have Cloudflare Access, which is what normally locks the
 * editor. Without something else, the artist could see their page and not
 * touch it until they had signed up, claimed it and come back.
 *
 * So setup makes a random key in the artist's browser and stores only its
 * hash here, with the moment the temporary account would expire. Setup links
 * to /manage/open#<key>: the key is in the fragment, so it is never sent in a
 * request or written to a log, and the page there swaps it for a cookie with
 * a same-origin request. The key opens the editor only until the account
 * would expire, and never once Access is set up: from then on Access is the
 * only way in, as on every other node.
 */

export const PREVIEW_KEY = "preview-key";   // { hash, until, claim?, claimUntil? } in settings, written at setup
const COOKIE = "amply_preview";
const CLAIM = /^https:\/\/dash\.cloudflare\.com\/[^\s"<>]+$/;

/**
 * The claim link rides along, so the editor can offer "keep it" from any tab,
 * not only the setup tab that made it. It is shown only to a request that
 * already holds the key, which can edit the page anyway, and it goes with the
 * key when setup finishes.
 */
export interface PreviewKey { hash: string; until: number; claim?: string; claimUntil?: number }

export function readPreviewKey(raw: string | null): PreviewKey | null {
  if (!raw) return null;
  try {
    const k = JSON.parse(raw) as PreviewKey;
    if (!k || !/^[0-9a-f]{64}$/.test(k.hash) || !Number.isFinite(k.until)) return null;
    const claimOk = typeof k.claim === "string" && CLAIM.test(k.claim) && Number.isFinite(k.claimUntil);
    return claimOk ? k : { hash: k.hash, until: k.until };
  } catch {
    return null;
  }
}

/** What the editor tells an artist who opened it with the key. */
export function previewNotice(k: PreviewKey, now = Date.now()) {
  return {
    until: new Date(k.until).toISOString(),
    claim: k.claim && k.claimUntil! > now ? k.claim : null,
  };
}

export async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A key as setup makes them: 32 random bytes, Base64url. Anything else isn't hashed at all. */
const shaped = (key: unknown): key is string => typeof key === "string" && /^[A-Za-z0-9_-]{43}$/.test(key);

async function matches(key: unknown, stored: PreviewKey | null, now: number): Promise<boolean> {
  if (!stored || now >= stored.until || !shaped(key)) return false;
  return (await hashKey(key)) === stored.hash;
}

function cookieOf(request: Request): string | null {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=");
  }
  return null;
}

/** Whether this request carries a key that still opens the editor. */
export function previewSession(request: Request, stored: PreviewKey | null, now = Date.now()): Promise<boolean> {
  return matches(cookieOf(request), stored, now);
}

/**
 * GET /manage/open: reads the key from the fragment, trades it for the
 * cookie, and goes to the editor. It holds nothing itself, so it needs no
 * sign-in to be served.
 */
export const OPEN_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Opening your editor</title><p id="m" style="font:16px system-ui;margin:40px 16px">Opening your editor…</p>
<script>
const key = location.hash.slice(1);
history.replaceState(null, "", location.pathname);
fetch("/manage/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) })
  .then((r) => r.ok ? location.replace("/manage") : r.text().then((t) => { document.getElementById("m").textContent = t; }))
  .catch(() => { document.getElementById("m").textContent = "Couldn't reach your page. Check your connection and try again."; });
</script>`;

/**
 * POST /manage/open, from that page: the key, for a cookie. Same-origin, so
 * the cookie can be Strict, and only the editor's own pages ever carry it.
 */
export async function openPreview(request: Request, stored: PreviewKey | null, now = Date.now()): Promise<Response> {
  let key: unknown = null;
  try {
    key = ((await request.json()) as { key?: unknown })?.key;
  } catch {
    key = null;
  }
  if (!(await matches(key, stored, now))) {
    return new Response(
      "This link no longer opens your editor. If you've claimed your page, finish at amply.stream/start to open it.",
      { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } },
    );
  }
  const seconds = Math.max(0, Math.floor((stored!.until - now) / 1000));
  return new Response(null, {
    status: 204,
    headers: {
      "Set-Cookie": `${COOKIE}=${key}; Path=/manage; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Strict`,
      "Cache-Control": "no-store",
    },
  });
}
