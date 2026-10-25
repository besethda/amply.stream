/**
 * The proof-of-work Cloudflare asks for before it makes a temporary account.
 *
 * SHA-256 the 32-byte seed, then chain `k` checkpoints of `g` hashes each,
 * every hash taken of the one before. The answer is all k + 1 checkpoints,
 * concatenated and Base64-encoded. That is how Wrangler solves it, and what
 * Cloudflare checks.
 *
 * Written out rather than done with WebCrypto, which is asynchronous per
 * hash: a challenge is a few million hashes, and a promise for each one turns
 * a second of work into a minute. Every input here is exactly 32 bytes, so a
 * hash is a single compression of one fixed-shape block, which keeps this
 * small and fast. Tested against Node's own SHA-256 in scripts/test-pow.mjs.
 *
 * Runs in slices, yielding between them, so the page keeps answering while
 * it works.
 */

/** Wrangler refuses anything harder than this, and so does setup. */
export const POW_MAX_ITERATIONS = 64_000_000;

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

const W = new Uint32Array(64);

/**
 * Replace the 8 words in `h` with the SHA-256 of those 32 bytes.
 *
 * The block is always the same shape: 32 bytes of message, the 0x80 marker,
 * zeros, and a length of 256 bits.
 */
function hash32(h) {
  W.set(h, 0);
  W[8] = 0x80000000;
  W[9] = W[10] = W[11] = W[12] = W[13] = W[14] = 0;
  W[15] = 256;
  for (let i = 16; i < 64; i++) {
    const x = W[i - 15], y = W[i - 2];
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
  }
  let a = IV[0], b = IV[1], c = IV[2], d = IV[3], e = IV[4], f = IV[5], g = IV[6], k = IV[7];
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (k + S1 + ch + K[i] + W[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) | 0;
    k = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  h[0] = (IV[0] + a) | 0; h[1] = (IV[1] + b) | 0; h[2] = (IV[2] + c) | 0; h[3] = (IV[3] + d) | 0;
  h[4] = (IV[4] + e) | 0; h[5] = (IV[5] + f) | 0; h[6] = (IV[6] + g) | 0; h[7] = (IV[7] + k) | 0;
}

/** SHA-256 of an arbitrary, short message: only used once, for the seed. */
function sha256Bytes(bytes) {
  const bitLen = bytes.length * 8;
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  new DataView(padded.buffer).setUint32(padded.length - 4, bitLen);
  const h = Uint32Array.from(IV);
  const view = new DataView(padded.buffer);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = W[i - 15], y = W[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], k = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (k + S1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      k = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += k;
  }
  return h;
}

const toBytes = (h) => {
  const out = new Uint8Array(32);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) view.setUint32(i * 4, h[i]);
  return out;
};

function fromBase64url(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Whether a challenge is one this code will attempt, by Wrangler's rules. */
export function supported({ seed, k, g } = {}) {
  try {
    return Number.isInteger(k) && Number.isInteger(g) && k > 0 && g > 0
      && k * g <= POW_MAX_ITERATIONS && fromBase64url(String(seed)).length === 32;
  } catch {
    return false;
  }
}

/**
 * Solve a challenge. `onProgress(fraction)` is called between slices.
 * Resolves to the Base64 checkpoints Cloudflare expects.
 */
export async function solve({ seed, k, g }, { onProgress = () => {}, sliceMs = 40 } = {}) {
  if (!supported({ seed, k, g })) throw new Error("unsupported proof-of-work challenge");
  const h = sha256Bytes(fromBase64url(seed));
  const out = new Uint8Array((k + 1) * 32);
  out.set(toBytes(h), 0);
  let j = 0, i = 0;
  while (j < k) {
    const until = Date.now() + sliceMs;
    // At least one batch per slice, however short the slice, or a slow clock
    // would yield forever without doing any work.
    do {
      // Check the clock every few thousand hashes, not every one.
      const stop = Math.min(g, i + 4096);
      for (; i < stop; i++) hash32(h);
      if (i === g) {
        j++;
        i = 0;
        out.set(toBytes(h), j * 32);
      }
    } while (j < k && Date.now() < until);
    onProgress(j / k);
    if (j < k) await new Promise((r) => setTimeout(r, 0));
  }
  return toBase64(out);
}
