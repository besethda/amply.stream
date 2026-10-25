/**
 * Where the node keeps audio, artwork and the editor: R2, or KV.
 *
 * R2 is the long-standing home and the better one: large files, real range
 * reads, 10 GB free. But R2 can only be switched on by an artist who has added
 * a card, and a temporary Cloudflare account (the kind setup can make before
 * an artist has signed up) can't use it at all. KV needs neither. So a node
 * can start on KV and move to R2 when it outgrows it.
 *
 * The rest of the node talks to one interface, the slice of R2's that it
 * always used. An R2 bucket satisfies it as it is; KV is wrapped to behave the
 * same way, including the parts that are easy to get subtly wrong: a range
 * that can't be satisfied throws (as R2 does), a matching conditional request
 * comes back without a body, and `range` is set only when one was asked for.
 *
 * What KV costs: every read fetches the whole value, so a seek in a 25 MB song
 * reads 25 MB from KV to send a slice of it. Fine for the songs a new artist
 * starts with; the reason R2 is still where a growing node should end up.
 */

/** R2 can also report a suffix range; the node reads offset and length. */
export interface MediaRange { offset?: number; length?: number; suffix?: number }

export interface MediaObject {
  size: number;
  httpEtag: string;
  range?: MediaRange;
  writeHttpMetadata(headers: Headers): void;
}

export interface MediaObjectBody extends MediaObject {
  body: ReadableStream;
}

export interface Media {
  get(key: string, options?: { range?: Headers; onlyIf?: Headers }): Promise<MediaObjectBody | MediaObject | null>;
  head(key: string): Promise<MediaObject | null>;
  put(key: string, body: ReadableStream | ArrayBuffer | string | null, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

export interface MediaEnv {
  MEDIA?: R2Bucket;
  MEDIA_KV?: KVNamespace;
}

/** KV's own ceiling on a single value. */
export const KV_MAX = 25 * 1024 * 1024;
/** What the node has always allowed into R2. */
export const R2_MAX = 100 * 1024 * 1024;

/** Too big for where this node keeps its files. */
export class MediaTooLarge extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`files here can be at most ${Math.floor(limit / 1024 / 1024)} MB`);
    this.limit = limit;
  }
}

/** R2 when the node has it, KV otherwise. */
export function media(env: MediaEnv): Media {
  if (env.MEDIA) return r2Media(env.MEDIA);
  if (env.MEDIA_KV) return kvMedia(env.MEDIA_KV);
  throw new Error("this node has no storage bound (MEDIA or MEDIA_KV)");
}

/** R2 already behaves this way; this only narrows its types to the slice used. */
function r2Media(bucket: R2Bucket): Media {
  return {
    get: (key, options) => bucket.get(key, options ?? {}),
    head: (key) => bucket.head(key),
    put: (key, body, options) => bucket.put(key, body, options),
    delete: (key) => bucket.delete(key),
  };
}

/** The largest file this node can take. */
export function maxObject(env: MediaEnv): number {
  return env.MEDIA ? R2_MAX : KV_MAX;
}

// ── KV, made to behave like the slice of R2 above ───────────────────────────

/** Kept beside each value. KV allows 1 KB of it, and this is a few dozen bytes. */
interface Meta { type?: string; size: number; etag: string; uploaded: number }

/** Shaped like KVNamespace, narrowed to what's used, so tests can fake it. */
interface KV {
  getWithMetadata<M>(key: string, options: { type: "arrayBuffer" }): Promise<{ value: ArrayBuffer | null; metadata: M | null }>;
  getWithMetadata<M>(key: string, options: { type: "stream" }): Promise<{ value: ReadableStream | null; metadata: M | null }>;
  put(key: string, value: ArrayBuffer, options: { metadata: Meta }): Promise<void>;
  delete(key: string): Promise<void>;
}

async function etagOf(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A single byte range, as RFC 9110 reads it against a known size.
 *
 * `undefined` means "serve the whole thing": no Range header, or one this
 * doesn't handle (several ranges, another unit), which is what R2 does too.
 * A range past the end throws, so the caller answers 416.
 */
export function parseRange(header: string | null, size: number): MediaRange | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return undefined;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0) throw new RangeError("unsatisfiable range");
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const offset = Number(m[1]);
  if (offset >= size) throw new RangeError("unsatisfiable range");
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (end < offset) return undefined;
  return { offset, length: end - offset + 1 };
}

const tags = (header: string) => header.split(",").map((t) => t.trim().replace(/^W\//, "").replace(/^"|"$/g, ""));

/**
 * Whether a conditional request is satisfied, as R2's `onlyIf` decides it.
 * `false` means: answer without a body.
 */
export function conditionsHold(headers: Headers | undefined, meta: Meta): boolean {
  if (!headers) return true;
  const ifMatch = headers.get("If-Match");
  if (ifMatch && !tags(ifMatch).some((t) => t === "*" || t === meta.etag)) return false;
  const ifNoneMatch = headers.get("If-None-Match");
  if (ifNoneMatch) return !tags(ifNoneMatch).some((t) => t === "*" || t === meta.etag);
  // HTTP dates have second precision, so compare in whole seconds.
  const since = Date.parse(headers.get("If-Modified-Since") ?? "");
  if (!Number.isNaN(since) && Math.floor(meta.uploaded / 1000) <= Math.floor(since / 1000)) return false;
  const unmodified = Date.parse(headers.get("If-Unmodified-Since") ?? "");
  if (!Number.isNaN(unmodified) && Math.floor(meta.uploaded / 1000) > Math.floor(unmodified / 1000)) return false;
  return true;
}

function described(meta: Meta, range?: MediaRange): MediaObject {
  return {
    size: meta.size,
    httpEtag: `"${meta.etag}"`,
    range,
    writeHttpMetadata(headers: Headers) {
      if (meta.type) headers.set("Content-Type", meta.type);
    },
  };
}

/** A value written without metadata (setup writes the editor through the API) still has a size. */
async function metaFor(bytes: ArrayBuffer, meta: Meta | null): Promise<Meta> {
  return meta ?? { size: bytes.byteLength, etag: await etagOf(bytes), uploaded: 0 };
}

export function kvMedia(kv: KVNamespace | KV): Media {
  const store = kv as KV;
  return {
    async get(key, options = {}) {
      const { value, metadata } = await store.getWithMetadata<Meta>(key, { type: "arrayBuffer" });
      if (value === null) return null;
      const meta = await metaFor(value, metadata);
      if (!conditionsHold(options.onlyIf, meta)) return described(meta);
      const range = parseRange(options.range?.get("Range") ?? null, meta.size);
      const bytes = range ? value.slice(range.offset!, range.offset! + range.length!) : value;
      return { ...described(meta, range), body: new Blob([bytes]).stream() };
    },

    async head(key) {
      // Reading the metadata means reading the value too; the stream is
      // abandoned unread, so nothing large is held for a HEAD.
      const { value, metadata } = await store.getWithMetadata<Meta>(key, { type: "stream" });
      if (value === null) return null;
      if (metadata) {
        await value.cancel();
        return described(metadata);
      }
      return described(await metaFor(await new Response(value).arrayBuffer(), null));
    },

    async put(key, body, options = {}) {
      const bytes = await new Response(body).arrayBuffer();
      if (bytes.byteLength > KV_MAX) throw new MediaTooLarge(KV_MAX);
      const meta: Meta = {
        type: options.httpMetadata?.contentType,
        size: bytes.byteLength,
        etag: await etagOf(bytes),
        uploaded: Date.now(),
      };
      await store.put(key, bytes, { metadata: meta });
    },

    async delete(key) {
      await store.delete(key);
    },
  };
}
