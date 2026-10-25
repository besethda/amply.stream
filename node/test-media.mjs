/**
 * KV standing in for R2 (src/media.ts).
 *
 * A node that starts in a temporary Cloudflare account keeps its files in KV,
 * and the rest of the node must not be able to tell. So these hold KV to what
 * R2 does: a range only when one was asked for, a throw for one that can't be
 * satisfied (the caller answers 416), no body when a conditional request
 * matches, and a clear refusal for a file KV can't hold.
 *
 * Run via `npm run test:media`. KV is faked with a Map, shaped like the real one.
 */
import { media, kvMedia, maxObject, parseRange, MediaTooLarge, KV_MAX, R2_MAX } from "./src/media.ts";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

/** The slice of KVNamespace media.ts uses. */
function fakeKV() {
  const rows = new Map();
  return {
    rows,
    async getWithMetadata(key, { type }) {
      const row = rows.get(key);
      if (!row) return { value: null, metadata: null };
      const copy = row.bytes.slice(0);
      return { value: type === "stream" ? new Blob([copy]).stream() : copy, metadata: row.metadata ?? null };
    },
    async put(key, value, { metadata } = {}) { rows.set(key, { bytes: value.slice(0), metadata }); },
    async delete(key) { rows.delete(key); },
  };
}

const read = async (object) => new Uint8Array(await new Response(object.body).arrayBuffer());
const song = new Uint8Array(100).map((_, i) => i);   // byte i holds the value i

const kv = fakeKV();
const store = kvMedia(kv);
await store.put("audio/song.mp3", song.buffer, { httpMetadata: { contentType: "audio/mpeg" } });

// ── a plain read ────────────────────────────────────────────────────────────
{
  const object = await store.get("audio/song.mp3");
  ok("a stored file comes back whole", (await read(object)).length === 100);
  ok("  with its size", object.size === 100);
  ok("  and no range, since none was asked for", object.range === undefined);
  ok("  and a quoted etag", /^"[0-9a-f]{32}"$/.test(object.httpEtag), object.httpEtag);
  const h = new Headers();
  object.writeHttpMetadata(h);
  ok("  and the type it was stored as", h.get("Content-Type") === "audio/mpeg");
  ok("a missing file is null", (await store.get("audio/nope.mp3")) === null);
}

// ── ranges, which seeking depends on ────────────────────────────────────────
{
  const get = (range) => store.get("audio/song.mp3", { range: new Headers({ Range: range }) });

  let object = await get("bytes=10-19");
  let bytes = await read(object);
  ok("a range returns exactly those bytes", bytes.length === 10 && bytes[0] === 10 && bytes[9] === 19);
  ok("  and says which", object.range?.offset === 10 && object.range?.length === 10);
  ok("  while size stays the whole file's", object.size === 100);

  object = await get("bytes=90-");
  bytes = await read(object);
  ok("an open-ended range runs to the end", bytes.length === 10 && bytes[0] === 90);

  object = await get("bytes=-5");
  bytes = await read(object);
  ok("a suffix range is the last bytes", bytes.length === 5 && bytes[0] === 95);

  object = await get("bytes=95-500");
  ok("a range past the end is cut to the end", object.range?.length === 5);

  let threw = false;
  try { await get("bytes=100-"); } catch { threw = true; }
  ok("a range starting past the end throws, so the caller answers 416", threw);
  threw = false;
  try { await get("bytes=-0"); } catch { threw = true; }
  ok("  so does an empty suffix", threw);

  object = await get("bytes=0-1, 5-6");
  ok("several ranges at once: the whole file, as R2 does", object.range === undefined && (await read(object)).length === 100);
  ok("a unit that isn't bytes: the whole file", parseRange("items=0-1", 100) === undefined);
}

// ── conditional requests, which keep a replay from re-downloading ───────────
{
  const { httpEtag } = await store.head("audio/song.mp3");
  const when = (headers) => store.get("audio/song.mp3", { onlyIf: new Headers(headers) });

  ok("If-None-Match with its etag: no body", !("body" in await when({ "If-None-Match": httpEtag })));
  ok("  nor with a weak form of it", !("body" in await when({ "If-None-Match": `W/${httpEtag}` })));
  ok("  nor with *", !("body" in await when({ "If-None-Match": "*" })));
  ok("If-None-Match with another etag: the body", "body" in await when({ "If-None-Match": '"other"' }));
  ok("If-Modified-Since after it was stored: no body",
    !("body" in await when({ "If-Modified-Since": new Date(Date.now() + 60_000).toUTCString() })));
  ok("If-Modified-Since long before: the body",
    "body" in await when({ "If-Modified-Since": new Date(0).toUTCString() }));
  ok("If-Match with another etag: no body", !("body" in await when({ "If-Match": '"other"' })));
}

// ── HEAD, sizes, and what KV can't hold ─────────────────────────────────────
{
  const head = await store.head("audio/song.mp3");
  ok("HEAD knows the size without a body", head.size === 100 && !("body" in head));
  ok("HEAD of a missing file is null", (await store.head("audio/nope.mp3")) === null);

  // Setup writes the editor through Cloudflare's API, with no metadata.
  kv.rows.set("manage/index.html", { bytes: new TextEncoder().encode("<!doctype html>").buffer });
  const editor = await store.get("manage/index.html");
  ok("a file written without metadata still reads, with its size", editor.size === 15 && (await read(editor)).length === 15);
  ok("  and HEAD still knows it", (await store.head("manage/index.html")).size === 15);

  let refused = null;
  try { await store.put("audio/huge.wav", new ArrayBuffer(KV_MAX + 1)); } catch (e) { refused = e; }
  ok("a file over KV's 25 MB is refused", refused instanceof MediaTooLarge);
  ok("  saying what the limit is", /25 MB/.test(refused?.message ?? ""), refused?.message);
  ok("  and nothing is stored", !kv.rows.has("audio/huge.wav"));

  await store.delete("audio/song.mp3");
  ok("a deleted file is gone", (await store.get("audio/song.mp3")) === null);
}

// ── which storage a node uses ───────────────────────────────────────────────
{
  const bucket = { get: async () => "r2", head: async () => null, put: async () => null, delete: async () => {} };
  ok("R2 is used when the node has it", (await media({ MEDIA: bucket, MEDIA_KV: fakeKV() }).get("x")) === "r2");
  ok("  and allows 100 MB", maxObject({ MEDIA: bucket }) === R2_MAX);
  ok("KV is used when R2 isn't bound", (await media({ MEDIA_KV: fakeKV() }).get("x")) === null);
  ok("  and allows 25 MB", maxObject({ MEDIA_KV: fakeKV() }) === KV_MAX);
  let threw = false;
  try { media({}); } catch { threw = true; }
  ok("a node with neither says so, rather than failing later", threw);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
