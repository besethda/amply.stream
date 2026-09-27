/**
 * The streaming service: the Worker an artist runs in their own Cloudflare
 * account.
 *
 *   /                 the artist's page, and /privacy, their privacy notice
 *   /manifest.json    the manifest, from D1
 *   /audio/<key>      audio from R2, with range requests; paid tracks need a pass
 *   /art/<key>        images from R2
 *   /version          so the editor can spot a stale service
 *   /listen/...       what a listener signs for with their wallet: a pass,
 *                     plays, subscriptions, purchases, and their own record
 *   /manage/...       the artist's editor and its API, behind Cloudflare Access
 *
 * Every line here is a line someone has to update inside their own cloud
 * account later, so keep it small. See docs/build.md §1B and §1D.
 */

import { verifyAccess, type AccessConfig } from "./access";
import { renderPage, renderPrivacy, pageCsp } from "./page";
import {
  setting, putSetting, listeners, listener, setBlocked, counted, forget, remove, pruneStale,
  subscribedUntil, pruneSubscriptions,
} from "./store";
import { introduce, readToken, guardedKeys, proveOwnership } from "./listen";
import { challenge } from "./identity";
import { handleEvent, connect, disconnect, publicView, portalFor, connectionOf, claim, refresh, StripeError, setSales, claimSale } from "./stripe";
import { recordSale, purchasesOf, downloadsOf, redeem, takeDownload, claimWalletSale, type Sale } from "./sales";
import { DOWNLOADS_PER_PURCHASE, subscriptionOnly } from "../../spec/pricing.mjs";
import { allow, ruleFor, tooMany, RULES, type Limiter } from "./limits";
import { ICONS, MANIFEST_PATH, studioManifest } from "./studio";

import { VERSION, SPEC_VERSION, MANAGE_CSP } from "./constants";

export interface Env {
  MEDIA: R2Bucket;
  DB: D1Database;
  /** Cloudflare's rate limiters (limits.ts). Absent on services built before them. */
  LIMIT_LISTEN?: Limiter;
  LIMIT_MEDIA?: Limiter;
  LIMIT_WALLET?: Limiter;
  LIMIT_NEW?: Limiter;
}

const MANIFEST_KEY = "manifest";
const ACCESS_KEY = "access";       // { team, aud } — written at setup
const MANAGE_PREFIX = "manage";    // the editor's own files, never public
const MAX_OBJECT = 100 * 1024 * 1024;
const MAX_MANIFEST = 2 * 1024 * 1024;

/**
 * The node decides what type an object is stored as, from its extension —
 * never the uploader's Content-Type header.
 *
 * Everything on a node shares one origin, including the editor at /manage. A
 * file stored as text/html or image/svg+xml would execute scripts on that
 * origin. Anything unrecognised becomes an inert octet-stream: audio still
 * plays, and nothing runs.
 */
const AUDIO_TYPES: Record<string, string> = {
  mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "audio/mp4", aac: "audio/aac",
  ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg",
  flac: "audio/flac", wav: "audio/wav", wave: "audio/wav", aiff: "audio/aiff", aif: "audio/aiff",
};
const IMAGE_TYPES: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  webp: "image/webp", gif: "image/gif", avif: "image/avif",
};

function storedType(prefix: string, key: string): string {
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  const table = prefix === "art" ? IMAGE_TYPES : AUDIO_TYPES;
  return table[ext] ?? "application/octet-stream";
}

/** Audio and art are immutable once published; the manifest changes. */
const CACHE_AUDIO = "public, max-age=31536000, immutable";
const CACHE_ART = "public, max-age=86400";
const CACHE_MANIFEST = "public, max-age=300, must-revalidate";

/** How long the isolate may hold the track list before asking again. */
const MANIFEST_CACHE = 5_000;   // milliseconds, in the isolate

/** Clients are web apps on other origins; everything here is public by design. */
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Range, If-None-Match, If-Range, Content-Type, Cf-Access-Jwt-Assertion",
  "Access-Control-Expose-Headers":
    "Content-Length, Content-Range, Content-Type, ETag, Accept-Ranges, Content-Disposition, X-Downloads-Left",
  "Access-Control-Max-Age": "86400",
};

function withCors(h: Headers = new Headers()): Headers {
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  // Stored types are forced (see storedType), and nosniff stops a browser
  // second-guessing them and executing something anyway.
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  return h;
}

function fail(status: number, message: string): Response {
  const h = withCors(new Headers({ "Content-Type": "application/json; charset=utf-8" }));
  return new Response(JSON.stringify({ error: message }), { status, headers: h });
}

/**
 * R2 keys come straight from a URL path, so treat them as hostile.
 * Reject traversal, absolute paths, control characters and absurd lengths.
 */
function safeKey(prefix: string, raw: string): string | null {
  let key: string;
  try {
    key = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!key || key.length > 512) return null;
  if (key.includes("..") || key.startsWith("/") || key.includes("\\")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(key)) return null;
  return `${prefix}/${key}`;
}

async function serveObject(
  env: Env,
  request: Request,
  key: string,
  cacheControl: string,
  fallbackType: string,
): Promise<Response> {
  // Whether this is a range response depends on the REQUEST, not on what R2
  // reports back. R2 populates `object.range` even when no Range header was
  // sent, so trusting it alone makes every plain GET a 206.
  const wantsRange = request.headers.has("Range");

  let object: R2ObjectBody | R2Object | null;
  try {
    object = await env.MEDIA.get(key, {
      range: request.headers,
      onlyIf: request.headers,
    });
  } catch {
    // R2 throws on a Range that cannot be satisfied. RFC 9110 wants a 416
    // carrying the real length so the client can correct itself.
    const meta = await env.MEDIA.head(key);
    if (meta === null) return fail(404, "not found");
    const h = withCors(new Headers());
    h.set("Content-Range", `bytes */${meta.size}`);
    h.set("Accept-Ranges", "bytes");
    return new Response(null, { status: 416, headers: h });
  }

  if (object === null) return fail(404, "not found");

  const headers = withCors(new Headers());
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Cache-Control", cacheControl);
  headers.set("Accept-Ranges", "bytes");
  if (!headers.has("Content-Type")) headers.set("Content-Type", fallbackType);

  // A conditional request that did not match comes back without a body.
  if (!("body" in object) || object.body === null) {
    return new Response(null, { status: 304, headers });
  }

  let status = 200;
  const range = wantsRange
    ? (object.range as { offset?: number; length?: number } | undefined)
    : undefined;

  if (range && (range.offset !== undefined || range.length !== undefined)) {
    const offset = range.offset ?? 0;
    const length = range.length ?? object.size - offset;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("Content-Length", String(length));
    status = 206;
  } else {
    headers.set("Content-Length", String(object.size));
  }

  if (request.method === "HEAD") return new Response(null, { status, headers });
  return new Response(object.body, { status, headers });
}

let cachedManifest: { at: number; body: string | null } | null = null;

/**
 * The track list.
 *
 * Cached in the isolate for a few seconds. Every page load, every client
 * refresh and every guarded audio request needs it, and D1 is a query rather
 * than an edge read, so asking it each time would make a fast thing slow. A few
 * seconds is short enough that publishing still feels immediate.
 */
async function manifestText(env: Env): Promise<string | null> {
  const now = Date.now();
  if (cachedManifest && now - cachedManifest.at < MANIFEST_CACHE) return cachedManifest.body;
  const body = await setting(env.DB, MANIFEST_KEY);
  cachedManifest = { at: now, body };
  return body;
}

async function serveManifest(env: Env): Promise<Response> {
  const body = await manifestText(env);
  if (body === null) {
    return fail(404, "no manifest published yet");
  }
  const headers = withCors(
    new Headers({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": CACHE_MANIFEST,
      "X-Amply-Spec": String(SPEC_VERSION),
    }),
  );
  return new Response(body, { status: 200, headers });
}

/**
 * Read the Access configuration written at setup.
 *
 * No config means this node was set up without Access, so there is nothing to
 * verify against — and an unverifiable write endpoint must be closed, not open.
 */
async function accessConfig(env: Env): Promise<AccessConfig | null> {
  const raw = await setting(env.DB, ACCESS_KEY);
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as AccessConfig;
    return c && c.team && c.aud ? c : null;
  } catch {
    return null;
  }
}

function noStore(extra?: HeadersInit): Headers {
  const h = withCors(new Headers(extra));
  h.set("Cache-Control", "no-store");
  return h;
}

/**
 * Everything under /manage. Cloudflare Access guards these at the edge, and the
 * Worker verifies the assertion again — see access.ts for why edge protection
 * alone is not sufficient.
 */
async function handleManage(request: Request, env: Env, path: string): Promise<Response> {
  const config = await accessConfig(env);
  if (!config) {
    // Reachable by an artist who ran setup without an email address, which
    // skips the step that locks the editor. Tell them how to finish rather
    // than stating a fact about a database they cannot see.
    return fail(
      503,
      "This streaming service has no sign-in set up, so the editor cannot be opened. "
      + "Go to https://amply.stream/repair and rebuild it with your email address — "
      + "your music and settings are untouched.",
    );
  }

  const email = await verifyAccess(request, config);
  if (!email) {
    // The sign-in lock is on the workers.dev address. On an artist's own
    // domain the editor is simply not here, which is worth saying plainly.
    if (!new URL(request.url).host.endsWith(".workers.dev")) {
      return fail(401, "Your editor isn't on this address. Open it at your .workers.dev address, the one from setup.");
    }
    return fail(401, "not signed in");
  }

  // Signed in is not the same as meant it.
  //
  // Access authenticates with a cookie, and a cookie is sent by the browser
  // whether or not the artist knew a request was being made. Without this, a
  // page an artist merely visited while signed in could post to their own
  // editor in the background — change the price, unblock a wallet — and the
  // node would see a perfectly valid session. So anything that changes
  // something must say where it came from, and it must be here.
  if (request.method !== "GET" && request.method !== "HEAD") {
    const origin = request.headers.get("Origin");
    const site = request.headers.get("Sec-Fetch-Site");
    const here = new URL(request.url).origin;
    const sameOrigin = origin ? origin === here : site === "same-origin" || site === null;
    if (!sameOrigin) return fail(403, "that request did not come from your editor");
  }

  // The editor itself, stored in R2 and served only to a signed-in artist.
  if (request.method === "GET" && (path === "" || path === "/")) {
    const obj = await env.MEDIA.get(`${MANAGE_PREFIX}/index.html`);
    if (obj === null) return fail(404, "editor not installed on this node");
    const h = noStore({ "Content-Type": "text/html; charset=utf-8" });
    h.set("Content-Security-Policy", MANAGE_CSP);
    return new Response(obj.body, { status: 200, headers: h });
  }

  if (request.method === "GET" && path === "/whoami") {
    // `home` is a domain of the artist's own, if one was attached at
    // amply.stream/domain, so the editor shares that address instead.
    const home = await setting(env.DB, "home");
    return new Response(JSON.stringify({ email, version: VERSION, home }), {
      status: 200,
      headers: noStore({ "Content-Type": "application/json; charset=utf-8" }),
    });
  }

  // Subscriptions through the artist's own Stripe account. The key comes in
  // here once and never goes back out: GET returns what is sold, not how.
  if (request.method === "GET" && path === "/stripe") {
    return new Response(JSON.stringify(await publicView(env.DB)), {
      status: 200, headers: noStore({ "Content-Type": "application/json; charset=utf-8" }),
    });
  }

  if (request.method === "POST" && path === "/stripe/connect") {
    const body = await jsonBody(request);
    // Reconnecting to change prices reuses the key already stored here,
    // rather than asking the artist to find and paste it again.
    const key = String(body?.key || "").trim() || (await connectionOf(env.DB))?.key || "";
    const plans = Array.isArray(body?.plans) ? (body!.plans as { months: number; price: number }[]) : [];
    const valid = plans.filter((p) => [3, 6, 12].includes(Number(p?.months)) && Number(p?.price) >= 2 && Number(p?.price) <= 1000);
    if (!key || !valid.length || valid.length !== plans.length) return fail(400, "a key and at least one valid plan, please");
    const origin = new URL(request.url).origin;
    const text = await manifestText(env);
    let artist = "Your music";
    try { artist = (text && JSON.parse(text)?.artist?.name) || artist; } catch { /* default */ }
    try {
      await connect(env.DB, {
        key, plans: valid.map((p) => ({ months: Number(p.months), price: Number(p.price) })), origin, artist,
        // Stripe fills in {CHECKOUT_SESSION_ID}; the listener's app hands it
        // back here to claim the subscription.
        returnTo: `https://amply.stream/app/?subscribed=${encodeURIComponent(`${origin}/manifest.json`)}&session={CHECKOUT_SESSION_ID}`,
      });
      return new Response(JSON.stringify(await publicView(env.DB)), {
        status: 200, headers: noStore({ "Content-Type": "application/json; charset=utf-8" }),
      });
    } catch (e) {
      return fail(400, e instanceof StripeError ? e.message : "Couldn't reach Stripe.");
    }
  }

  // Songs and albums for sale by card: a link each in the artist's Stripe.
  // The editor sends what it's about to publish; the links come back to go in
  // the manifest. The key is the one already here, or one pasted now.
  if (request.method === "POST" && path === "/stripe/sales") {
    const body = await jsonBody(request, 64 * 1024);
    const items = Array.isArray(body?.items) ? (body!.items as { item: string; title: string; price: number }[]) : null;
    if (!items || items.length > 500) return fail(400, "which songs and albums, at what prices?");
    const clean = items.map((i) => ({ item: String(i?.item || ""), title: String(i?.title || "").slice(0, 200), price: Number(i?.price) }));
    if (clean.some((i) => !/^[a-z0-9-]{1,64}$/.test(i.item) || !i.title || !(i.price >= 0.5 && i.price <= 1000))) {
      return fail(400, "each needs an id, a title, and a price from $0.50 to $1000");
    }
    const origin = new URL(request.url).origin;
    const text = await manifestText(env);
    let artist = "Your music";
    try { artist = (text && JSON.parse(text)?.artist?.name) || artist; } catch { /* default */ }
    try {
      const sales = await setSales(env.DB, {
        key: String(body?.key || ""), items: clean, artist,
        returnTo: `https://amply.stream/app/?bought=${encodeURIComponent(`${origin}/manifest.json`)}&session={CHECKOUT_SESSION_ID}`,
      });
      return new Response(JSON.stringify({ sales: sales.map(({ item, price, url }) => ({ item, price, url })) }), {
        status: 200, headers: noStore({ "Content-Type": "application/json; charset=utf-8" }),
      });
    } catch (e) {
      return fail(400, e instanceof StripeError ? e.message : "Couldn't reach Stripe.");
    }
  }

  if (request.method === "POST" && path === "/stripe/disconnect") {
    await disconnect(env.DB).catch(() => {});
    return new Response(null, { status: 204, headers: noStore() });
  }

  // An artist deleting a wallet's record outright: a request that came by
  // email, or data they no longer want. Takes a bar with it, since it is
  // theirs to lift.
  if (request.method === "POST" && path === "/remove") {
    const body = await jsonBody(request);
    const pubkey = String(body?.pubkey || "");
    if (!pubkey) return fail(400, "which wallet?");
    await remove(env.DB, pubkey);
    return new Response(null, { status: 204, headers: noStore() });
  }

  if (request.method === "GET" && path === "/listeners") {
    // Whenever the artist looks, anything past its keeping date goes first,
    // so what they see is what they are entitled to hold.
    await pruneStale(env.DB);
    await pruneSubscriptions(env.DB);
    const rows = await listeners(env.DB);
    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: noStore({ "Content-Type": "application/json; charset=utf-8" }),
    });
  }

  if (request.method === "POST" && path === "/block") {
    const body = await jsonBody(request);
    const pubkey = String(body?.pubkey || "");
    if (!pubkey) return fail(400, "which wallet?");
    await setBlocked(env.DB, pubkey, Boolean(body?.blocked));
    return new Response(null, { status: 204, headers: noStore() });
  }

  if (request.method === "PUT" && path === "/manifest") {
    if (Number(request.headers.get("Content-Length") || 0) > MAX_MANIFEST) {
      return fail(413, "manifest too large");
    }
    const text = await request.text();
    if (text.length > MAX_MANIFEST) return fail(413, "manifest too large");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fail(400, "manifest is not valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || (parsed as { amply?: unknown }).amply !== 1) {
      return fail(400, "not an Amply v1 manifest");
    }
    await putSetting(env.DB, MANIFEST_KEY, text);
    cachedManifest = null;
    return new Response(null, { status: 204, headers: noStore() });
  }

  // Media writes are confined to the two public prefixes, so the editor can
  // never overwrite its own files or reach anything else in the bucket.
  const media = path.match(/^\/(audio|art)\/(.+)$/);
  if (media) {
    const key = safeKey(media[1], media[2]);
    if (key === null) return fail(400, "bad key");

    if (request.method === "PUT") {
      const length = Number(request.headers.get("Content-Length") || 0);
      if (length > MAX_OBJECT) return fail(413, "file too large");
      await env.MEDIA.put(key, request.body, {
        httpMetadata: { contentType: storedType(media[1], key) },
      });
      return new Response(null, { status: 204, headers: noStore() });
    }
    if (request.method === "DELETE") {
      await env.MEDIA.delete(key);
      return new Response(null, { status: 204, headers: noStore() });
    }
  }

  return fail(404, "not found");
}

/**
 * Read a JSON body without trusting it to be JSON, or to be small.
 *
 * The declared length is a claim, not a fact: a chunked request carries no
 * Content-Length at all, so checking only the header would let an unbounded
 * body through. The text itself is measured.
 */
const MAX_BODY = 4096;

async function jsonBody(request: Request, max = MAX_BODY): Promise<Record<string, unknown> | null> {
  if (Number(request.headers.get("Content-Length") || 0) > max) return null;
  let text: string;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (text.length > max) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Who is asking, if they have said.
 *
 * A token is checked by arithmetic rather than a query, so a ranged audio
 * request costs nothing extra to identify. Returns null for anyone who has not
 * introduced themselves, which is most requests and is fine.
 */
async function whoIsAsking(request: Request, env: Env): Promise<string | null> {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : new URL(request.url).searchParams.get("t");
  if (!token) return null;
  return readToken(env.DB, token);
}

/** Everything a listener can do without being the artist. */
async function handleListen(request: Request, env: Env, path: string): Promise<Response | null> {
  const host = new URL(request.url).host;

  if (path === "/challenge" && request.method === "POST") {
    return new Response(JSON.stringify({ challenge: challenge(host) }), {
      status: 200,
      headers: noStore({ "Content-Type": "application/json; charset=utf-8" }),
    });
  }

  if (path === "/token" && request.method === "POST") {
    const body = await jsonBody(request);
    if (!body) return fail(400, "bad request");
    const result = await introduce(env.DB, host, body as never);
    if (!result.ok) return fail(403, result.why || "refused");

    // Whether they have paid for a subscription, so their app knows not to
    // charge them by the minute as well. And where a subscription is the only
    // way this artist is paid, it is required: with nothing else offered, a
    // wallet on its own would otherwise be free listening.
    const address = String((body as { address?: string }).address);
    // Checked with Stripe when due — a renewal, or once a day — else as known.
    const until = await refresh(env.DB, address).catch(() => subscribedUntil(env.DB, address));
    const subscribed = until !== null && until > Date.now();
    const text = await manifestText(env);
    let manifest: unknown = null;
    try { manifest = text ? JSON.parse(text) : null; } catch { /* treated as nothing offered */ }
    if (!subscribed && subscriptionOnly(manifest)) {
      return fail(402, "subscribe to hear this artist's paid tracks");
    }
    return new Response(JSON.stringify({ token: result.token, subscribedUntil: subscribed ? until : null }), {
      status: 200,
      headers: noStore({ "Content-Type": "application/json; charset=utf-8" }),
    });
  }

  // Back from Stripe's checkout: "this one was mine". Signed for with the
  // wallet, and believed only if Stripe says it was paid for that wallet.
  if (path === "/claim" && request.method === "POST") {
    const body = await jsonBody(request);
    if (!body) return fail(400, "bad request");
    const proof = await proveOwnership(host, body as never);
    if (!proof.ok) return fail(403, proof.why);
    try {
      const outcome = await claim(env.DB, proof.address, String((body as { session?: string }).session || ""));
      if (outcome === "refused") return fail(403, "that checkout isn't a subscription for this wallet");
      const until = await subscribedUntil(env.DB, proof.address);
      return new Response(JSON.stringify({ outcome, subscribedUntil: until }), {
        status: 200, headers: noStore({ "Content-Type": "application/json; charset=utf-8" }),
      });
    } catch (e) {
      return fail(502, e instanceof StripeError ? e.message : "Stripe didn't answer");
    }
  }

  // ── buying songs and albums to keep ──────────────────────────────────────
  // Every one of these is signed for with the listener's wallet: what they
  // own is recorded against it, and only it can download or claim.

  const saleView = (s: Sale, wallet: string) => ({
    ref: s.ref, item: s.item, via: s.via, created: s.created,
    owned: s.owner === wallet,
    // The code only to the one who bought the gift, and only until it's claimed.
    gift: s.buyer === wallet && !s.owner ? s.gift : null,
  });
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status, headers: noStore({ "Content-Type": "application/json; charset=utf-8" }),
  });
  const manifestNow = async (): Promise<unknown> => {
    const text = await manifestText(env);
    try { return text ? JSON.parse(text) : null; } catch { return null; }
  };

  // Back from Stripe's checkout for a song or an album.
  if (path === "/buy/claim" && request.method === "POST") {
    const body = await jsonBody(request);
    if (!body) return fail(400, "bad request");
    const proof = await proveOwnership(host, body as never);
    if (!proof.ok) return fail(403, proof.why);
    try {
      const c = await claimSale(env.DB, proof.address, String(body.session || ""));
      if (c.outcome === "refused") return fail(403, "that checkout isn't a purchase for this wallet");
      if (c.outcome === "pending") return json({ outcome: "pending" });
      const sale = await recordSale(env.DB, { ref: c.ref, item: c.item, buyer: proof.address, gift: body.gift === true, via: "card" });
      return json({ outcome: "recorded", ...saleView(sale, proof.address) });
    } catch (e) {
      return fail(502, e instanceof StripeError ? e.message : "Stripe didn't answer");
    }
  }

  // Paid in USDC: the transaction, and what it was for. The chain is asked.
  if (path === "/buy/wallet" && request.method === "POST") {
    const body = await jsonBody(request);
    if (!body) return fail(400, "bad request");
    const proof = await proveOwnership(host, body as never);
    if (!proof.ok) return fail(403, proof.why);
    const r = await claimWalletSale(env.DB, await manifestNow(), {
      wallet: proof.address, signature: String(body.tx || ""), item: String(body.item || ""), gift: body.gift === true, host,
    });
    if (!r.ok) return json({ outcome: r.retry ? "pending" : "refused", error: r.why }, r.retry ? 200 : 403);
    return json({ outcome: "recorded", ...saleView(r.sale, proof.address) });
  }

  // Everything this wallet has bought here, how many downloads each song has
  // left, and any gifts it bought that nobody has claimed yet.
  if (path === "/purchases" && request.method === "POST") {
    const body = await jsonBody(request);
    if (!body) return fail(400, "bad request");
    const proof = await proveOwnership(host, body as never);
    if (!proof.ok) return fail(403, proof.why);
    const { owned, gifts } = await purchasesOf(env.DB, proof.address);
    const used = await downloadsOf(env.DB, owned.map((s) => s.ref));
    return json({
      limit: DOWNLOADS_PER_PURCHASE,
      owned: owned.map((s) => ({ ...saleView(s, proof.address), downloads: used[s.ref] || {} })),
      gifts: gifts.map((s) => saleView(s, proof.address)),
    });
  }

  // Claiming a gift with its code: this wallet becomes its owner.
  if (path === "/gift" && request.method === "POST") {
    const body = await jsonBody(request);
    if (!body) return fail(400, "bad request");
    const proof = await proveOwnership(host, body as never);
    if (!proof.ok) return fail(403, proof.why);
    const item = await redeem(env.DB, proof.address, String(body.code || ""));
    if (!item) return fail(404, "that gift has already been claimed, or the link is wrong");
    return json({ item });
  }

  // The file itself, for a song this wallet owns. One download is used up
  // before it's sent; the response says how many are left.
  if (path === "/download" && request.method === "POST") {
    const body = await jsonBody(request);
    if (!body) return fail(400, "bad request");
    const proof = await proveOwnership(host, body as never);
    if (!proof.ok) return fail(403, proof.why);
    const manifest = await manifestNow() as { releases?: { tracks?: { id: string; title: string; url: string }[] }[] } | null;
    const trackId = String(body.track || "");
    const track = (manifest?.releases || []).flatMap((r) => r.tracks || []).find((t) => t.id === trackId);
    if (!track) return fail(404, "no such song");
    // Only a file this server holds: the song's own address, here.
    let key: string | null = null;
    try {
      const u = new URL(track.url);
      if (u.origin === new URL(request.url).origin && u.pathname.startsWith("/audio/")) key = safeKey("audio", u.pathname.slice("/audio/".length));
    } catch { /* not a URL */ }
    if (!key) return fail(409, "this song's file isn't kept on this server");
    const head = await env.MEDIA.head(key);
    if (!head) return fail(404, "that file is missing");
    const taken = await takeDownload(env.DB, manifest, proof.address, trackId);
    if (!taken) return fail(403, "you don't own this song here, or its downloads are used up");
    const object = await env.MEDIA.get(key);
    if (!object) return fail(404, "that file is missing");
    const ext = key.split(".").pop() || "mp3";
    const name = `${track.title}.${ext}`;
    const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    const h = noStore({
      "Content-Type": storedType("audio", key),
      "Content-Length": String(object.size),
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "X-Downloads-Left": String(taken.left),
    });
    return new Response(object.body, { status: 200, headers: h });
  }

  // A subscriber cancelling, or changing their card, on Stripe's own page.
  // Signed for with their wallet like everything else a listener asks for.
  if (path === "/subscription" && request.method === "POST") {
    const body = await jsonBody(request);
    if (!body) return fail(400, "bad request");
    const proof = await proveOwnership(host, body as never);
    if (!proof.ok) return fail(403, proof.why);
    const returnTo = String((body as { returnTo?: string }).returnTo || "https://amply.stream/app/");
    if (!/^https:\/\/amply\.stream\//.test(returnTo)) return fail(400, "bad return address");
    try {
      const url = await portalFor(env.DB, proof.address, returnTo);
      if (!url) return fail(404, "no subscription to manage here");
      return new Response(JSON.stringify({ url }), {
        status: 200, headers: noStore({ "Content-Type": "application/json; charset=utf-8" }),
      });
    } catch (e) {
      return fail(502, e instanceof StripeError ? e.message : "Stripe didn't answer");
    }
  }

  // Counted once per track when it has finished, not once per ranged request:
  // audio arrives in pieces and counting those would count a paused song a
  // hundred times, and spend the write budget doing it.
  if (path === "/played" && request.method === "POST") {
    const who = await whoIsAsking(request, env);
    if (!who) return fail(401, "not introduced");
    // One wallet can't report plays faster than songs end; and brand-new
    // wallets can only be added so fast, however many are made up. Over
    // either, the play just isn't counted: the listener hears nothing wrong.
    if (!(await allow(env as never, RULES.wallet, `${host}|${who}`))) return new Response(null, { status: 204, headers: noStore() });
    if (!(await listener(env.DB, who)) && !(await allow(env as never, RULES.newListener, host))) {
      return new Response(null, { status: 204, headers: noStore() });
    }
    const body = await jsonBody(request);
    await counted(env.DB, who, Number(body?.seconds) || 0);
    // Now and then, clear out wallets not heard from in a year. Here rather
    // than on a timer, so there is nothing for an artist to set up.
    if (Math.random() < 0.02) await pruneStale(env.DB);
    return new Response(null, { status: 204, headers: noStore() });
  }

  // A listener holds their key, so they can prove a row is theirs and have it
  // deleted. No documents, no mailbox, no judgement call by a musician. A
  // blocked wallet may still erase itself: being refused the music is not a
  // reason to be refused a right. (What survives for a blocked wallet is the
  // bar alone — see forget() in store.ts.)
  if (path === "/forget" && request.method === "POST") {
    const body = await jsonBody(request);
    if (!body) return fail(400, "bad request");
    const proof = await proveOwnership(host, body as never);
    if (!proof.ok) return fail(403, proof.why);
    await forget(env.DB, proof.address);
    return new Response(null, { status: 204, headers: noStore() });
  }

  // And see it first. The right of access, answered the same way: sign for
  // your wallet, get back everything this artist's server holds about it,
  // which is one row of totals and nothing else.
  if (path === "/mine" && request.method === "POST") {
    const body = await jsonBody(request);
    if (!body) return fail(400, "bad request");
    const proof = await proveOwnership(host, body as never);
    if (!proof.ok) return fail(403, proof.why);
    const row = await listener(env.DB, proof.address);
    return new Response(JSON.stringify({
      controller: host,
      wallet: proof.address,
      held: row
        ? {
            plays: row.plays,
            seconds: row.seconds,
            firstSeen: row.first_seen ? new Date(row.first_seen).toISOString() : null,
            lastSeen: row.last_seen ? new Date(row.last_seen).toISOString() : null,
            servingStopped: !!row.blocked,
          }
        : null,
      subscribedUntil: await subscribedUntil(env.DB, proof.address).then((u) => (u ? new Date(u).toISOString() : null)),
      purchases: await purchasesOf(env.DB, proof.address).then(({ owned, gifts }) =>
        [...owned, ...gifts].map((s) => ({ item: s.item, paidWith: s.via, when: new Date(s.created).toISOString(), gift: !s.owner }))).catch(() => []),
      notHeld: "Which tracks you played, and when. This server never records that.",
      keptFor: "A year after you were last here, then deleted automatically.",
      exported: new Date().toISOString(),
    }, null, 2), {
      status: 200,
      headers: noStore({ "Content-Type": "application/json; charset=utf-8" }),
    });
  }

  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: withCors() });
    }
    const { pathname, host } = new URL(request.url);

    // Counted per address it comes from (limits.ts), before anything is done.
    const rule = ruleFor(request.method, pathname);
    if (rule) {
      const from = request.headers.get("CF-Connecting-IP") || "unknown";
      if (!(await allow(env as never, rule, `${host}|${from}`))) return tooMany(withCors(new Headers()));
    }

    // The editor, guarded by Access.
    if (pathname === "/manage" || pathname.startsWith("/manage/")) {
      return handleManage(request, env, pathname.slice("/manage".length));
    }

    // Stripe telling this server who has subscribed. Public by necessity —
    // Stripe posts it — and believed only with Stripe's signature on it.
    if (pathname === "/stripe/webhook" && request.method === "POST") {
      if (Number(request.headers.get("Content-Length") || 0) > 256 * 1024) return fail(413, "too large");
      const raw = await request.text();
      const outcome = await handleEvent(env.DB, raw, request.headers.get("Stripe-Signature"));
      if (outcome === "refused") return fail(400, "not a valid notice from Stripe");
      return new Response(JSON.stringify({ received: true, outcome }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }

    if (pathname === "/listen" || pathname.startsWith("/listen/")) {
      const answered = await handleListen(request, env, pathname.slice("/listen".length));
      if (answered) return answered;
      return fail(404, "not found");
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      const h = withCors(new Headers({ Allow: "GET, HEAD, OPTIONS" }));
      return new Response(null, { status: 405, headers: h });
    }

    // The artist's public page. Their address is the only way anyone finds
    // them, so it has to be a page — not a 404, and not raw JSON.
    if (pathname === "/") {
      const body = await manifestText(env);
      if (body === null) return fail(404, "no manifest published yet");
      let manifest: unknown;
      try {
        manifest = JSON.parse(body);
      } catch {
        return fail(500, "manifest is not valid JSON");
      }
      const nonce = crypto.randomUUID().replace(/-/g, "");
      const headers = withCors(new Headers({
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": pageCsp(nonce),
      }));
      if (request.method === "HEAD") return new Response(null, { status: 200, headers });
      // Linked to one song or album (/?song=<id>, /?album=<id>): the page's
      // card and button are for that one.
      const q = new URL(request.url).searchParams;
      const kind = q.has("song") ? "song" : q.has("album") ? "album" : null;
      const id = kind ? String(q.get(kind) || "") : "";
      const focus = kind && /^[a-z0-9-]{1,64}$/.test(id) ? { kind, id } as const : null;
      return new Response(renderPage(manifest as never, new URL(request.url).origin, nonce, focus), {
        status: 200, headers,
      });
    }

    if (pathname === "/manifest.json") return serveManifest(env);

    // The artist's privacy notice, written by the software from what it
    // actually keeps. See renderPrivacy in page.ts.
    if (pathname === "/privacy") {
      const body = await manifestText(env);
      let manifest: unknown = {};
      try { if (body) manifest = JSON.parse(body); } catch { /* an empty notice beats an error */ }
      const nonce = crypto.randomUUID().replace(/-/g, "");
      const headers = withCors(new Headers({
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": pageCsp(nonce),
      }));
      if (request.method === "HEAD") return new Response(null, { status: 200, headers });
      return new Response(renderPrivacy(manifest as never, new URL(request.url).origin, nonce), {
        status: 200, headers,
      });
    }

    // The editor, installable on the artist's Home Screen (studio.ts).
    if (pathname === MANIFEST_PATH) {
      return new Response(studioManifest(), {
        status: 200, headers: withCors(new Headers({ "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=86400" })),
      });
    }
    if (ICONS[pathname]) {
      return new Response(ICONS[pathname], {
        status: 200, headers: withCors(new Headers({ "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" })),
      });
    }

    if (pathname === "/version") {
      const headers = withCors(
        new Headers({
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        }),
      );
      return new Response(
        JSON.stringify({ version: VERSION, spec: SPEC_VERSION }),
        { status: 200, headers },
      );
    }

    if (pathname.startsWith("/audio/")) {
      const key = safeKey("audio", pathname.slice("/audio/".length));
      if (key === null) return fail(400, "bad key");

      // Paid tracks are served only to a listener who has said who they are.
      // Everything else is served to anyone, and that default is what keeps a
      // shared link working.
      const manifest = await manifestText(env);
      let guarded = new Set<string>();
      try {
        if (manifest) guarded = guardedKeys(JSON.parse(manifest));
      } catch {
        // An unreadable manifest must not be a way past the guard. Nothing is
        // known to be open, so nothing is served without a wallet.
        return fail(503, "this music is temporarily unavailable");
      }
      if (guarded.has(key.slice("audio/".length))) {
        const who = await whoIsAsking(request, env);
        if (!who) {
          return fail(401, "this track is for listeners who have said who they are");
        }
      }

      return serveObject(env, request, key, CACHE_AUDIO, "audio/mpeg");
    }

    if (pathname.startsWith("/art/")) {
      const key = safeKey("art", pathname.slice("/art/".length));
      if (key === null) return fail(400, "bad key");
      return serveObject(env, request, key, CACHE_ART, "image/jpeg");
    }

    return fail(404, "not found");
  },
} satisfies ExportedHandler<Env>;
