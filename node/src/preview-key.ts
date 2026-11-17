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
 *
 * So does the temporary account's own token, never shown to anyone: it is
 * how this node learns the account has been claimed, because claiming ends
 * it. Once it has, the token and the claim link are dropped (`claimed`).
 */
export interface PreviewKey {
  hash: string; until: number;
  claim?: string; claimUntil?: number;
  token?: string; claimed?: boolean;
}

export function readPreviewKey(raw: string | null): PreviewKey | null {
  if (!raw) return null;
  try {
    const k = JSON.parse(raw) as PreviewKey;
    if (!k || !/^[0-9a-f]{64}$/.test(k.hash) || !Number.isFinite(k.until)) return null;
    const out: PreviewKey = { hash: k.hash, until: k.until };
    if (k.claimed === true) return { ...out, claimed: true };
    if (typeof k.claim === "string" && CLAIM.test(k.claim) && Number.isFinite(k.claimUntil)) {
      out.claim = k.claim;
      out.claimUntil = k.claimUntil;
    }
    if (typeof k.token === "string" && /^[A-Za-z0-9._-]{20,512}$/.test(k.token)) out.token = k.token;
    return out;
  } catch {
    return null;
  }
}

/**
 * Whether the temporary account has been claimed: true once its token is
 * refused, false while it works, null when Cloudflare can't say.
 */
export async function claimedYet(k: PreviewKey): Promise<boolean | null> {
  if (k.claimed) return true;
  if (!k.token) return null;
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/accounts?per_page=1", {
      headers: { Authorization: `Bearer ${k.token}` },
    });
    if (res.status === 401 || res.status === 403) return true;
    return res.ok ? false : null;
  } catch {
    return null;
  }
}

/** The same key, after the claim: nothing left that only mattered before it. */
export const afterClaim = (k: PreviewKey): PreviewKey => ({ hash: k.hash, until: k.until, claimed: true });

/** What the editor tells an artist who opened it with the key. */
export function previewNotice(k: PreviewKey, claimed: boolean | null, now = Date.now()) {
  return {
    until: new Date(k.until).toISOString(),
    claimed: claimed === true,
    claim: claimed !== true && k.claim && k.claimUntil! > now ? k.claim : null,
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
 * POST /manage/open, from that page: the key, for a cookie.
 *
 * Lax and site-wide, not Strict and /manage only, because the artist mostly
 * arrives from somewhere else: Cloudflare's dashboard links to the page's
 * home after a claim, and a Strict cookie isn't sent on that visit. The home
 * page uses it to send the artist on to their editor (wantsEditor). Changing
 * anything still needs a request from the editor itself: handleManage checks
 * where every write comes from, whatever cookie it carries.
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
      "Set-Cookie": `${COOKIE}=${key}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`,
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Whether a visit to the home page is the artist arriving, before their editor
 * is protected, who should land in the editor rather than on their own page:
 * holding the key's cookie, and coming from another site or a typed address.
 * Clicking around their own page (same-origin) is left alone, as is everyone
 * without the cookie, so a link the artist has shared still shows the page.
 */
export function arriving(request: Request): boolean {
  const site = request.headers.get("Sec-Fetch-Site");
  return request.method === "GET" && (site === "cross-site" || site === "none") && cookieOf(request) !== null;
}

/**
 * /manage while Cloudflare is still switching on the sign-in that setup has
 * just added: requests reach the node unsigned for a minute or so. Wait and
 * try again, and Cloudflare's sign-in will be in front of it.
 */
export const SECURING_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta http-equiv="refresh" content="5"><title>Turning on your sign-in</title>
<p style="font:16px system-ui;margin:40px 16px;max-width:30em">Turning on your sign-in. This takes a minute,
and the page reloads by itself.</p>`;
