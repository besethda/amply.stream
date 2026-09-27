/**
 * A cover's colours (spec/colors.mjs), read in the artist's browser from the
 * picture they picked. A shrunken copy is plenty for colour, and quick.
 */
import { colorsOf } from "../../spec/colors.mjs";

const SIZE = 48;

/** The picture's pixels at SIZE×SIZE, as RGBA. */
async function pixels(file) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  try {
    // Straight from the file: no URL to load, so nothing for the page's
    // security policy (which allows no blob: images) to refuse.
    const bitmap = await createImageBitmap(file, { resizeWidth: SIZE, resizeHeight: SIZE, resizeQuality: "medium" });
    g.drawImage(bitmap, 0, 0, SIZE, SIZE);
    bitmap.close?.();
  } catch {
    // Some formats (SVG) and older browsers: through a data: URL instead.
    const url = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result); r.onerror = reject;
      r.readAsDataURL(file);
    });
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
    g.drawImage(img, 0, 0, SIZE, SIZE);
  }
  return g.getImageData(0, 0, SIZE, SIZE).data;
}

/** `{ accent?, deep }` for an image File, or null if it can't be read. */
export async function coverColors(file) {
  try { return colorsOf(await pixels(file)); } catch { return null; }
}
