/**
 * A song's streaming copy: the same song at the common loudness (and a size
 * that streams well), made in the artist's browser at upload.
 *
 * The original file is kept as it is, for downloads. Listeners stream the
 * copy, an ordinary MP3, so every player plays it at the right level, iPhone
 * included, with nothing to adjust while it plays (spec/loudness.mjs).
 */
import { Mp3Encoder } from "@breezystack/lamejs";
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

/** Float samples to an MP3, yielding as it goes so the page stays responsive. */
export async function encodeMp3([left, right], { kbps = STREAM_KBPS, onProgress } = {}) {
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
export async function prepareStream(file, duration, { onProgress } = {}) {
  if (!(duration > 0) || duration > LONGEST_S) return null;
  let channels;
  try { channels = await decodeStereo(file); } catch { return null; }
  const lufs = integratedLoudness(channels, STREAM_RATE);
  if (!Number.isFinite(lufs)) return null;
  const ext = String(file.name || "").split(".").pop();
  const kbps = (file.size * 8) / duration / 1000;
  if (!needsStreamCopy({ gainDb: gainFor(lufs), kbps, ext })) return { lufs, gainDb: 0, blob: null };
  await breathe();
  const { out, gainDb } = normalize(channels, STREAM_RATE);
  const blob = await encodeMp3(out, { onProgress });
  return { lufs, gainDb, blob };
}
