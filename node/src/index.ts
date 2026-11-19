/**
 * The streaming service: the Worker an artist runs in their own Cloudflare
 * account.
 *
 *   /                 the artist's page, and /privacy, their privacy notice
 *   /manifest.json    the manifest, from D1
 *   /audio/<key>      audio from storage (R2, or KV: media.ts), with range
 *                     requests; paid tracks need a pass
 *   /art/<key>        images from storage
 *   /version          so the editor can spot a stale service
 *   /listen/...       what a listener signs for with their wallet: a pass,
 *                     plays, subscriptions, purchases, and their own record
 *   /manage/...       the artist's editor and its API, behind Cloudflare Access
 *                     (before the page is claimed, the one-hour key from
 *                     setup: preview-key.ts)
 *
 * Every line here is a line someone has to update inside their own cloud
 * account later, so keep it small. See node/README.md.
 */

import { verifyAccess, type AccessConfig } from "./access";
import {
  PREVIEW_KEY, OPEN_PAGE, SECURING_PAGE, readPreviewKey, previewSession, openPreview, previewNotice, claimedYet, afterClaim, arriving,
} from "./preview-key";
import { renderPage, renderPrivacy, pageCsp, pageWebManifest } from "./page";
import {
  setting, putSetting, listeners, listener, setBlocked, counted, MAX_REPORT_S, forget, remove, pruneStale, pruneHourly,
  subscribedUntil, pruneSubscriptions, heard, songTotals, playsToday,
  paidOf, recordPaid, paidSigKnown, mergePaid, MAX_PAID_WALLETS, autoBlockSetting, setAutoBlock, owedRowOf,
  addServed, aPlay, sentToday, markSent, inOneGo, servedDayFor, unreportedServed, servedCount, servedDay,
  type Listener,
} from "./store";
import { autoBlock, owedOf, unpaidOf } from "../../spec/standing.mjs";
import { metered, lengthOf, forgetTallies } from "./meter";
import { fromBase58 } from "./identity";
import { readListeningPayment } from "./payment-check";
import { introduce, readToken, guardedKeys, masterKeys, proveOwnership } from "./listen";
import { challenge } from "./identity";
import { handleEvent, connect, disconnect, publicView, portalFor, connectionOf, claim, refresh, StripeError, setSales, claimSale, refundedSale } from "./stripe";
import { recordSale, purchasesOf, downloadsOf, redeem, takeDownload, claimWalletSale, itemFor, CHAINS, type Sale } from "./sales";
import { settle, feeRoom, feeAddress, feeBalance, feeOnrampSignature, rpcAt, BALANCE_TIMEOUT_MS, dayKey, OFFER_ABOVE_LAMPORTS, LISTEN_MIN_MICROS, LISTEN_MAX_MICROS, DAILY_PAYMENTS, WITHDRAW_FEE_MICROS, NEW_ACCOUNT_FEE_MICROS } from "./settle";
import { tokenAccountOf, keyOf } from "./solana-tx";
import { purchaseMemo, tipMemo, TIP_MIN_MICROS, TIP_MAX_MICROS } from "./payment-check";
import { cleanSite } from "../../spec/site.mjs";
import { cashOutProblem, draftCashOut, CASHOUT_MIN_MICROS, CASHOUT_MAX_MICROS } from "./cashout";
import { base64 } from "./solana-tx";
import { TOKEN_PROGRAM, SYSTEM_PROGRAM, ATA_PROGRAM } from "./feepay";
import { DOWNLOADS_PER_PURCHASE, subscriptionOnly, walletOf, paused, needsWallet, SETTLE_WITHIN_DAYS } from "../../spec/pricing.mjs";
import { allow, ruleFor, tooMany, RULES, type Limiter } from "./limits";
import { ICONS, MANIFEST_PATH, studioManifest, FAVICON, FAVICON_PATH } from "./studio";

import { VERSION, SPEC_VERSION, MANAGE_CSP, RELAY_ORIGIN } from "./constants";
import { media, maxObject, MediaTooLarge, type MediaObject, type MediaObjectBody } from "./media";
import { quotaFailure, FREE_STREAMS_A_DAY, FREE_STORAGE } from "./quota";

export interface Env {
  /** Where files live: R2, or KV for a node that started without it (media.ts). */
  MEDIA?: R2Bucket;
  MEDIA_KV?: KVNamespace;
  DB: D1Database;
  /** Cloudflare's rate limiters (limits.ts). Absent on services built before them. */
  LIMIT_LISTEN?: Limiter;
  LIMIT_MEDIA?: Limiter;
  LIMIT_WALLET?: Limiter;
  LIMIT_NEW?: Limiter;
  LIMIT_HEARD?: Limiter;
}

const MANIFEST_KEY = "manifest";
const ACCESS_KEY = "access";       // { team, aud } — written at setup
const MANAGE_PREFIX = "manage";    // the editor's own files, never public

/**
 * The editor, when setup put it inside this Worker's upload: it prepends one
 * line, `globalThis.__amplyEditor = "<the editor's HTML>";`, to this code
 * (site/js/provision.js). So the editor needs no storage write of its own
 * (Amply's sign-in can't write KV, where a page started before signup keeps
 * its files), and it can't be a different version from the Worker.
 */
function bundledEditor(): string | null {
  const html = (globalThis as { __amplyEditor?: unknown }).__amplyEditor;
  return typeof html === "string" && html.length > 0 ? html : null;
}
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
/** Paid audio: the listener's own browser may keep it, but a shared cache
 *  (a CDN, an office proxy) mustn't hand it to someone without a pass.
 *  Metering (meter.ts) counts what's sent, so a replay from the browser's own
 *  cache isn't counted again there; it doesn't need to be, because the app
 *  reports every play, replays included, and the larger of the two is what's
 *  billed. Making the browser ask again would only spend the listener's data
 *  and the artist's requests to learn what the report already says. */
const CACHE_AUDIO_PAID = "private, max-age=31536000, immutable";
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

  let object: MediaObjectBody | MediaObject | null;
  try {
    object = await media(env).get(key, {
      range: request.headers,
      onlyIf: request.headers,
    });
  } catch {
    // R2 throws on a Range that cannot be satisfied. RFC 9110 wants a 416
    // carrying the real length so the client can correct itself.
    const meta = await media(env).head(key);
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

/** The artist's website (spec/site.mjs), or null. Cached briefly like the
 *  manifest: every page view reads it. */
let cachedSite: { at: number; body: string | null } | null = null;
async function siteText(env: Env): Promise<string | null> {
  const now = Date.now();
  if (cachedSite && now - cachedSite.at < MANIFEST_CACHE) return cachedSite.body;
  const body = await setting(env.DB, "site").catch(() => null);
  cachedSite = { at: now, body };
  return body;
}

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

/**
 * A manifest's text, worked out once: parsed (undefined if it isn't JSON),
 * and, when the audio route first asks, which files need a wallet and which
 * are originals kept for downloads. Kept for the text it came from, so a
 * page, a manifest and every ranged audio request share one parse.
 */
interface Derived { text: string; parsed: unknown; guarded?: Set<string>; masters?: Set<string>; tracks?: TracksOf }
let derivedStored: Derived | null = null;
let derivedPaused: { source: string; view: Derived } | null = null;

function derive(text: string): Derived {
  if (derivedStored?.text === text) return derivedStored;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  return (derivedStored = { text, parsed });
}
const guardedOf = (d: Derived) => (d.guarded ??= guardedKeys(d.parsed));
const mastersOf = (d: Derived) => (d.masters ??= masterKeys(d.parsed));

/** A song as metering needs it (meter.ts): its id, and its length in seconds
 *  as published (null if the manifest doesn't say). */
interface TrackInfo { key: string; duration: number | null }
/** Each audio file on this node by its key, with its length (from the first
 *  song that streams it), and each song's id to its file. Worked out once per
 *  manifest, like guardedOf. */
const tracksOf = (d: Derived) => (d.tracks ??= (() => {
  const out: TracksOf = { byKey: new Map(), byId: new Map() };
  type Track = { id?: unknown; url?: unknown; duration?: unknown };
  for (const release of (d.parsed as { releases?: { tracks?: Track[] }[] } | null)?.releases ?? []) {
    for (const t of release?.tracks ?? []) {
      try {
        const path = new URL(String(t?.url)).pathname;
        if (!path.startsWith("/audio/")) continue;
        const key = decodeURIComponent(path.slice("/audio/".length));
        const duration = Number(t?.duration);
        if (!out.byKey.has(key)) out.byKey.set(key, { key, duration: duration > 0 ? duration : null });
        const id = String(t?.id ?? "");
        if (id && !out.byId.has(id)) out.byId.set(id, out.byKey.get(key)!);
      } catch { /* a URL that won't parse is nothing served */ }
    }
  }
  return out;
})());
interface TracksOf { byKey: Map<string, TrackInfo>; byId: Map<string, TrackInfo> }

/**
 * The manifest as listeners get it. While the fees account can't pay fans'
 * network fees, the USDC price is marked `paused` (spec/pricing.mjs): fans
 * can't pay it, so it charges nothing, and the music it made paid plays free.
 * The artist's stored copy is never changed; only what's served. Every route
 * a listener reaches reads this, so the page, the audio and the app agree.
 */
async function listenerView(env: Env, ctx?: ExecutionContext): Promise<Derived | null> {
  const text = await manifestText(env);
  if (text === null) return null;
  const stored = derive(text);
  if (stored.parsed === undefined) return stored;
  const manifest = stored.parsed as { payment?: Record<string, unknown>[] } | null;
  const at = (manifest?.payment || []).findIndex((p) => p?.type === "solana-usdc");
  if (at < 0) return stored;
  if (await feeOffer(env, ctx).catch(() => null)) return stored;
  if (derivedPaused?.source !== text) {
    const copy = { ...manifest, payment: manifest!.payment!.map((p, i) => (i === at ? { ...p, paused: true } : p)) };
    derivedPaused = { source: text, view: { text: JSON.stringify(copy), parsed: copy } };
  }
  return derivedPaused.view;
}

async function listenerText(env: Env, ctx?: ExecutionContext): Promise<string | null> {
  return (await listenerView(env, ctx))?.text ?? null;
}

/** Whether this node is taking USDC payments right now. */
async function takingPayments(env: Env, ctx?: ExecutionContext): Promise<boolean> {
  const view = await listenerView(env, ctx);
  if (!view) return true;
  return view.parsed !== undefined && !paused(view.parsed);
}

async function serveManifest(env: Env, ctx?: ExecutionContext): Promise<Response> {
  const body = await listenerText(env, ctx);
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
 * Bytes stored, for the editor's storage bar. Adding them up means listing
 * every file, and on KV a listing counts against the same 1,000 a day as
 * writes, so the total is kept in settings and taken again at most hourly.
 */
const STORAGE_KEY = "storage-used";   // { bytes, at }
async function storageUsed(env: Env, now = Date.now()): Promise<number> {
  try {
    const kept = JSON.parse((await setting(env.DB, STORAGE_KEY)) || "null") as { bytes: number; at: number } | null;
    if (kept && now - kept.at < 3_600_000) return kept.bytes;
    const bytes = await media(env).used();
    await putSetting(env.DB, STORAGE_KEY, JSON.stringify({ bytes, at: now }));
    return bytes;
  } catch {
    return 0;
  }
}

/**
 * Read the Access configuration written at setup.
 *
 * `set` is whether there is one at all; `config` is it, if it can be used. Set
 * but unusable is closed: the editor opens for neither Access nor the key from
 * before signup, because a damaged lock is not the same as no lock.
 */
async function accessConfig(env: Env): Promise<{ set: boolean; config: AccessConfig | null }> {
  const raw = await setting(env.DB, ACCESS_KEY);
  if (raw === null) return { set: false, config: null };
  try {
    const c = JSON.parse(raw) as AccessConfig;
    return { set: true, config: c && typeof c.team === "string" && c.team && typeof c.aud === "string" && c.aud ? c : null };
  } catch {
    return { set: true, config: null };
  }
}

function noStore(extra?: HeadersInit): Headers {
  const h = withCors(new Headers(extra));
  h.set("Cache-Control", "no-store");
  return h;
}

/** For the artist's page and privacy notice: a fresh nonce, the page's CSP
 *  built on it (page.ts), and never cached. */
function pageHeaders(): { nonce: string; headers: Headers } {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const headers = withCors(new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": pageCsp(nonce),
  }));
  return { nonce, headers };
}

/** A JSON answer, never cached. `indent` for what a person reads (/listen/mine). */
function json(value: unknown, status = 200, indent?: number): Response {
  return new Response(JSON.stringify(value, null, indent), {
    status, headers: noStore({ "Content-Type": "application/json; charset=utf-8" }),
  });
}

/**
 * Everything under /manage. Cloudflare Access guards these at the edge, and the
 * Worker verifies the assertion again — see access.ts for why edge protection
 * alone is not sufficient.
 */
async function handleManage(request: Request, env: Env, path: string): Promise<Response> {
  const { set: locked, config } = await accessConfig(env);
  // Before signup, a key from setup opens the editor instead (preview-key.ts).
  // Never once Access has been set up, even if its setting is damaged: then
  // Access is the only way in.
  const preview = locked ? null : readPreviewKey(await setting(env.DB, PREVIEW_KEY));
  if (path === "/open" && request.method === "GET") {
    const h = noStore({ "Content-Type": "text/html; charset=utf-8", "Referrer-Policy": "no-referrer" });
    h.set("Content-Security-Policy", MANAGE_CSP);
    return new Response(OPEN_PAGE, { status: 200, headers: h });
  }
  if (path === "/open" && request.method === "POST") {
    // Same-origin only: the page above is the one place this is asked from.
    if (request.headers.get("Origin") !== new URL(request.url).origin) return fail(403, "that request did not come from your page");
    return openPreview(request, preview);
  }

  if (locked && !config) {
    return fail(
      503,
      "This streaming service's sign-in setting is damaged, so the editor stays closed. "
      + "Go to https://amply.stream/repair and rebuild it — your music and settings are untouched.",
    );
  }

  if (!config && !preview) {
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

  let email: string | null = "";
  if (config) {
    email = await verifyAccess(request, config);
    if (!email) {
      // The sign-in lock is on the workers.dev address. On an artist's own
      // domain the editor is simply not here, which is worth saying plainly.
      if (!new URL(request.url).host.endsWith(".workers.dev")) {
        return fail(401, "Your editor isn't on this address. Open it at your .workers.dev address, the one from setup.");
      }
      // Opening the editor and not stopped by Cloudflare's sign-in: setup has
      // only just added it, and Cloudflare is still switching it on.
      if (request.method === "GET" && (path === "" || path === "/")) {
        return new Response(SECURING_PAGE, { status: 503, headers: noStore({ "Content-Type": "text/html; charset=utf-8", "Retry-After": "5" }) });
      }
      return fail(401, "not signed in");
    }
  } else if (!(await previewSession(request, preview))) {
    return fail(401, "Your editor opens from the setup page until your page is yours. Claim it, then finish at https://amply.stream/start.");
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
    // A browser says where a write comes from with one or the other; a request
    // that says neither isn't trusted to have come from here.
    const sameOrigin = origin ? origin === here : site === "same-origin";
    if (!sameOrigin) return fail(403, "that request did not come from your editor");
  }

  // The editor itself, served only to a signed-in artist. It arrives inside
  // this Worker's own upload (bundledEditor), so it's always the same version
  // as the Worker; a service set up before that keeps its copy in storage.
  if (request.method === "GET" && (path === "" || path === "/")) {
    const h = noStore({ "Content-Type": "text/html; charset=utf-8" });
    h.set("Content-Security-Policy", MANAGE_CSP);
    const bundled = bundledEditor();
    if (bundled) return new Response(bundled, { status: 200, headers: h });
    const obj = await media(env).get(`${MANAGE_PREFIX}/index.html`);
    if (obj === null || !("body" in obj)) return fail(404, "editor not installed on this node");
    return new Response(obj.body, { status: 200, headers: h });
  }

  if (request.method === "GET" && path === "/whoami") {
    // `home` is a domain of the artist's own, if one was attached at
    // amply.stream/domain, so the editor shares that address instead.
    const home = await setting(env.DB, "home");
    // Opened with the key from before signup: how long is left, whether the
    // page has been kept yet, and if not, the link that keeps it.
    let temporary = null;
    if (!config) {
      const claimed = await claimedYet(preview!);
      if (claimed && !preview!.claimed) await putSetting(env.DB, PREVIEW_KEY, JSON.stringify(afterClaim(preview!)));
      temporary = previewNotice(preview!, claimed);
    }
    // maxFile: the most this service stores in one file (25 MB on KV), so the
    // editor can fit a song to it before uploading rather than be refused after.
    return json({ email, version: VERSION, home, temporary, maxFile: maxObject(env) });
  }

  // The website: read it, or save it. Saved through cleanSite, the one gate
  // between what the editor sends and what visitors are shown.
  // The payout wallet the artist just made, kept here at once so a reload or
  // an update before publishing doesn't lose it.
  if (path === "/payout" && request.method === "GET") {
    const t = await setting(env.DB, "payout");
    return new Response(t || "null", { status: 200, headers: noStore({ "Content-Type": "application/json; charset=utf-8" }) });
  }
  if (path === "/payout" && request.method === "POST") {
    const body = await jsonBody(request, 1_000);
    const address = typeof body?.address === "string" ? body.address : "";
    if (!keyOf(address)) return fail(400, "not a payout address");
    await putSetting(env.DB, "payout", JSON.stringify({ address }));
    return json({ address });
  }

  // Cashing out through Coinbase: where Coinbase is waiting for the USDC, read
  // through Amply's relay (which holds the Coinbase key) with the payout
  // wallet's own signature. Only for a payout wallet this node publishes.
  if (path === "/cashout/coinbase" && request.method === "GET") {
    const q = new URL(request.url).searchParams;
    const pay = walletOf(await manifestNowOf(env));
    if (!pay?.recipients.some((r) => r.address === q.get("address"))) return fail(400, "that isn't one of your payout wallets");
    const ask = new URLSearchParams({
      address: q.get("address") || "", signedAt: q.get("signedAt") || "", signature: q.get("signature") || "",
      nonce: q.get("nonce") || "", amount: q.get("amount") || "",
    });
    const res = await fetch(`${RELAY_ORIGIN}/coinbase/sell/status?${ask}`).catch(() => null);
    const body = res ? await res.text() : JSON.stringify({ error: "Coinbase couldn't be reached" });
    return new Response(body, { status: res?.status ?? 502, headers: noStore({ "Content-Type": "application/json; charset=utf-8" }) });
  }

  if (path === "/site" && request.method === "GET") {
    const t = await setting(env.DB, "site");
    return new Response(t || "null", { status: 200, headers: noStore({ "Content-Type": "application/json; charset=utf-8" }) });
  }
  if (path === "/site" && request.method === "POST") {
    if (Number(request.headers.get("Content-Length") || 0) > 300_000) return fail(413, "that website is too large");
    const body = await jsonBody(request, 300_000);
    if (!body) return fail(400, "bad request");
    const clean = body.site === null ? null : cleanSite(body.site);
    if (clean === null) await env.DB.prepare("DELETE FROM settings WHERE key = 'site'").run();
    else await putSetting(env.DB, "site", JSON.stringify(clean));
    cachedSite = null;
    return json({ site: clean });
  }

  // Totals per song, for the editor's Home tab.
  if (request.method === "GET" && path === "/stats") {
    const usage = {
      streams: { used: await playsToday(env.DB), of: FREE_STREAMS_A_DAY },
      storage: { used: await storageUsed(env), of: env.MEDIA ? FREE_STORAGE.r2 : FREE_STORAGE.kv },
    };
    return json({ songs: await songTotals(env.DB), usage });
  }

  // The wallet that pays listeners' network fees (settle.ts): its address,
  // what it holds and what it has paid today. Never its key.
  if (request.method === "GET" && path === "/fees") {
    const address = await feeAddress(env.DB);
    const text = await manifestText(env);
    let network = "solana";
    try { network = walletOf(text ? JSON.parse(text) : null)?.network || network; } catch { /* default */ }
    const chain = CHAINS[network] || CHAINS.solana;
    const lamports = await feeBalance(rpcAt(chain.rpc), address, { fresh: true }).catch(() => null);
    // Once a payout wallet is published, "on" is exactly what listeners are
    // offered (feeOffer, reading the balance just asked for). Before, there's
    // nothing to offer yet, so it's whether the fees account holds enough.
    const offering = walletOf(await manifestNowOf(env))
      ? !!(await feeOffer(env).catch(() => null))
      : lamports !== null && lamports >= OFFER_ABOVE_LAMPORTS;
    const today = await env.DB.prepare("SELECT count FROM fee_days WHERE day = ?")
      .bind(dayKey("pay", Date.now())).first<{ count: number }>().catch(() => null);
    return json({
      address, network, lamports, offering,
      offerAbove: OFFER_ABOVE_LAMPORTS, paidToday: today?.count ?? 0, dailyCap: DAILY_PAYMENTS,
    });
  }

  // A signature for buying SOL into the fees account through Coinbase: the
  // editor opens Amply's relay with it, which sends the artist to Coinbase.
  if (request.method === "POST" && path === "/fees/onramp") {
    const body = await jsonBody(request, 1_000);
    const signed = body ? await feeOnrampSignature(env.DB, Number(body.signedAt)) : null;
    if (!signed) return fail(400, "check this device's clock and try again");
    return json(signed);
  }

  // Cashing out from a Face ID payout wallet (cashout.ts): the node drafts
  // the transfer with its fee wallet paying the fee; the editor checks and
  // signs it; the node checks it again and sends it. Behind the sign-in above,
  // and only ever from a payout wallet named in the published manifest.
  if (request.method === "POST" && (path === "/send/prepare" || path === "/send")) {
    const body = await jsonBody(request);
    if (!body) return fail(400, "bad request");
    const pay = walletOf(await manifestNowOf(env));
    const chain = pay && CHAINS[pay.network];
    if (!pay || !chain) return fail(409, "publish a payout wallet first");
    const payees = pay.recipients.map((r) => r.address);
    const from = String(body.from || ""), to = String(body.to || "").trim(), micros = Number(body.micros);
    const feePayer = await feeAddress(env.DB);
    const problem = cashOutProblem(from, to, micros, { payees, feePayer });
    if (problem) return fail(400, problem);
    const rpc = rpcAt(chain.rpc);

    if (path === "/send/prepare") {
      if ((await feeBalance(rpc, feePayer, { fresh: true }).catch(() => 0)) < OFFER_ABOVE_LAMPORTS) {
        return fail(409, "your fees account needs about $5 of SOL first (see Your fees account, under Earnings)");
      }
      try {
        // A deposit address is a plain wallet. A token account pasted by
        // mistake would have the money sent somewhere nobody can use.
        const info = await rpc("getAccountInfo", [to, { encoding: "base64", commitment: "confirmed" }]);
        const owner = info?.value?.owner;
        if (owner === TOKEN_PROGRAM) return fail(400, "that's the address of a token account, not a wallet. Copy the deposit address again from Cash App or Coinbase");
        if (owner && owner !== SYSTEM_PROGRAM) return fail(400, "that address isn't a wallet. Copy the deposit address again from Cash App or Coinbase");
        const { value } = await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
        const tx = await draftCashOut({ feePayer, from, to, micros, mint: chain.mint, blockhash: value.blockhash });
        return json({ tx: base64.encode(tx), feePayer, mint: chain.mint });
      } catch (e) {
        return fail(502, "couldn't reach the network; try again in a moment");
      }
    }

    const result = await settle(env.DB, rpc, body.tx, {
      mint: chain.mint, payees: [{ address: to, split: 100 }], minMicros: micros, maxMicros: micros,
    }, { from: payees, kind: "send", openOnce: [] });
    if (!result.ok) return fail(result.status, result.why);
    return json({ signature: result.signature, confirmed: result.confirmed });
  }

  // Subscriptions through the artist's own Stripe account. The key comes in
  // here once and never goes back out: GET returns what is sold, not how.
  if (request.method === "GET" && path === "/stripe") {
    return json(await publicView(env.DB));
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
        key, plans: valid.map((p) => ({ months: Number(p.months), price: Number(p.price) })), artist,
        // Stripe fills in {CHECKOUT_SESSION_ID}; the listener's app hands it
        // back here to claim the subscription.
        returnTo: `https://amply.stream/app/?subscribed=${encodeURIComponent(`${origin}/manifest.json`)}&session={CHECKOUT_SESSION_ID}`,
      });
      return json(await publicView(env.DB));
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
      return json({ sales: sales.map(({ item, price, url }) => ({ item, price, url })) });
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
    forgetTallies(pubkey);
    await remove(env.DB, pubkey);
    return new Response(null, { status: 204, headers: noStore() });
  }

  if (request.method === "GET" && path === "/listeners") {
    // Whenever the artist looks, anything past its keeping date goes first,
    // so what they see is what they are entitled to hold.
    await pruneStale(env.DB);
    await pruneSubscriptions(env.DB);
    const rows = await listeners(env.DB);
    return json(await withStanding(env, rows));
  }

  // Auto-block: whether it's on, and turning it on or off. Turning it on
  // carries what the editor has just read from the chain about who has paid,
  // and must: this server has seen only the payments it sent or was told of,
  // and anyone who paid another way would otherwise be refused as if they
  // hadn't. So it can't be turned on without them (an empty set is fine: then
  // nobody has paid). Turning it off lifts every block it made, since nothing
  // is stored but the setting.
  if (path === "/autoblock" && request.method === "GET") {
    return json(await autoBlockSetting(env.DB));
  }
  if (path === "/autoblock" && request.method === "POST") {
    const body = await jsonBody(request, PAID_BODY);
    if (!body || typeof body.enabled !== "boolean") return fail(400, "on or off?");
    const paid = body.paid === undefined ? undefined : paidTotals(body.paid);
    if (paid === null) return fail(400, `what each wallet paid, as whole micros, for at most ${MAX_PAID_WALLETS} wallets`);
    const was = await autoBlockSetting(env.DB);
    if (body.enabled && !was.enabled && !paid) {
      return fail(409, "check who has paid first, so nobody who paid is stopped as if they hadn't");
    }
    if (paid) await mergePaid(env.DB, paid);
    return json(await setAutoBlock(env.DB, body.enabled));
  }
  // The editor, having read the chain again, sending what everyone has paid,
  // so anything this server missed is made good.
  if (path === "/paid" && request.method === "POST") {
    const body = await jsonBody(request, PAID_BODY);
    const paid = paidTotals(body?.paid);
    if (!paid) return fail(400, `what each wallet paid, as whole micros, for at most ${MAX_PAID_WALLETS} wallets`);
    return json({ merged: await mergePaid(env.DB, paid) });
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
    // `paused` is this server's to say, from the fees account, on the copy it
    // serves. One read back from that copy and published again is dropped.
    const payment = (parsed as { payment?: unknown }).payment;
    let stored = text;
    if (Array.isArray(payment) && payment.some((p) => p && typeof p === "object" && "paused" in p)) {
      (parsed as { payment: unknown[] }).payment = payment.map((p) => {
        if (!p || typeof p !== "object") return p;
        const { paused: _dropped, ...rest } = p as Record<string, unknown>;
        return rest;
      });
      stored = JSON.stringify(parsed, null, 2);
    }
    await putSetting(env.DB, MANIFEST_KEY, stored);
    cachedManifest = null;
    return new Response(null, { status: 204, headers: noStore() });
  }

  // Media writes are confined to the two public prefixes, so the editor can
  // never overwrite its own files or reach anything else in the bucket.
  const kind = path.match(/^\/(audio|art)\/(.+)$/);
  if (kind) {
    const key = safeKey(kind[1], kind[2]);
    if (key === null) return fail(400, "bad key");

    if (request.method === "PUT") {
      const length = Number(request.headers.get("Content-Length") || 0);
      const limit = maxObject(env);
      if (length > limit) return fail(413, new MediaTooLarge(limit).message);
      try {
        await media(env).put(key, request.body, {
          httpMetadata: { contentType: storedType(kind[1], key) },
        });
      } catch (e) {
        if (e instanceof MediaTooLarge) return fail(413, e.message);
        throw e;
      }
      return new Response(null, { status: 204, headers: noStore() });
    }
    if (request.method === "DELETE") {
      await media(env).delete(key);
      return new Response(null, { status: 204, headers: noStore() });
    }
    // The artist reading their own file back (evening out an older song's
    // volume): behind the sign-in, so paid songs and originals included.
    // Also what the editor plays and measures a song through: the public
    // address wants a listener's pass for a paid song, which the artist
    // hasn't got. Ranges and HEAD work as they do there (a song can be
    // seeked), and nothing is left in a shared cache.
    if ((request.method === "GET" || request.method === "HEAD") && kind[1] === "audio") {
      return serveObject(env, request, key, "private, no-store", storedType("audio", key));
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
/** What everyone paid, from the editor: a thousand wallets and amounts. */
const PAID_BODY = 128 * 1024;

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

/**
 * What a minute of listening costs this wallet right now, in dollars: the
 * artist's USDC price, or nothing while it's free to them (a subscriber, who
 * pays by card; or payments paused, when nobody can pay). Audio is priced
 * with this when it's sent (meter.ts), so a later change doesn't reprice it.
 */
async function perMinuteFor(env: Env, ctx: ExecutionContext | undefined, who: string): Promise<number> {
  if (!(await takingPayments(env, ctx))) return 0;
  const until = await subscribedUntil(env.DB, who).catch(() => null);
  if (until !== null && until > Date.now()) return 0;
  const priced = (await manifestNowOf(env)) as { payment?: { type?: string; ratePerMinute?: unknown }[] } | null;
  const wallet = (priced?.payment || []).find((p) => p?.type === "solana-usdc");
  return Math.max(0, Number(wallet?.ratePerMinute) || 0);
}

/** Work that outlives the response: ctx.waitUntil, or (a test, no ctx) just
 *  let it run. */
const laterOf = (ctx?: ExecutionContext) => (p: Promise<unknown>) => {
  const quiet = p.catch(() => {});
  if (ctx) ctx.waitUntil(quiet);
};

/** For tests: told of each metering write. */
export const meterHooks: { onFlush?: () => void } = {};

/**
 * Count a paid track's audio as it goes to the listener (meter.ts). Only a
 * body sent for a GET: a HEAD, a 304, a 416, an error, sends no audio.
 * Never makes the request fail: anything wrong, and the audio goes as it is.
 */
function meterAudio(
  request: Request, env: Env, ctx: ExecutionContext | undefined, res: Response, who: string, key: string, view: Derived,
): Response {
  try {
    if (request.method !== "GET" || (res.status !== 200 && res.status !== 206) || !res.body) return res;
    const length = Number(res.headers.get("Content-Length"));
    // The whole file's size: after the slash of a range, or the length of a whole one.
    const size = res.status === 206
      ? Number(/\/(\d+)$/.exec(res.headers.get("Content-Range") || "")?.[1])
      : length;
    if (!(size > 0)) return res;
    const body = metered(res.body, Number.isFinite(length) ? length : null, {
      pubkey: who, track: key, size, duration: tracksOf(view).byKey.get(key)?.duration ?? null,
      sentToday: () => sentToday(env.DB, who, key),
      markSent: () => markSent(env.DB, who, key),
    }, {
      db: env.DB, perMinute: (p) => perMinuteFor(env, ctx, p), later: laterOf(ctx),
      onFlush: () => meterHooks.onFlush?.(), tidy: () => pruneHourly(env.DB),
    });
    return new Response(body, { status: res.status, headers: res.headers });
  } catch {
    return res;
  }
}

/** The artist's manifest as stored, parsed (shared: see derive), or null. */
async function manifestNowOf(env: Env): Promise<unknown> {
  const text = await manifestText(env);
  return text ? derive(text).parsed ?? null : null;
}

/** What this node offers to pay network fees for, or null. Only for an
 *  artist taking USDC on a network this node knows, and only while the fee
 *  wallet holds enough to be worth offering. On a listener's request (ctx), a
 *  remembered balance is used and refreshed in the background, and with none
 *  known the network gets a few seconds, not ten: an unknown balance is a
 *  paused price, so nobody's music waits on Solana. */
async function feeOffer(env: Env, ctx?: ExecutionContext): Promise<{ feePayer: string; network: string; minMicros: number; maxMicros: number; withdraw: { to: string; fee: number; newAccountFee: number } } | null> {
  const pay = walletOf(await manifestNowOf(env));
  const chain = pay && CHAINS[pay.network];
  if (!pay || !chain) return null;
  const feePayer = await feeAddress(env.DB);
  if (pay.recipients.some((r) => r.address === feePayer)) return null;
  const later = ctx ? (p: Promise<unknown>) => ctx.waitUntil(p) : undefined;
  if ((await feeBalance(rpcAt(chain.rpc, BALANCE_TIMEOUT_MS, 1), feePayer, { later })) < OFFER_ABOVE_LAMPORTS) return null;
  return {
    feePayer, network: pay.network, minMicros: LISTEN_MIN_MICROS, maxMicros: LISTEN_MAX_MICROS,
    withdraw: { to: pay.recipients[0].address, fee: WITHDRAW_FEE_MICROS, newAccountFee: NEW_ACCOUNT_FEE_MICROS },
  };
}

// ── Auto-block ──────────────────────────────────────────────────────────────
//
// When the artist turns it on, a listener who has fallen behind on paying
// (spec/standing.mjs, the same rules the editor shows) isn't given a new pass
// until they pay. Never a flag in the database: worked out each time from what
// their listening cost and what they've paid, so paying lifts it by itself,
// and so does turning it off. A block the artist made by hand is separate,
// and paying never lifts that.

/** The artist's price by the minute and payment point (dollars), as they
 *  published them: null unless they charge by the minute in USDC. */
function pricing(manifest: unknown): { ratePerMinute: number; settleAt: number } | null {
  if (!walletOf(manifest)) return null;
  const usdc = ((manifest as { payment?: { type?: string; ratePerMinute?: unknown; settleAt?: unknown }[] } | null)?.payment || [])
    .find((p) => p?.type === "solana-usdc");
  const rate = Number(usdc?.ratePerMinute) || 0;
  if (!(rate > 0)) return null;
  return { ratePerMinute: rate, settleAt: Number(usdc?.settleAt) > 0 ? Number(usdc?.settleAt) : 1 };
}

/**
 * Auto-block's terms, if it applies right now: the artist has turned it on,
 * charges by the minute in USDC, and listeners can actually pay them — the
 * fees account can pay their network fees and today's fees aren't used up.
 * Otherwise null, and nobody is refused for owing: a listener who can't pay
 * must never be shut out for not paying.
 */
async function autoBlockTerms(env: Env, ctx?: ExecutionContext): Promise<{ ratePerMinute: number; settleAt: number } | null> {
  if (!(await autoBlockSetting(env.DB)).enabled) return null;
  const priced = pricing(await manifestNowOf(env));
  if (!priced) return null;
  if (!(await takingPayments(env, ctx).catch(() => false))) return null;
  if (!(await feeRoom(env.DB))) return null;
  return priced;
}

/** What this known wallet owes, if Auto-block says it isn't to be served
 *  until it pays; else null. A subscriber is asked about last, since that may
 *  mean asking Stripe. */
async function owingFor(
  env: Env, ctx: ExecutionContext | undefined, known: Listener, subscribedUntilOf: () => Promise<number | null>,
): Promise<number | null> {
  const terms = await autoBlockTerms(env, ctx);
  if (!terms) return null;
  const now = Date.now();
  const paid = await paidOf(env.DB, known.pubkey);
  if (paid === null) return null;   // no record of payments at all: nobody can say who's behind
  const row = { ...known, ...(await owedRowOf(env.DB, known.pubkey)) };
  const { blocked, owes } = autoBlock(row, paid, { ...terms, now });
  if (!blocked) return null;
  const until = await subscribedUntilOf().catch(() => null);
  if (until !== null && until > now) return null;
  return owes;
}

/** What a wallet still owes, in whole micros, by the rules Auto-block uses
 *  (spec/standing.mjs): its listening's cost less what it has paid. 0 for a
 *  wallet this server doesn't know, without a price, while payments are
 *  paused (nobody can pay), or without a record of payments to compare. */
async function owesNow(env: Env, ctx: ExecutionContext | undefined, pubkey: string): Promise<number> {
  const priced = pricing(await manifestNowOf(env));
  if (!priced || !(await takingPayments(env, ctx).catch(() => false))) return 0;
  const known = await listener(env.DB, pubkey);
  if (!known) return 0;
  const paid = await paidOf(env.DB, pubkey);
  if (paid === null) return 0;
  return unpaidOf(owedOf({ ...known, ...(await owedRowOf(env.DB, pubkey)) }, priced.ratePerMinute), paid);
}

/** The listeners as the editor gets them: each with what it owes by this
 *  server's count, and whether Auto-block is refusing it right now. */
async function withStanding(env: Env, rows: Awaited<ReturnType<typeof listeners>>) {
  const terms = await autoBlockTerms(env).catch(() => null);
  const priced = terms ?? pricing(await manifestNowOf(env));
  const now = Date.now();
  return rows.map((r) => {
    // Read without the paid table (a database from before it): nobody can
    // say who's behind, so nobody is shown as refused.
    const paidKnown = "paid_micros" in r;
    const subscribed = r.subscribed_until !== null && r.subscribed_until > now;
    const s = priced ? autoBlock(r, Number(r.paid_micros) || 0, { ...priced, subscribed, now }) : { blocked: false, owes: 0 };
    return { ...r, auto_blocked: !!terms && paidKnown && !r.blocked && s.blocked, owes_micros: s.owes };
  });
}

/**
 * Wallet → micros, as the editor sends what it read from the chain: at most
 * MAX_PAID_WALLETS, each a real address and a whole, non-negative number.
 * Null if anything in it isn't.
 */
function paidTotals(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_PAID_WALLETS) return null;
  const out: Record<string, number> = {};
  for (const [wallet, micros] of entries) {
    if (fromBase58(wallet)?.length !== 32) return null;
    if (typeof micros !== "number" || !Number.isSafeInteger(micros) || micros < 0) return null;
    out[wallet] = micros;
  }
  return out;
}

/** How long after it landed a payment can be reported to /listen/paid. The
 *  app reports one as soon as it sees it land; the week it may hold a debt
 *  covers an app closed in between. Older payments can't be brought back to
 *  be counted against listening they didn't pay for. */
const REPORT_WITHIN_MS = SETTLE_WITHIN_DAYS * 86_400_000;

/** Stripe's trouble, as a listener hears it. What Stripe said is about the
 *  artist's own account (a missing permission, an inactive key) and is the
 *  artist's to see in their editor, not every listener's. */
const stripeTrouble = () => fail(502, "Couldn't confirm that with Stripe; try again");

/**
 * The app's report of a play (/listen/played): a play in the artist's record
 * of who listens, and the song's row in `served` (what its app says it heard,
 * beside what this server sent). Never money: what's owed is this server's
 * own count of what it sent (meter.ts, store.ts billSent), so the artist
 * relies on nothing the listener's app says.
 *
 * Which track: the app says, by the song's id (`track`); an older app's
 * report goes with the track sent furthest ahead of what's been reported.
 * What this copy of the Worker had sent of it and not yet written goes in the
 * same write. False when there's no table: the caller records the play alone.
 */
async function reportServed(env: Env, who: string, trackId: string, seconds: number): Promise<boolean> {
  const text = await manifestText(env).catch(() => null);
  const tracks = text ? tracksOf(derive(text)) : null;
  const now = Date.now();
  const found = trackId ? tracks?.byId.get(trackId) ?? null : null;
  let k;
  try {
    if (found) k = { pubkey: who, track: found.key, day: await servedDayFor(env.DB, who, found.key, now) };
    else {
      const guess = await unreportedServed(env.DB, who, now);
      k = guess && tracks?.byKey.get(guess.track) ? { pubkey: who, ...guess } : { pubkey: who, track: "", day: servedDay(now) };
    }
    // Only what the app says, beside what was sent, and a play in the record.
    // Nothing here touches what this server counted or bills (meter.ts).
    await inOneGo(env.DB, [
      addServed(env.DB, k, { reported: seconds, cap: 0 }),
      aPlay(env.DB, who, now),
    ]);
    return true;
  } catch (e) {
    if (/no such table/i.test(String((e as Error)?.message ?? e))) return false;
    throw e;
  }
}

/** Everything a listener can do without being the artist. */
async function handleListen(request: Request, env: Env, path: string, ctx?: ExecutionContext): Promise<Response | null> {
  const host = new URL(request.url).host;

  if (path === "/challenge" && request.method === "POST") {
    return json({ challenge: challenge(host) });
  }

  if (path === "/token" && request.method === "POST") {
    const body = await jsonBody(request);
    if (!body) return fail(400, "bad request");
    // A wallet this node hasn't seen counts against the cap on brand-new
    // listeners here, where its pass is issued, not only at its first play:
    // made-up wallets otherwise get passes (and paid audio) without end.
    const address = String((body as { address?: string }).address);
    // Whether they have paid for a subscription: checked with Stripe when due
    // (a renewal, or once a day), else as known. Asked once, whether
    // Auto-block asks first or not.
    let asked: Promise<number | null> | null = null;
    const untilOf = () => (asked ??= refresh(env.DB, address).catch(() => subscribedUntil(env.DB, address)));
    const result = await introduce(env.DB, host, body as never, Date.now(),
      () => allow(env as never, RULES.newListener, host),
      (known) => owingFor(env, ctx, known, untilOf));
    if (!result.ok) {
      if (result.busy) return tooMany(withCors(new Headers()));
      // Auto-block: told what's owed, in micros, so their app can pay it and
      // ask again. The words are for a person; `code` is for the app.
      if (result.unpaid !== undefined) return json({ error: result.why, code: "unpaid", owes: result.unpaid }, 403);
      return fail(403, result.why || "refused");
    }

    // A subscriber's app knows not to charge them by the minute as well. And
    // where a subscription is the only way this artist is paid, it is
    // required: with nothing else offered, a wallet on its own would
    // otherwise be free listening.
    const until = await untilOf();
    const subscribed = until !== null && until > Date.now();
    const manifest = (await listenerView(env, ctx))?.parsed ?? null;   // unreadable: treated as nothing offered
    if (!subscribed && subscriptionOnly(manifest)) {
      return fail(402, "subscribe to hear this artist's paid tracks");
    }
    // What this wallet still owes by this server's count, in micros: what
    // its listening cost (owed, which includes what the server metered
    // itself, meter.ts) less what it has paid — the same number Auto-block
    // refuses with, and 0 when nothing (or nothing it could pay: a
    // subscriber, payments paused). The app pays it without asking only as
    // far as its own count of the listening goes (app/src/paying.js); any
    // more is its listener's call.
    const owes = subscribed ? 0 : await owesNow(env, ctx, address).catch(() => 0);
    return json({ token: result.token, subscribedUntil: subscribed ? until : null, owes });
  }

  // ── paying listeners' network fees (settle.ts, feepay.ts) ────────────────
  // Who would pay the fee, if this node will. Offered only while the fee
  // wallet holds enough; otherwise there's no offer, and the artist's USDC
  // price is served paused. Listeners never pay a network fee themselves.
  if (path === "/fees" && request.method === "GET") {
    const offer = await feeOffer(env, ctx).catch(() => null);
    return json(offer ?? { feePayer: null });
  }

  // A listener's payment, signed by them, for this node to add its fee
  // signature to and send. What it may contain comes from the artist's
  // manifest, never from the request; `item` only says which price applies.
  if (path === "/settle" && request.method === "POST") {
    if (Number(request.headers.get("Content-Length") || 0) > 4096) return fail(413, "too large");
    const body = await jsonBody(request);
    if (!body) return fail(400, "bad request");
    const offer = await feeOffer(env).catch(() => null);
    if (!offer) return fail(409, "this artist's node isn't paying network fees right now");
    const manifest = await manifestNowOf(env);
    const pay = walletOf(manifest)!;
    let limits = { minMicros: LISTEN_MIN_MICROS, maxMicros: LISTEN_MAX_MICROS } as { minMicros: number; maxMicros: number; memo?: string };
    if (body.tip === true) {
      // A tip: any amount the listener chooses, within the app's own limits,
      // and marked as one so it's never taken for paying for listening.
      limits = { minMicros: TIP_MIN_MICROS, maxMicros: TIP_MAX_MICROS, memo: tipMemo(host) };
    } else if (body.item !== undefined) {
      const item = String(body.item);
      const sale = itemFor(manifest, item);
      if (!sale || !sale.wallet) return fail(404, "that isn't for sale for USDC here");
      const price = Math.round(sale.price * 1e6);
      limits = { minMicros: price, maxMicros: price, memo: purchaseMemo(host, item) };
    }
    const result = await settle(env.DB, rpcAt(CHAINS[pay.network].rpc), body.tx, {
      mint: CHAINS[pay.network].mint, payees: pay.recipients, ...limits,
    }, {
      // Per paying wallet, on top of the per-address count every listener
      // request already has.
      allowed: (who) => allow(env as never, RULES.wallet, `${host}|settle|${who}`),
    });
    if (!result.ok) return fail(result.status, result.why);
    // Paying for listening, landed: counted towards what this wallet has paid
    // (Auto-block reads it). Not a tip or a purchase, which pay for something
    // else; and not a send that hasn't been seen to land, which the app
    // reports at /listen/paid once it has.
    if (result.confirmed && body.tip !== true && body.item === undefined) {
      await recordPaid(env.DB, result.listener, result.micros, result.signature).catch(() => false);
    }
    return json({ signature: result.signature, confirmed: result.confirmed });
  }

  // A payment for listening the app saw land after this node sent it
  // unconfirmed (or one it made some other way): counted towards what the
  // wallet has paid, once the node has read it off the chain itself. Only the
  // signature is taken from the request; who paid, how much and to whom come
  // from the chain. Open to a wallet Auto-block is refusing — paying is how it
  // gets served again — and limited per address, since each one asks the
  // network once.
  if (path === "/paid" && request.method === "POST") {
    const body = await jsonBody(request);
    const signature = String(body?.signature || "");
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) return fail(400, "that isn't a transaction signature");
    const from = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!(await allow(env as never, RULES.wallet, `${host}|paid|${from}`))) return tooMany(withCors(new Headers()));
    const already = await paidSigKnown(env.DB, signature);
    if (already) {
      return json({ recorded: false, wallet: already.pubkey, micros: already.micros, paidMicros: await paidOf(env.DB, already.pubkey) });
    }
    const pay = walletOf(await manifestNowOf(env));
    const chain = pay && CHAINS[pay.network];
    if (!pay || !chain) return fail(409, "this artist doesn't take USDC payments here");
    const accounts = new Map<string, string>();
    try {
      for (const r of pay.recipients) accounts.set(await tokenAccountOf(r.address, chain.mint, TOKEN_PROGRAM, ATA_PROGRAM), r.address);
    } catch {
      return fail(409, "this artist's payment details can't be read");
    }
    let tx: unknown;
    try {
      // One question to the network per report (rpcAt asks again only when
      // it answers busy).
      tx = await rpcAt(chain.rpc)("getTransaction", [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
    } catch {
      return fail(502, "couldn't reach the network; try again in a minute");
    }
    const verdict = readListeningPayment(tx, { mint: chain.mint, accounts, now: Date.now(), withinMs: REPORT_WITHIN_MS });
    if (!verdict.ok) return verdict.retry ? json({ pending: true, error: verdict.why }, 202) : fail(422, verdict.why);
    if (!(await listener(env.DB, verdict.payer))) return fail(403, "that payment is from a wallet that hasn't listened here");
    const recorded = await recordPaid(env.DB, verdict.payer, verdict.micros, signature);
    return json({ recorded, wallet: verdict.payer, micros: verdict.micros, paidMicros: await paidOf(env.DB, verdict.payer) });
  }

  // A listener sending their own money out, with no SOL for the fee: this
  // node pays it, and the listener pays the artist back in USDC in the same
  // transfer (more if the destination's account has to be opened). Only for
  // someone who has listened here, at the usual per-wallet pace.
  if (path === "/withdraw" && request.method === "POST") {
    if (Number(request.headers.get("Content-Length") || 0) > 4096) return fail(413, "too large");
    const body = await jsonBody(request);
    if (!body) return fail(400, "bad request");
    const offer = await feeOffer(env).catch(() => null);
    if (!offer) return fail(409, "this artist's node isn't paying network fees right now");
    const pay = walletOf(await manifestNowOf(env))!;
    const chain = CHAINS[pay.network];
    const to = String(body.to || "").trim();
    if (!keyOf(to)) return fail(400, "that isn't a Solana address");
    if (to === offer.feePayer || pay.recipients.some((r) => r.address === to)) return fail(400, "that address can't be sent to this way");
    const rpc = rpcAt(chain.rpc);
    let fee = WITHDRAW_FEE_MICROS;
    let opensDestination = false;
    try {
      const ata = await tokenAccountOf(to, chain.mint, TOKEN_PROGRAM, ATA_PROGRAM);
      const info = await rpc("getAccountInfo", [ata, { encoding: "base64", commitment: "confirmed" }]);
      if (!info?.value) { fee += NEW_ACCOUNT_FEE_MICROS; opensDestination = true; }
    } catch {
      return fail(502, "couldn't reach the network; nothing was sent");
    }
    const result = await settle(env.DB, rpc, body.tx, {
      mint: chain.mint,
      payees: [{ address: to }, { address: offer.withdraw.to }],
      minMicros: 10_000, maxMicros: 10_000_000_000,
      withdrawal: { fee },
      // The destination's account may be opened only when the listener is
      // paying for that (it was missing just now): otherwise it could be
      // closed between that look and the send, and the fee wallet would pay
      // its rent, again and again. Existing, it's simply paid into.
      mayOpen: opensDestination ? [to, offer.withdraw.to] : [offer.withdraw.to],
    }, {
      allowed: async (who) => !!(await listener(env.DB, who)) && allow(env as never, RULES.wallet, `${host}|withdraw|${who}`),
      // Each opened at most once by the fee wallet: the artist's own, and a
      // destination opened for a listener, so neither can be closed for its
      // rent and reopened at the fee wallet's cost.
      openOnce: [offer.withdraw.to, to],
    });
    if (!result.ok) return fail(result.status, result.why);
    return json({ signature: result.signature, confirmed: result.confirmed });
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
      return json({ outcome, subscribedUntil: until });
    } catch (e) {
      return stripeTrouble();
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
      return stripeTrouble();
    }
  }

  // Paid in USDC: the transaction, and what it was for. The chain is asked.
  if (path === "/buy/wallet" && request.method === "POST") {
    const body = await jsonBody(request);
    if (!body) return fail(400, "bad request");
    const proof = await proveOwnership(host, body as never);
    if (!proof.ok) return fail(403, proof.why);
    const r = await claimWalletSale(env.DB, await manifestNowOf(env), {
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
    const manifest = await manifestNowOf(env) as { releases?: { tracks?: { id: string; title: string; url: string; master?: string }[] }[] } | null;
    const trackId = String(body.track || "");
    const track = (manifest?.releases || []).flatMap((r) => r.tracks || []).find((t) => t.id === trackId);
    if (!track) return fail(404, "no such song");
    // Only a file this server holds: the song's original if it streams from an
    // evened-out copy, else its own address, here.
    let key: string | null = null;
    try {
      const u = new URL(track.master || track.url);
      if (u.origin === new URL(request.url).origin && u.pathname.startsWith("/audio/")) key = safeKey("audio", u.pathname.slice("/audio/".length));
    } catch { /* not a URL */ }
    if (!key) return fail(409, "this song's file isn't kept on this server");
    const head = await media(env).head(key);
    if (!head) return fail(404, "that file is missing");
    const taken = await takeDownload(env.DB, manifest, proof.address, trackId);
    if (!taken) return fail(403, "you don't own this song here, or its downloads are used up");
    // A card purchase refunded or disputed since buys no more downloads.
    if (/^cs_/.test(taken.ref) && (await refundedSale(env.DB, taken.ref)) === true) {
      return fail(403, "this purchase was refunded, so it can't be downloaded");
    }
    const object = await media(env).get(key);
    if (!object || !("body" in object)) return fail(404, "that file is missing");
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
      return json({ url });
    } catch (e) {
      return stripeTrouble();
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
    const seconds = Math.max(0, Math.min(Math.round(Number(body?.seconds) || 0), MAX_REPORT_S));
    // A play for the record, never money (reportServed).
    if (!(await reportServed(env, who, String(body?.track ?? ""), seconds))) {
      await counted(env.DB, who, seconds, Date.now());
    }
    // Now and then, clear out wallets not heard from in a year. Here rather
    // than on a timer, so there is nothing for an artist to set up; and at
    // most hourly, since it reads the whole table (pruneHourly).
    if (Math.random() < 0.02) await pruneHourly(env.DB).catch(() => {});
    return new Response(null, { status: 204, headers: noStore() });
  }

  // A song finished playing: counted for the song, by nobody in particular.
  // Nothing about who is recorded. Each report is two writes to the artist's
  // database, whose daily allowance everything else needs too, so: a paid
  // track is counted only with a listener's pass, at most as fast as songs
  // end, per wallet and per address; a track anyone may hear can be reported
  // without one, but only a few times a minute per address (limits.ts). Only
  // a track on the published page is counted, so made-up names can't fill the
  // table. Over a limit the play just isn't counted: nothing goes wrong for
  // the listener.
  if (path === "/heard" && request.method === "POST") {
    const nothing = () => new Response(null, { status: 204, headers: noStore() });
    const body = await jsonBody(request);
    const trackId = String(body?.track || "");
    const seconds = Number(body?.seconds) || 0;
    if (seconds < 30) return nothing();
    // As listeners get it: while payments are paused, paid songs play free.
    let manifest: unknown = null;
    try { manifest = JSON.parse((await listenerText(env)) || "null"); } catch { return nothing(); }
    type Track = { id?: string; url?: string; free?: boolean; needsWallet?: boolean };
    const track = ((manifest as { releases?: { tracks?: Track[] }[] } | null)?.releases || [])
      .flatMap((r) => r.tracks || []).find((t) => t?.id === trackId);
    if (!track) return nothing();
    const from = request.headers.get("CF-Connecting-IP") || "unknown";
    const who = await whoIsAsking(request, env);
    if (who) {
      if (!(await allow(env as never, RULES.wallet, `${host}|heard|${who}`))) return nothing();
      if (!(await allow(env as never, RULES.wallet, `${host}|heard-from|${from}`))) return nothing();
    } else {
      if (needsWallet(manifest, track)) return nothing();
      if (!(await allow(env as never, RULES.heard, `${host}|${from}`))) return nothing();
    }
    await heard(env.DB, trackId, seconds).catch(() => {});
    return nothing();
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
    forgetTallies(proof.address);
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
    // What was sent to this wallet in the last three days (meter.ts), counted.
    const servedTracks = await servedCount(env.DB, proof.address);
    return json({
      controller: host,
      wallet: proof.address,
      held: row || servedTracks
        ? {
            plays: row?.plays ?? 0,
            seconds: row?.seconds ?? 0,
            costMicros: await env.DB.prepare("SELECT micros FROM owed WHERE pubkey = ?").bind(proof.address)
              .first<{ micros: number }>().then((o) => o?.micros ?? null).catch(() => null),
            paidMicros: await env.DB.prepare("SELECT micros FROM paid WHERE pubkey = ?").bind(proof.address)
              .first<{ micros: number }>().then((o) => o?.micros ?? null).catch(() => null),
            firstSeen: row?.first_seen ? new Date(row.first_seen).toISOString() : null,
            lastSeen: row?.last_seen ? new Date(row.last_seen).toISOString() : null,
            servingStopped: !!row?.blocked,
            // How many (track, day) rows of seconds sent, reported and
            // billed are held for the last three days: one per paid track
            // sent to this wallet each day. Erasing deletes them.
            servedTracks: servedTracks ?? 0,
          }
        : null,
      subscribedUntil: await subscribedUntil(env.DB, proof.address).then((u) => (u ? new Date(u).toISOString() : null)),
      purchases: await purchasesOf(env.DB, proof.address).then(({ owned, gifts }) =>
        [...owned, ...gifts].map((s) => ({ item: s.item, paidWith: s.via, when: new Date(s.created).toISOString(), gift: !s.owner }))).catch(() => []),
      notHeld: "A history of what you played, or when. For the last three days only, this server keeps how many seconds of each paid track it sent you each day, to charge for listening fairly; then it deletes them.",
      keptFor: "Totals: a year after you were last here. What was sent: three days. Then deleted automatically.",
      exported: new Date().toISOString(),
    }, 200, 2);
  }

  return null;
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    try {
      return await serve(request, env, ctx);
    } catch (e) {
      // Cloudflare's free plan saying no (quota.ts): say what, and when it
      // comes back, rather than an internal error.
      const said = quotaFailure(e);
      if (said) return fail(said.status, said.message);
      throw e;
    }
  },
} satisfies ExportedHandler<Env>;

async function serve(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
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
    const answered = await handleListen(request, env, pathname.slice("/listen".length), ctx);
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
    // The artist, before their editor is protected, arriving from elsewhere
    // (Cloudflare's dashboard links here after a claim): to the editor.
    if (arriving(request) && !(await accessConfig(env)).set
        && await previewSession(request, readPreviewKey(await setting(env.DB, PREVIEW_KEY)))) {
      return new Response(null, { status: 302, headers: noStore({ Location: "/manage" }) });
    }
    const view = await listenerView(env, ctx);
    if (view === null) return fail(404, "no manifest published yet");
    if (view.parsed === undefined) return fail(500, "manifest is not valid JSON");
    const manifest = view.parsed;
    const { nonce, headers } = pageHeaders();
    if (request.method === "HEAD") return new Response(null, { status: 200, headers });
    // Linked to one song or album (/?song=<id>, /?album=<id>): the page's
    // card and button are for that one.
    const q = new URL(request.url).searchParams;
    const kind = q.has("song") ? "song" : q.has("album") ? "album" : null;
    const id = kind ? String(q.get(kind) || "") : "";
    const focus = kind && /^[a-z0-9-]{1,64}$/.test(id) ? { kind, id } as const : null;
    let site: unknown = null;
    try { const t = await siteText(env); site = t ? JSON.parse(t) : null; } catch { /* the plain page, then */ }
    // Turned off in the editor: the plain music page, the site kept for later.
    if ((site as { on?: boolean } | null)?.on === false) site = null;
    return new Response(renderPage(manifest as never, new URL(request.url).origin, nonce, focus, site), {
      status: 200, headers,
    });
  }

  if (pathname === "/manifest.json") return serveManifest(env, ctx);

  // The artist's privacy notice, written by the software from what it
  // actually keeps. See renderPrivacy in page.ts.
  if (pathname === "/privacy") {
    const body = await manifestText(env);
    let manifest: unknown = {};
    try { if (body) manifest = JSON.parse(body); } catch { /* an empty notice beats an error */ }
    const { nonce, headers } = pageHeaders();
    if (request.method === "HEAD") return new Response(null, { status: 200, headers });
    const autoBlocking = (await autoBlockSetting(env.DB)).enabled;
    return new Response(renderPrivacy(manifest as never, new URL(request.url).origin, nonce, { autoBlock: autoBlocking }), {
      status: 200, headers,
    });
  }

  // The artist's public page, installable on a fan's Home Screen.
  if (pathname === "/page.webmanifest") {
    let manifest: unknown = null;
    try { const t = await manifestText(env); manifest = t ? JSON.parse(t) : null; } catch { /* a plain name */ }
    return new Response(pageWebManifest((manifest || {}) as never), {
      status: 200, headers: withCors(new Headers({ "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=3600" })),
    });
  }

  // The editor, installable on the artist's Home Screen (studio.ts).
  if (pathname === MANIFEST_PATH) {
    return new Response(studioManifest(), {
      status: 200, headers: withCors(new Headers({ "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=86400" })),
    });
  }
  if (pathname === FAVICON_PATH) {
    return new Response(FAVICON, {
      status: 200, headers: withCors(new Headers({ "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=604800" })),
    });
  }
  if (ICONS[pathname]) {
    return new Response(ICONS[pathname], {
      status: 200, headers: withCors(new Headers({ "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" })),
    });
  }

  if (pathname === "/version") {
    return json({ version: VERSION, spec: SPEC_VERSION });
  }

  if (pathname.startsWith("/audio/")) {
    const key = safeKey("audio", pathname.slice("/audio/".length));
    if (key === null) return fail(400, "bad key");

    // Paid tracks are served only to a listener who has said who they are.
    // Everything else is served to anyone, and that default is what keeps a
    // shared link working.
    // Worked out once per manifest, not for every ranged piece of a song.
    const view = await listenerView(env, ctx);
    // An unreadable manifest must not be a way past the guard. Nothing is
    // known to be open, so nothing is served without a wallet.
    if (view && view.parsed === undefined) return fail(503, "this music is temporarily unavailable");
    // An original behind an evened-out copy: only ever a purchase download.
    if (view && mastersOf(view).has(key.slice("audio/".length))) {
      return fail(403, "this file is only available as a download, to someone who bought it");
    }
    if (view && guardedOf(view).has(key.slice("audio/".length))) {
      const who = await whoIsAsking(request, env);
      if (!who) {
        return fail(401, "this track is for listeners who have said who they are");
      }
      // Kept privately by the listener's browser for a year, and replayed
      // from there without asking: that's fine for metering (meter.ts), since
      // what's billed is what was sent, and a replay from the cache wasn't
      // sent again. A shared cache still can't keep it.
      const served = await serveObject(env, request, key, CACHE_AUDIO_PAID, "audio/mpeg");
      return meterAudio(request, env, ctx, served, who, key.slice("audio/".length), view);
    }
    // Free right now only because payments are paused: still the artist's
    // paid music, and kept for a year, so not left in shared caches to be
    // served free once payments are back on.
    // (The stored manifest's reading is cached too: derive() keeps it.)
    const own = await manifestText(env).catch(() => null);
    if (own && view && own !== view.text) {
      const stored = derive(own);
      if (stored.parsed !== undefined && guardedOf(stored).has(key.slice("audio/".length))) {
        return serveObject(env, request, key, CACHE_AUDIO_PAID, "audio/mpeg");
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
}
