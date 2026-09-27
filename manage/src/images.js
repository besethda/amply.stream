/**
 * Pictures made the right size before they're uploaded.
 *
 * A photo straight off a phone is 2–4 MB and 4000 px across; listeners
 * download it every time it's shown, even as a thumbnail, and on mobile data
 * that's seconds per picture. The largest a cover is ever shown is about
 * 1200 px (the Now playing square on a sharp phone screen), so it's scaled to
 * that here, in the artist's browser: a few hundred KB instead of megabytes.
 */
export const COVER_PX = 1200;      // covers and artist photos: the longest side
export const BANNER_PX = 1800;     // a banner, wider than it's tall
const QUALITY = 0.85;
const SMALL_ENOUGH = 400 * 1024;   // already this small and this size: left alone

/**
 * The picture at most `longest` px on its longest side, as a File. Kept as it
 * is if it's already small, or if this browser can't read it (then the
 * original goes up). Transparent pictures stay PNG; the rest
 * become JPEG. Turned the right way up, as the phone meant it.
 */
export async function shrink(file, longest = COVER_PX) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return file;                                   // a format this browser can't open
  }
  const { width, height } = bitmap;
  const scale = Math.min(1, longest / Math.max(width, height));
  if (scale === 1 && file.size <= SMALL_ENOUGH) { bitmap.close?.(); return file; }

  const w = Math.round(width * scale), h = Math.round(height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext("2d");
  g.imageSmoothingQuality = "high";
  g.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const clear = file.type === "image/png" || file.type === "image/webp" || file.type === "image/gif"
    ? hasTransparency(g, w, h) : false;
  const type = clear ? "image/png" : "image/jpeg";
  let blob = await new Promise((resolve) => canvas.toBlob(resolve, type, QUALITY));
  if (!blob || blob.size >= file.size) return file;  // no smaller: keep the original
  // Redrawing drops everything stored inside the picture. The photographer's
  // credit and copyright go back in; where and with what it was taken don't.
  if (!clear) {
    const rights = readRights(new Uint8Array(await file.arrayBuffer()));
    if (rights) blob = new Blob([withRights(new Uint8Array(await blob.arrayBuffer()), rights)], { type });
  }
  const name = file.name.replace(/\.[^.]+$/, "") + (clear ? ".png" : ".jpg");
  return new File([blob], name, { type });
}

// ── the credit inside a JPEG ───────────────────────────────────────────────

const ARTIST = 0x013b, COPYRIGHT = 0x8298;

/** A JPEG's EXIF Artist and Copyright, if it has either; else null. */
export function readRights(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;          // not a JPEG
  let i = 2;
  while (i + 4 <= bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1], len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker === 0xda) break;                                     // the picture itself: no more headers
    const exif = marker === 0xe1 && String.fromCharCode(...bytes.subarray(i + 4, i + 10)) === "Exif\0\0";
    if (exif) {
      const t = bytes.subarray(i + 10, i + 2 + len);
      const view = new DataView(t.buffer, t.byteOffset, t.byteLength);
      const le = t[0] === 0x49, u16 = (o) => view.getUint16(o, le), u32 = (o) => view.getUint32(o, le);
      const ifd = u32(4), n = u16(ifd), out = {};
      for (let k = 0; k < n; k++) {
        const e = ifd + 2 + 12 * k, tag = u16(e);
        if ((tag !== ARTIST && tag !== COPYRIGHT) || u16(e + 2) !== 2) continue;   // ASCII only
        const count = u32(e + 4), at = count > 4 ? u32(e + 8) : e + 8;
        const text = new TextDecoder().decode(t.subarray(at, at + count)).replace(/\0+$/, "").trim();
        if (text) out[tag === ARTIST ? "artist" : "copyright"] = text;
      }
      return Object.keys(out).length ? out : null;
    }
    i += 2 + len;
  }
  return null;
}

/** The JPEG with an EXIF block holding only the given Artist and Copyright. */
export function withRights(jpeg, { artist, copyright }) {
  const entries = [[ARTIST, artist], [COPYRIGHT, copyright]].filter(([, v]) => v)
    .map(([tag, v]) => [tag, new TextEncoder().encode(v + "\0")]);
  // TIFF header (big-endian), one directory, then the strings after it.
  const dirSize = 2 + 12 * entries.length + 4;
  let dataAt = 8 + dirSize;
  const tiffLen = dataAt + entries.reduce((s, [, b]) => s + (b.length > 4 ? b.length : 0), 0);
  const tiff = new Uint8Array(tiffLen), v = new DataView(tiff.buffer);
  tiff.set([0x4d, 0x4d, 0, 42, 0, 0, 0, 8]);
  v.setUint16(8, entries.length);
  entries.forEach(([tag, b], k) => {
    const e = 10 + 12 * k;
    v.setUint16(e, tag); v.setUint16(e + 2, 2); v.setUint32(e + 4, b.length);
    if (b.length > 4) { v.setUint32(e + 8, dataAt); tiff.set(b, dataAt); dataAt += b.length; }
    else tiff.set(b, e + 8);
  });
  v.setUint32(10 + 12 * entries.length, 0);                          // no next directory
  const segLen = 2 + 6 + tiff.length;
  const seg = new Uint8Array(2 + segLen);
  seg.set([0xff, 0xe1, segLen >> 8, segLen & 0xff, 0x45, 0x78, 0x69, 0x66, 0, 0]);   // APP1 "Exif\0\0"
  seg.set(tiff, 10);
  const out = new Uint8Array(jpeg.length + seg.length);
  out.set(jpeg.subarray(0, 2)); out.set(seg, 2); out.set(jpeg.subarray(2), 2 + seg.length);
  return out;
}

function hasTransparency(g, w, h) {
  const d = g.getImageData(0, 0, w, h).data;
  for (let i = 3; i < d.length; i += 4 * 7) if (d[i] < 250) return true;   // every 7th pixel is plenty
  return false;
}
