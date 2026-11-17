/**
 * Loudness: how loud a song sounds, and how to bring it to the same level as
 * everyone else's.
 *
 * Measured as integrated loudness in LUFS (ITU-R BS.1770-4), the measure the
 * streaming services use: K-weighted (roughly how loud the ear hears each
 * frequency), in 400 ms blocks, with quiet passages gated out so a long
 * silence doesn't make a song read as quiet.
 *
 * Used where the song is uploaded, in the artist's editor: a song that's far
 * from the common level gets a streaming copy with the difference applied,
 * turned up through a look-ahead limiter so it never clips. Doing it there
 * rather than in the player is what makes it work on iPhone, where a web page
 * can't change a song's volume while it plays.
 *
 * Pure functions on arrays of samples, so they can be tested without a browser.
 */

/** The level every song is brought to, in LUFS; the same as Spotify's. */
export const TARGET_LUFS = -14;
/** The most a song is turned up, in dB; past that the limiter would squash it. */
export const MAX_GAIN_DB = 10;
/** The most a song is turned down. Turning down can't distort, so more room. */
export const MAX_CUT_DB = 20;
/** Smaller differences than this aren't worth re-encoding a song for. */
export const MIN_CHANGE_DB = 1;
/** Where the limiter holds peaks: a little under full scale, for encoders. */
export const CEILING_DB = -1;

// ── measuring ───────────────────────────────────────────────────────────────

/** BS.1770's two K-weighting filters, worked out for any sample rate. */
function kFilters(rate) {
  // Stage 1: a high shelf, about +4 dB above 1.5 kHz (the head's effect).
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / rate);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = {
    b0: (Vh + Vb * K / Q + K * K) / a0, b1: 2 * (K * K - Vh) / a0, b2: (Vh - Vb * K / Q + K * K) / a0,
    a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0,
  };
  // Stage 2: a high pass at about 38 Hz.
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan(Math.PI * f0 / rate);
  a0 = 1 + K / Q + K * K;
  const high = { b0: 1, b1: -2, b2: 1, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, high];
}

function filter(x, { b0, b1, b2, a1, a2 }) {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/**
 * Integrated loudness of a song, in LUFS, from its channels (one array of
 * samples each, -1..1). Silence reads as -Infinity.
 */
export function integratedLoudness(channels, rate) {
  const [shelf, high] = kFilters(rate);
  const weighted = channels.map((c) => filter(filter(c, shelf), high));
  const block = Math.round(0.4 * rate), step = Math.round(0.1 * rate);
  const n = channels[0]?.length || 0;
  const blocks = [];
  for (let start = 0; start + block <= n; start += step) {
    let sum = 0;
    for (const w of weighted) {
      let ms = 0;
      for (let i = start; i < start + block; i++) ms += w[i] * w[i];
      sum += ms / block;   // left and right weigh 1 each
    }
    blocks.push(sum);
  }
  const lufs = (z) => -0.691 + 10 * Math.log10(z);
  const loud = blocks.filter((z) => lufs(z) > -70);
  if (!loud.length) return -Infinity;
  const mean = (a) => a.reduce((s, z) => s + z, 0) / a.length;
  const relative = lufs(mean(loud)) - 10;
  const kept = loud.filter((z) => lufs(z) > relative);
  return lufs(mean(kept));
}

/** The loudest sample, in dBFS. */
export function peakDb(channels) {
  let p = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) { const v = Math.abs(c[i]); if (v > p) p = v; }
  return p > 0 ? 20 * Math.log10(p) : -Infinity;
}

/** How much to turn a song up (+) or down (-), in dB, to reach the target. */
export function gainFor(lufs) {
  if (!Number.isFinite(lufs)) return 0;
  return Math.max(-MAX_CUT_DB, Math.min(MAX_GAIN_DB, TARGET_LUFS - lufs));
}

// ── correcting ──────────────────────────────────────────────────────────────

/**
 * The channels with `gainDb` applied, peaks held at `ceilingDb` by a look-ahead
 * limiter: the gain eases down just before a peak and back up after it, so
 * nothing clips and nothing clicks. Turning a song down never needs it.
 */
export function applyGain(channels, rate, gainDb, { ceilingDb = CEILING_DB } = {}) {
  const g = Math.pow(10, gainDb / 20);
  const ceiling = Math.pow(10, ceilingDb / 20);
  const n = channels[0]?.length || 0;
  const out = channels.map(() => new Float32Array(n));

  // What each sample needs: 1 if it fits under the ceiling, less if it doesn't.
  const need = new Float32Array(n);
  let anyOver = false;
  for (let i = 0; i < n; i++) {
    let p = 0;
    for (const c of channels) { const v = Math.abs(c[i]) * g; if (v > p) p = v; }
    need[i] = p > ceiling ? ceiling / p : 1;
    if (need[i] < 1) anyOver = true;
  }
  if (!anyOver) {
    channels.forEach((c, k) => { for (let i = 0; i < n; i++) out[k][i] = c[i] * g; });
    return out;
  }

  // Look ahead: each sample takes the least that any sample in the next W
  // needs, then that is averaged over the same W. At a peak, every sample in
  // the average already allows for it, so the result never overshoots.
  const W = Math.max(1, Math.round(0.02 * rate));
  const ahead = new Float32Array(n);
  const q = new Int32Array(n);   // a monotonic queue of indices, for the running minimum
  let head = 0, tail = 0;
  for (let i = n - 1; i >= 0; i--) {
    while (tail > head && need[q[tail - 1]] >= need[i]) tail--;
    q[tail++] = i;
    while (q[head] > i + W) head++;
    ahead[i] = need[q[head]];
  }
  let sum = 0;
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    sum += ahead[i];
    if (i >= W) sum -= ahead[i - W];
    env[i] = Math.min(ahead[i], sum / Math.min(i + 1, W));
  }
  channels.forEach((c, k) => {
    const o = out[k];
    for (let i = 0; i < n; i++) {
      const v = c[i] * g * env[i];
      o[i] = v > ceiling ? ceiling : v < -ceiling ? -ceiling : v;
    }
  });
  return out;
}

/**
 * Bring a song to the target level. The limiter can take a little away where
 * it holds peaks, so the result is measured and corrected again, at most
 * twice, never past the caps.
 */
export function normalize(channels, rate) {
  const before = integratedLoudness(channels, rate);
  let gainDb = gainFor(before);
  let out = applyGain(channels, rate, gainDb);
  let after = integratedLoudness(out, rate);
  for (let pass = 0; pass < 2 && Number.isFinite(after); pass++) {
    const short = TARGET_LUFS - after;
    const next = Math.max(-MAX_CUT_DB, Math.min(MAX_GAIN_DB, gainDb + short));
    if (Math.abs(short) < 0.3 || Math.abs(next - gainDb) < 0.1) break;
    gainDb = next;
    out = applyGain(channels, rate, gainDb);
    after = integratedLoudness(out, rate);
  }
  return { out, before, after, gainDb };
}

/**
 * Whether a song should get a streaming copy: it's well off the common level,
 * too heavy to stream smoothly, or in a format phones may not play.
 */
export function needsStreamCopy({ gainDb, kbps, ext }) {
  if (Math.abs(gainDb) >= MIN_CHANGE_DB) return true;
  if (kbps > 400) return true;
  return /^(wav|wave|aif|aiff|flac|ogg|oga|opus)$/i.test(ext || "");
}
