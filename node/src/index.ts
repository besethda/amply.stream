/**
 * Amply node — the Worker an artist runs in their own Cloudflare account.
 *
 * Four jobs, and deliberately nothing else:
 *   GET  /manifest.json   the manifest, from KV
 *   GET  /audio/<key>     audio from R2, with range requests
 *   GET  /art/<key>       images from R2
 *   GET  /version         so a management page can spot a stale node
 *
 * No auth, no sessions, no state, no logic that could be wrong in an interesting way.
 * Keep it that way: every line here is a line someone has to update inside their own
 * cloud account later. See docs/build.md §1B and §1D.
 */

import { verifyAccess, type AccessConfig } from "./access";
import { renderPage, pageCsp } from "./page";

export const VERSION = "2.0.0";
export const SPEC_VERSION = 1;

export interface Env {
  MEDIA: R2Bucket;
  MANIFEST: KVNamespace;
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

/** Clients are web apps on other origins; everything here is public by design. */
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Range, If-None-Match, If-Range, Content-Type, Cf-Access-Jwt-Assertion",
  "Access-Control-Expose-Headers":
    "Content-Length, Content-Range, Content-Type, ETag, Accept-Ranges",
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

async function serveManifest(env: Env): Promise<Response> {
  const body = await env.MANIFEST.get(MANIFEST_KEY, "text");
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
  const raw = await env.MANIFEST.get(ACCESS_KEY, "json");
  const c = raw as AccessConfig | null;
  return c && c.team && c.aud ? c : null;
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
    return fail(503, "this node has no editor configured");
  }

  const email = await verifyAccess(request, config);
  if (!email) {
    return fail(401, "not signed in");
  }

  // The editor itself, stored in R2 and served only to a signed-in artist.
  if (request.method === "GET" && (path === "" || path === "/")) {
    const obj = await env.MEDIA.get(`${MANAGE_PREFIX}/index.html`);
    if (obj === null) return fail(404, "editor not installed on this node");
    const h = noStore({ "Content-Type": "text/html; charset=utf-8" });
    // The editor is self-contained by construction. This makes that a rule
    // rather than a property: it cannot load code from anywhere, and cannot
    // send anything anywhere but back to this node — so a tampered copy
    // cannot exfiltrate an artist's work or their session.
    h.set("Content-Security-Policy", [
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      "img-src 'self' data:",
      "media-src 'self'",
      "connect-src 'self'",
      "form-action 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join("; "));
    return new Response(obj.body, { status: 200, headers: h });
  }

  if (request.method === "GET" && path === "/whoami") {
    return new Response(JSON.stringify({ email, version: VERSION }), {
      status: 200,
      headers: noStore({ "Content-Type": "application/json; charset=utf-8" }),
    });
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
    await env.MANIFEST.put(MANIFEST_KEY, text);
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: withCors() });
    }
    const { pathname } = new URL(request.url);

    // The editor. Guarded; everything else on this node is public and read-only.
    if (pathname === "/manage" || pathname.startsWith("/manage/")) {
      return handleManage(request, env, pathname.slice("/manage".length));
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      const h = withCors(new Headers({ Allow: "GET, HEAD, OPTIONS" }));
      return new Response(null, { status: 405, headers: h });
    }

    // The artist's public page. Their node URL is the only way anyone finds
    // them, so it has to be a page — not a 404, and not raw JSON.
    if (pathname === "/") {
      const body = await env.MANIFEST.get(MANIFEST_KEY, "text");
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
      return new Response(renderPage(manifest as never, new URL(request.url).origin, nonce), {
        status: 200, headers,
      });
    }

    if (pathname === "/manifest.json") return serveManifest(env);

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
