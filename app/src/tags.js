/**
 * What a music file says about itself: title, artist, album, track number and
 * its cover, read from the tags inside it. MP3 (ID3v2.3 and 2.4), M4A/AAC
 * (iTunes-style atoms) and FLAC (Vorbis comments and PICTURE blocks); anything
 * else, or anything missing, falls back to what the file's name suggests.
 *
 * Only ever reads: tags are untrusted bytes, so every length is checked
 * against what's there, and nothing found is required.
 */

/** Everything worth knowing, from a file's bytes and its name. */
export function readTags(buffer, filename = "") {
  const bytes = new Uint8Array(buffer);
  let found = {};
  try {
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) found = id3(bytes);            // "ID3"
    else if (ascii(bytes, 0, 4) === "fLaC") found = flac(bytes);
    else if (ascii(bytes, 4, 4) === "ftyp") found = mp4(bytes);
  } catch { found = {}; }
  const guess = fromName(filename);
  return {
    title: clean(found.title) || guess.title,
    artist: clean(found.artist) || clean(found.albumArtist) || guess.artist || "",
    album: clean(found.album) || "",
    track: found.track || guess.track || null,
    picture: found.picture && found.picture.data?.length ? found.picture : null,
  };
}

/** "01 - Artist - Title.mp3", "Artist - Title.m4a", "03 Title.flac", "Title.wav". */
export function fromName(filename) {
  let base = String(filename).replace(/\.[^.]+$/, "").replace(/_/g, " ").trim();
  let track = null;
  const num = base.match(/^(\d{1,3})[\s.\-_]+(.+)$/);
  if (num) { track = Number(num[1]); base = num[2].trim(); }
  const parts = base.split(/\s+-\s+/);
  if (parts.length >= 2) return { track, artist: parts[0].trim(), title: parts.slice(1).join(" - ").trim() };
  return { track, artist: "", title: base || "Untitled" };
}

const clean = (s) => (typeof s === "string" ? s.replace(/\0/g, "").trim() : "");
const ascii = (b, at, n) => String.fromCharCode(...b.subarray(at, at + n));
const u32 = (b, at) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const u32le = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
/** A track number from whatever was written ("3", "03", "3/10", " 7 "): 1 to 999, or none. */
export function trackNumber(s) {
  const m = String(s ?? "").trim().match(/^0*(\d{1,3})(?!\d)/);
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= 999 ? n : null;
}

// ── ID3v2 ───────────────────────────────────────────────────────────────────

function text(b, enc) {
  if (!b.length) return "";
  if (enc === 0) return String.fromCharCode(...b);                              // Latin-1
  if (enc === 3) return new TextDecoder("utf-8").decode(b);
  if (enc === 1) {                                                              // UTF-16 with BOM
    const le = b[0] === 0xff && b[1] === 0xfe;
    return new TextDecoder(le ? "utf-16le" : "utf-16be").decode(b.subarray(b[0] === 0xff || b[0] === 0xfe ? 2 : 0));
  }
  return new TextDecoder("utf-16be").decode(b);                                 // 2: UTF-16BE
}
/** Where a terminator ends, for this encoding (one zero, or two on an even boundary). */
function terminator(b, from, enc) {
  if (enc === 1 || enc === 2) {
    for (let i = from; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i;
    return b.length;
  }
  const i = b.indexOf(0, from);
  return i < 0 ? b.length : i;
}

function id3(b) {
  const version = b[3], flags = b[5];
  const size = (b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9];
  const end = Math.min(b.length, 10 + size);
  let at = 10;
  if (flags & 0x40) at += version === 4 ? ((b[10] << 21) | (b[11] << 14) | (b[12] << 7) | b[13]) : u32(b, 10) + 4;   // extended header
  const out = {};
  while (at + 10 <= end) {
    const id = ascii(b, at, 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;                                       // padding
    const len = version === 4 ? ((b[at + 4] << 21) | (b[at + 5] << 14) | (b[at + 6] << 7) | b[at + 7]) : u32(b, at + 4);
    const body = b.subarray(at + 10, Math.min(end, at + 10 + len));
    at += 10 + len;
    if (!body.length) continue;
    const enc = body[0];
    if (id === "TIT2") out.title = text(body.subarray(1), enc);
    else if (id === "TPE1") out.artist = text(body.subarray(1), enc);
    else if (id === "TPE2") out.albumArtist = text(body.subarray(1), enc);
    else if (id === "TALB") out.album = text(body.subarray(1), enc);
    else if (id === "TRCK") out.track = trackNumber(text(body.subarray(1), enc));
    else if (id === "APIC" && !out.picture) {
      const mimeEnd = body.indexOf(0, 1);
      if (mimeEnd < 0) continue;
      const mime = String.fromCharCode(...body.subarray(1, mimeEnd)) || "image/jpeg";
      const descEnd = terminator(body, mimeEnd + 2, enc);                     // after the picture-type byte
      const start = descEnd + (enc === 1 || enc === 2 ? 2 : 1);
      if (start < body.length) out.picture = { mime: mime.includes("/") ? mime : `image/${mime.toLowerCase()}`, data: body.slice(start) };
    }
  }
  return out;
}

// ── FLAC ────────────────────────────────────────────────────────────────────

function flac(b) {
  const out = {};
  let at = 4;
  for (let last = false; !last && at + 4 <= b.length;) {
    last = !!(b[at] & 0x80);
    const type = b[at] & 0x7f, len = (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3];
    const body = b.subarray(at + 4, Math.min(b.length, at + 4 + len));
    at += 4 + len;
    if (type === 4) {                                                            // Vorbis comments, little-endian
      let p = 4 + u32le(body, 0);
      const count = u32le(body, p); p += 4;
      for (let i = 0; i < count && p + 4 <= body.length; i++) {
        const n = u32le(body, p); p += 4;
        const [key, ...rest] = new TextDecoder().decode(body.subarray(p, p + n)).split("="); p += n;
        const value = rest.join("="), k = key.toUpperCase();
        if (k === "TITLE") out.title = value;
        else if (k === "ARTIST") out.artist = value;
        else if (k === "ALBUMARTIST") out.albumArtist = value;
        else if (k === "ALBUM") out.album = value;
        else if (k === "TRACKNUMBER") out.track = trackNumber(value);
      }
    } else if (type === 6 && !out.picture) {                                    // PICTURE, big-endian
      let p = 4;
      const mimeLen = u32(body, p); p += 4;
      const mime = ascii(body, p, mimeLen); p += mimeLen;
      const descLen = u32(body, p); p += 4 + descLen + 16;
      const dataLen = u32(body, p); p += 4;
      if (p + dataLen <= body.length) out.picture = { mime: mime || "image/jpeg", data: body.slice(p, p + dataLen) };
    }
  }
  return out;
}

// ── MP4 / M4A ───────────────────────────────────────────────────────────────

/** The child atoms of the region [from, to). */
function atoms(b, from, to) {
  const list = [];
  for (let at = from; at + 8 <= to;) {
    let size = u32(b, at);
    const type = ascii(b, at + 4, 4);
    let head = 8;
    if (size === 1) { size = u32(b, at + 12); head = 16; }                     // 64-bit size (high word ignored)
    if (size === 0) size = to - at;
    if (size < head || at + size > to) break;
    list.push({ type, start: at + head, end: at + size });
    at += size;
  }
  return list;
}
const child = (b, parent, type, skip = 0) => atoms(b, parent.start + skip, parent.end).find((a) => a.type === type);

function mp4(b) {
  const out = {};
  const moov = atoms(b, 0, b.length).find((a) => a.type === "moov");
  const udta = moov && child(b, moov, "udta");
  const meta = udta && child(b, udta, "meta");
  const ilst = meta && child(b, meta, "ilst", 4);                               // meta is a full box: 4 bytes of version/flags
  if (!ilst) return out;
  for (const item of atoms(b, ilst.start, ilst.end)) {
    const data = child(b, item, "data");
    if (!data) continue;
    const payload = b.subarray(data.start + 8, data.end);                       // after type and locale
    const str = () => new TextDecoder().decode(payload);
    switch (item.type) {
      case "©nam": out.title = str(); break;
      case "©ART": out.artist = str(); break;
      case "aART": out.albumArtist = str(); break;
      case "©alb": out.album = str(); break;
      case "trkn": if (payload.length >= 4) out.track = ((payload[2] << 8) | payload[3]) || null; break;
      case "covr": {
        const kind = u32(b, data.start) & 0xffffff;                             // 13 JPEG, 14 PNG
        out.picture = { mime: kind === 14 ? "image/png" : "image/jpeg", data: payload.slice() };
        break;
      }
      default:
    }
  }
  return out;
}
