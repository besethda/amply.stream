/**
 * A song's streaming copy: the same song at the common loudness (and a size
 * that streams well), made in the artist's browser at upload.
 *
 * The original file is kept as it is, for downloads. Listeners stream the
 * copy, an ordinary MP3, so every player plays it at the right level, iPhone
 * included, with nothing to adjust while it plays (spec/loudness.mjs).
 */
import { integratedLoudness, gainFor, normalize, needsStreamCopy } from "../../spec/loudness.mjs";

export const STREAM_RATE = 44100;
export const STREAM_KBPS = 256;
const LONGEST_S = 20 * 60;   // decoding holds the whole song in memory
const FRAME = 1152 * 32;     // samples handed to the encoder at a time

/** The whole song, decoded to stereo at 44.1 kHz (mono is spread to both sides). */
export async function decodeStereo(blob) {
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Offline) throw new Error("this browser can't read audio");
  const ctx = new Offline(2, 1, STREAM_RATE);
  const bytes = await blob.arrayBuffer();
  const buffer = await new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(bytes, resolve, reject);
    p?.then?.(resolve, reject);
  });
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  return [left, right];
}

const breathe = () => new Promise((r) => setTimeout(r, 0));

/**
 * The MP3 encoder (lamejs, LGPL-3.0), fetched the first time a song needs a
 * streaming copy: from the npm package as published, through either of two
 * public CDNs, and run only if it's byte for byte the file this editor was
 * built with (its SHA-256, pinned here). So the artist's node doesn't carry
 * 250 KB it only needs while uploading, and no CDN has to be trusted: a file
 * that differs isn't run. If neither answers with it, the song goes up as it
 * is, without a streaming copy (ui.jsx).
 */
export const LAMEJS = {
  version: "1.2.7",
  sha256: "1c5f944911ccf2f6e29ab36c2e568363210ab16f50c0d76077060f40ecf91d28",
  sources: [
    "https://cdn.jsdelivr.net/npm/@breezystack/lamejs@1.2.7/dist/lamejs.js",
    "https://unpkg.com/@breezystack/lamejs@1.2.7/dist/lamejs.js",
  ],
};
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
/** The encoder's source, checked: from the first source that has the right bytes. */
export async function fetchEncoder({ sources = LAMEJS.sources, sha256 = LAMEJS.sha256, get = fetch } = {}) {
  for (const url of sources) {
    try {
      const res = await get(url, { cache: "force-cache" });
      if (!res.ok) continue;
      const bytes = await res.arrayBuffer();
      if (hex(await crypto.subtle.digest("SHA-256", bytes)) === sha256) return bytes;
    } catch { /* the next one */ }
  }
  throw new Error("The MP3 encoder couldn't be fetched.");
}
let encoder = null;
export function loadEncoder() {
  encoder ??= fetchEncoder().then(async (bytes) => {
    // Run from the checked bytes themselves, never from the network again.
    const src = URL.createObjectURL(new Blob([bytes], { type: "text/javascript" }));
    try { return await import(src); } finally { URL.revokeObjectURL(src); }
  }).catch((e) => { encoder = null; throw e; });
  return encoder;
}

/** Float samples to an MP3, yielding as it goes so the page stays responsive. */
export async function encodeMp3([left, right], { kbps = STREAM_KBPS, onProgress } = {}) {
  const { Mp3Encoder } = await loadEncoder();
  const enc = new Mp3Encoder(2, STREAM_RATE, kbps);
  const toInt = (f, from, to) => {
    const out = new Int16Array(to - from);
    for (let i = from; i < to; i++) {
      const v = f[i] < -1 ? -1 : f[i] > 1 ? 1 : f[i];
      out[i - from] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return out;
  };
  const parts = [];
  for (let i = 0; i < left.length; i += FRAME) {
    const end = Math.min(left.length, i + FRAME);
    const chunk = enc.encodeBuffer(toInt(left, i, end), toInt(right, i, end));
    if (chunk.length) parts.push(new Uint8Array(chunk));
    if ((i / FRAME) % 8 === 0) { onProgress?.(end / left.length); await breathe(); }
  }
  const last = enc.flush();
  if (last.length) parts.push(new Uint8Array(last));
  onProgress?.(1);
  return new Blob(parts, { type: "audio/mpeg" });
}

/**
 * Measure a song and, if it needs one, make its streaming copy.
 * Resolves to { lufs, gainDb, blob } where blob is null when the original
 * streams fine as it is; null altogether when the song can't be analysed
 * (then it simply goes up as it is).
 */
/** A song too long to fit the storage even as the smallest copy worth hearing. */
export class TooLong extends Error {}

const RATES = [256, 224, 192, 160, 128, 112, 96];   // MP3 bitrates, best first; below 96 isn't worth streaming

/**
 * The best bitrate that fits a song of `duration` seconds into `maxBytes`,
 * with a little room for the MP3's own framing; null if even 96 kbps won't.
 */
export function fitKbps(duration, maxBytes) {
  if (!maxBytes) return STREAM_KBPS;
  const budget = (maxBytes * 0.97 * 8) / duration / 1000;
  return RATES.find((k) => k <= Math.min(STREAM_KBPS, budget)) ?? null;
}

export async function prepareStream(file, duration, { onProgress, onStage, maxBytes = null, force = false } = {}) {
  if (!(duration > 0) || duration > LONGEST_S) return null;
  let channels;
  onStage?.("Reading the song…");
  try { channels = await decodeStereo(file); } catch { return null; }
  onStage?.("Measuring its volume…");
  await breathe();
  const lufs = integratedLoudness(channels, STREAM_RATE);
  if (!Number.isFinite(lufs)) return null;
  const ext = String(file.name || "").split(".").pop();
  const kbps = (file.size * 8) / duration / 1000;
  // `force`: the original is too big to store, so a copy it is, whatever else.
  if (!force && !needsStreamCopy({ gainDb: gainFor(lufs), kbps, ext })) return { lufs, gainDb: 0, blob: null };
  // At a bitrate the storage can hold: 256 kbps, or less for a long song.
  const rate = fitKbps(duration, maxBytes);
  if (rate === null) {
    throw new TooLong(`At ${Math.round(duration / 60)} minutes it's too long for your storage (${Math.round(maxBytes / 1048576)} MB a file), even as a smaller copy. Turn on R2 storage in Cloudflare for bigger files.`);
  }
  onStage?.(gainFor(lufs) >= 0 ? "Turning the volume up to match…" : "Turning the volume down to match…");
  await breathe();
  const { out, gainDb } = normalize(channels, STREAM_RATE);
  onStage?.("Optimizing for streaming…");
  const blob = await encodeMp3(out, { kbps: rate, onProgress });
  return { lufs, gainDb, blob };
}
