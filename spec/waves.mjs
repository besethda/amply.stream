/**
 * Waves: how loud each part of a song is, moment by moment, worked out once
 * when the artist uploads it, so a listening app can draw a waveform that
 * moves with the music without downloading the song a second time.
 *
 * The file is small — about 14 KB a minute — and says nothing a waveform
 * doesn't show: a handful of loudness values per frame can't be turned back
 * into music. It is public even when the song is paid for.
 *
 * What's stored is style-neutral: loudness per frequency band over time. Any
 * look (ribbons, bars, a pulse) is drawn from the same numbers.
 *
 * ## The file (version 1), little-endian
 *
 *     offset  size    what
 *     0       4       "AMPW"
 *     4       1       version, 1
 *     5       1       N, how many bands
 *     6       2       frames per second
 *     8       4       F, how many frames
 *     12      4N      each band's range in Hz: u16 from, u16 to
 *     12+4N   4N      each band's ceiling: f32, the linear RMS a value of 1 stands for
 *     12+8N   F×N     the levels, one byte each, frame by frame (frame 0: bands 0…N-1)
 *
 * Frame i covers the i-th 1/fps of a second from the start of the song.
 *
 * A level byte b means `sqrt(min(1, rms / ceiling))` = b / 255: 1 is how loud
 * that band gets in the loud parts of this song (its 97th percentile), and
 * the square root keeps quiet detail from rounding away. Each band is scaled
 * to itself, so the highs move as visibly as the bass; the ceilings put them
 * back on one scale for anything that needs to compare bands.
 *
 * A reader must refuse a version it doesn't know, and use whatever bands and
 * frame rate the file declares.
 */

export const WAVES_VERSION = 1;
export const WAVES_EXT = "waves";
export const WAVES_FPS = 30;
/** Roughly an octave or so each; decoded at 16 kHz, so nothing above 8 kHz. */
export const WAVES_BANDS = [
  [0, 60], [60, 150], [150, 400], [400, 1000],
  [1000, 2000], [2000, 4000], [4000, 6000], [6000, 8000],
];
/** The sample rate a song is decoded at to be analysed: enough for 8 kHz. */
export const WAVES_RATE = 16000;
const MAGIC = [0x41, 0x4d, 0x50, 0x57];   // "AMPW"
const HEADER = 12;
const CEILING_AT = 0.97;

// ── making one ─────────────────────────────────────────────────────────────

/** RBJ cookbook biquad, normalised (a0 = 1). */
function biquad(type, freq, rate, q = Math.SQRT1_2) {
  const w = (2 * Math.PI * freq) / rate, cos = Math.cos(w), alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b = type === "lowpass"
    ? [(1 - cos) / 2, 1 - cos, (1 - cos) / 2]
    : [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
  return { b0: b[0] / a0, b1: b[1] / a0, b2: b[2] / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
}

/**
 * Start analysing a song of `seconds` at `rate`. Feed it mono samples with
 * `feedWaves`, in as many pieces as you like, then `finishWaves` for the file.
 */
export function startWaves(rate, seconds, { bands = WAVES_BANDS, fps = WAVES_FPS } = {}) {
  const frames = Math.max(1, Math.ceil(seconds * fps));
  return {
    rate, fps, bands, frames,
    filters: bands.map(([from, to]) => [
      ...(from > 0 ? [biquad("highpass", from, rate)] : []),
      ...(to < rate / 2 ? [biquad("lowpass", to, rate)] : []),
    ]),
    rms: new Float32Array(frames * bands.length),
    sums: new Float64Array(bands.length),
    sample: 0, count: 0, frame: 0,
  };
}

/** Feed the next `n` mono samples (default: all of them). */
export function feedWaves(a, samples, n = samples.length) {
  const N = a.bands.length;
  let boundary = Math.round(((a.frame + 1) * a.rate) / a.fps);
  for (let i = 0; i < n; i++) {
    const x = samples[i];
    for (let b = 0; b < N; b++) {
      let y = x;
      for (const f of a.filters[b]) {
        const out = f.b0 * y + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
        f.x2 = f.x1; f.x1 = y; f.y2 = f.y1; f.y1 = out;
        y = out;
      }
      a.sums[b] += y * y;
    }
    a.count++;
    if (++a.sample >= boundary) {
      if (a.frame < a.frames) {
        for (let b = 0; b < N; b++) a.rms[a.frame * N + b] = Math.sqrt(a.sums[b] / a.count);
      }
      a.sums.fill(0); a.count = 0; a.frame++;
      boundary = Math.round(((a.frame + 1) * a.rate) / a.fps);
    }
  }
}

/** The finished file, as bytes. */
export function finishWaves(a) {
  const N = a.bands.length, F = a.frames;
  if (a.count && a.frame < F) {           // a last, partial frame
    for (let b = 0; b < N; b++) a.rms[a.frame * N + b] = Math.sqrt(a.sums[b] / a.count);
  }
  const ceilings = a.bands.map((_, b) => {
    const seen = [];
    for (let i = 0; i < F; i++) seen.push(a.rms[i * N + b]);
    seen.sort((p, q) => p - q);
    return seen[Math.min(F - 1, Math.floor(F * CEILING_AT))] || 0;
  });
  const bytes = new Uint8Array(HEADER + 8 * N + F * N);
  const view = new DataView(bytes.buffer);
  bytes.set(MAGIC, 0);
  view.setUint8(4, WAVES_VERSION);
  view.setUint8(5, N);
  view.setUint16(6, a.fps, true);
  view.setUint32(8, F, true);
  a.bands.forEach(([from, to], b) => {
    view.setUint16(HEADER + 4 * b, from, true);
    view.setUint16(HEADER + 4 * b + 2, to, true);
    view.setFloat32(HEADER + 4 * N + 4 * b, ceilings[b], true);
  });
  const data = HEADER + 8 * N;
  for (let i = 0; i < F; i++) {
    for (let b = 0; b < N; b++) {
      const c = ceilings[b];
      const v = c > 0 ? Math.sqrt(Math.min(1, a.rms[i * N + b] / c)) : 0;
      bytes[data + i * N + b] = Math.round(v * 255);
    }
  }
  return bytes;
}

/**
 * Analyse a decoded song (anything shaped like a Web Audio AudioBuffer),
 * pausing every couple of seconds of audio so a page stays responsive.
 */
export async function wavesFrom(buffer, { pause = () => new Promise((r) => setTimeout(r, 0)) } = {}) {
  const rate = buffer.sampleRate;
  const chans = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const a = startWaves(rate, buffer.length / rate);
  const slice = rate * 2, mono = new Float32Array(slice);
  for (let at = 0; at < buffer.length; at += slice) {
    const n = Math.min(slice, buffer.length - at);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (const ch of chans) s += ch[at + i];
      mono[i] = s / chans.length;
    }
    feedWaves(a, mono, n);
    await pause();
  }
  return finishWaves(a);
}

// ── reading one ────────────────────────────────────────────────────────────

/** Parse a waves file. Throws if it isn't one, or is a version we don't know. */
export function readWaves(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < HEADER || MAGIC.some((m, i) => bytes[i] !== m)) throw new Error("not a waves file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(4);
  if (version !== WAVES_VERSION) throw new Error(`waves version ${version} is not supported`);
  const N = view.getUint8(5), fps = view.getUint16(6, true), frames = view.getUint32(8, true);
  const data = HEADER + 8 * N;
  if (!N || !fps || bytes.length < data + frames * N) throw new Error("waves file is cut short");
  const bands = [], ceilings = [];
  for (let b = 0; b < N; b++) {
    bands.push([view.getUint16(HEADER + 4 * b, true), view.getUint16(HEADER + 4 * b + 2, true)]);
    ceilings.push(view.getFloat32(HEADER + 4 * N + 4 * b, true));
  }
  return { version, fps, frames, bands, ceilings, levels: bytes.subarray(data, data + frames * N) };
}

/** Band `b`'s level (0..1) at `seconds` into the song, between frames. */
export function waveAt(w, b, seconds) {
  const N = w.bands.length, f = seconds * w.fps - 0.5;   // values sit mid-frame
  const i = Math.floor(f);
  if (i < -1 || i >= w.frames) return 0;
  const at = (k) => (k < 0 || k >= w.frames ? 0 : w.levels[k * N + b] / 255);
  return at(i) + (at(i + 1) - at(i)) * (f - i);
}
