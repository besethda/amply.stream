/**
 * Draw the Amply mark into PNG app icons.
 *
 * A home screen icon has to be a PNG, and the mark is an SVG. Rather than take
 * on an image library for three files that change about once a year, this
 * rasterises the mark's own geometry: the same rectangles and circles as
 * site/amply.svg, in a 24x24 space, supersampled for smooth edges and written
 * out with Node's own zlib.
 *
 * Orange on white rather than transparent, because a home screen icon sits on
 * whatever wallpaper someone has, and the margin leaves room for the circular
 * mask Android applies.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { deflateSync, crc32 } from "node:zlib";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

// From site/amply.svg, in its 24x24 viewBox: x, y, width, height, and which
// ends are rounded. The two stems are rounded only at the top; at the bottom
// they meet their note square, flush with its right edge.
const RECTS = [
  [7.93, 1.2, 1.01, 17.99, "top"], [10.44, 2.42, 1.01, 9.22], [12.59, 4.12, 1.08, 6.7],
  [15.71, 0.35, 0.89, 12.06], [17.82, 2.4, 1.13, 8.45], [20.94, 1.18, 1.03, 10.57],
  [22.96, 4.91, 1.03, 13.72, "top"],
];
const CIRCLES = [[4.47, 19.19, 4.47], [19.49, 18.63, 4.5]];

const ORANGE = [246, 113, 30];
const WHITE = [255, 255, 255];

/** Is this point inside the mark? Coordinates are in the 24x24 space. */
function inMark(x, y) {
  for (const [rx, ry, w, h, ends = "both"] of RECTS) {
    if (x < rx || x > rx + w || y < ry || y > ry + h) continue;
    // A bar's ends are half-circles, as wide as the bar.
    const r = w / 2, cx = rx + r;
    if (y < ry + r && (x - cx) ** 2 + (y - ry - r) ** 2 > r * r) continue;
    if (ends === "both" && y > ry + h - r && (x - cx) ** 2 + (y - (ry + h - r)) ** 2 > r * r) continue;
    return true;
  }
  for (const [cx, cy, r] of CIRCLES) {
    if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) return true;
  }
  return false;
}

function draw(size, margin = 0.14) {
  const px = Buffer.alloc(size * size * 3);
  const SS = 3;                                  // samples per axis
  const inset = size * margin;
  const span = size - inset * 2;

  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = ((pxi + (sx + 0.5) / SS) - inset) / span * 24;
          const fy = ((py + (sy + 0.5) / SS) - inset) / span * 24;
          if (fx >= 0 && fx <= 24 && fy >= 0 && fy <= 24 && inMark(fx, fy)) hits++;
        }
      }
      const a = hits / (SS * SS);
      const o = (py * size + pxi) * 3;
      for (let c = 0; c < 3; c++) px[o + c] = Math.round(WHITE[c] * (1 - a) + ORANGE[c] * a);
    }
  }
  return px;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function png(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;        // bit depth
  ihdr[9] = 2;        // truecolour
  // Each row is prefixed with its filter type; 0 means none.
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    pixels.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [180, 192, 512]) {
  const file = here(`../site/app/icon-${size}.png`);
  const bytes = png(size, draw(size));
  await writeFile(file, bytes);
  console.log(`site/app/icon-${size}.png  ${(bytes.length / 1024).toFixed(1)} kB`);
}
