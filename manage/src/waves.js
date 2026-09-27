/**
 * A song's waves file (spec/waves.mjs), made in the artist's browser from the
 * file they picked, so no listener ever has to download the song twice to
 * draw its waveform. Nothing leaves the browser but the finished file.
 */
import { wavesFrom, WAVES_RATE, WAVES_EXT } from "../../spec/waves.mjs";

const LONGEST_S = 30 * 60;   // decoding holds the whole song in memory

/** The waves file for an audio File, as bytes; throws if it can't be decoded. */
export async function makeWaves(file, duration) {
  if (duration > LONGEST_S) throw new Error("too long to analyse");
  const bytes = await file.arrayBuffer();
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Offline) throw new Error("this browser can't analyse audio");
  // Decoded straight to 16 kHz, which is all the bands need and a third of the
  // memory; a browser that won't go that low decodes at the next rate up.
  let ctx;
  for (const rate of [WAVES_RATE, 22050, 44100]) {
    try { ctx = new Offline(1, 1, rate); break; } catch { /* try the next */ }
  }
  if (!ctx) throw new Error("this browser can't analyse audio");
  const buffer = await new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(bytes, resolve, reject);
    p?.then?.(resolve, reject);
  });
  return wavesFrom(buffer);
}

/** Where a song's waves file lives: beside it, same name. */
export const wavesKey = (audioKey) => audioKey.replace(/\.[^./]+$/, "") + `.${WAVES_EXT}`;
