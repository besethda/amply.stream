/**
 * Reading a music file's own tags: MP3, M4A and FLAC, and the file's name
 * when there's nothing better.
 *
 * Run via `npm --prefix app run test`.
 */
const { readTags, fromName } = await import("./src/tags.js");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};
const enc = (s) => [...new TextEncoder().encode(s)];
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const PIC = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9];      // stands in for a JPEG

// ── MP3: ID3v2.3, one frame of each, text in UTF-8 and UTF-16 ──────────────
const frame = (id, body) => [...enc(id), ...be32(body.length), 0, 0, ...body];
const utf16 = (s) => { const out = [0xff, 0xfe]; for (const ch of s) { const c = ch.charCodeAt(0); out.push(c & 255, c >> 8); } return out; };
const frames = [
  ...frame("TIT2", [3, ...enc("Night Drive")]),
  ...frame("TPE1", [1, ...utf16("Blåsjø")]),
  ...frame("TALB", [0, ...enc("Coastline")]),
  ...frame("TRCK", [0, ...enc("3/10")]),
  ...frame("APIC", [0, ...enc("image/jpeg"), 0, 3, ...enc("cover"), 0, ...PIC]),
];
const size = frames.length;
const syncsafe = [(size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127];
const mp3 = new Uint8Array([...enc("ID3"), 3, 0, 0, ...syncsafe, ...frames, 0xff, 0xfb, 0x90, 0x00]);
const a = readTags(mp3.buffer, "whatever.mp3");
ok("MP3: title, artist (UTF-16), album, track", a.title === "Night Drive" && a.artist === "Blåsjø" && a.album === "Coastline" && a.track === 3, JSON.stringify({ ...a, picture: !!a.picture }));
ok("  and its cover", a.picture?.mime === "image/jpeg" && a.picture.data.length === PIC.length && a.picture.data[0] === 0xff);

// ── M4A: moov > udta > meta > ilst ──────────────────────────────────────────
const atom = (type, body) => [...be32(8 + body.length), ...[...type].map((c) => c.charCodeAt(0)), ...body];
const data = (kind, payload) => atom("data", [...be32(kind), 0, 0, 0, 0, ...payload]);
const ilst = atom("ilst", [
  ...atom("©nam", data(1, enc("Tideline"))),
  ...atom("©ART", data(1, enc("Hollow Coast"))),
  ...atom("©alb", data(1, enc("Longwave"))),
  ...atom("trkn", data(0, [0, 0, 0, 7, 0, 12, 0, 0])),
  ...atom("covr", data(14, PIC)),
]);
const m4a = new Uint8Array([
  ...atom("ftyp", enc("M4A \0\0\0\0")),
  ...atom("moov", atom("udta", atom("meta", [0, 0, 0, 0, ...atom("hdlr", new Array(25).fill(0)), ...ilst]))),
]);
const b = readTags(m4a.buffer, "x.m4a");
ok("M4A: title, artist, album, track", b.title === "Tideline" && b.artist === "Hollow Coast" && b.album === "Longwave" && b.track === 7, JSON.stringify({ ...b, picture: !!b.picture }));
ok("  and its cover (PNG)", b.picture?.mime === "image/png" && b.picture.data.length === PIC.length);

// ── FLAC: Vorbis comments and a PICTURE block ───────────────────────────────
const comments = ["TITLE=North Sea Static", "ARTIST=Hollow Coast", "ALBUM=Longwave", "TRACKNUMBER=2"];
const vorbis = [...le32(3), ...enc("amp"), ...le32(comments.length), ...comments.flatMap((c) => [...le32(enc(c).length), ...enc(c)])];
const picture = [...be32(3), ...be32(10), ...enc("image/jpeg"), ...be32(0), ...new Array(16).fill(0), ...be32(PIC.length), ...PIC];
const block = (type, body, last) => [(last ? 0x80 : 0) | type, (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255, ...body];
const flacBytes = new Uint8Array([...enc("fLaC"), ...block(0, new Array(34).fill(0)), ...block(4, vorbis), ...block(6, picture, true)]);
const c = readTags(flacBytes.buffer, "x.flac");
ok("FLAC: title, artist, album, track", c.title === "North Sea Static" && c.artist === "Hollow Coast" && c.album === "Longwave" && c.track === 2, JSON.stringify({ ...c, picture: !!c.picture }));
ok("  and its cover", c.picture?.mime === "image/jpeg" && c.picture.data.length === PIC.length);

// ── No tags: the file's name ────────────────────────────────────────────────
const wav = readTags(new Uint8Array([...enc("RIFF"), 0, 0, 0, 0, ...enc("WAVE")]).buffer, "04 - Hollow Coast - Signal Fade.wav");
ok("no tags: track, artist and title from the name", wav.track === 4 && wav.artist === "Hollow Coast" && wav.title === "Signal Fade" && wav.album === "", JSON.stringify(wav));
ok("  just a title in the name", fromName("Signal Fade.mp3").title === "Signal Fade" && fromName("Signal Fade.mp3").artist === "");
ok("  underscores are spaces", fromName("my_song.mp3").title === "my song");

// ── Damaged or hostile tags: no crash, just the name ────────────────────────
const broken = new Uint8Array([...enc("ID3"), 4, 0, 0, 0x7f, 0x7f, 0x7f, 0x7f, ...enc("TIT2"), 0xff, 0xff, 0xff, 0xff, 0, 0]);
const d = readTags(broken.buffer, "Fallback.mp3");
ok("a damaged tag falls back to the name, without throwing", d.title === "Fallback", JSON.stringify(d));
const huge = new Uint8Array([...atom("ftyp", enc("M4A ")), ...be32(0xffffff00), ...enc("moov")]);
ok("an atom claiming to be enormous is ignored", readTags(huge.buffer, "Big.m4a").title === "Big");

// ── Track numbers, however they're written ──────────────────────────────────
const { trackNumber } = await import("./src/tags.js");
ok("track numbers: 3, 03, 3/10 and spaces", trackNumber("3") === 3 && trackNumber("03") === 3 && trackNumber("3/10") === 3 && trackNumber(" 7 ") === 7);
ok("  nothing sensible is no number", [0, "0", "", null, undefined, "abc", "-2", "1000", "12345", "1.5e3"].every((x) => trackNumber(x) === null || (x === "1.5e3" && trackNumber(x) === 1)));

// ── Local albums share a cover, singles don't ───────────────────────────────
const { albums, albumKey } = await import("./src/local.js");
const songs = [
  { id: "a", title: "One", artist: "Hollow Coast", album: "Longwave", track: 2, art: "data:image/jpeg;base64,AAA", colors: { accent: "#123456" } },
  { id: "b", title: "Two", artist: "Hollow Coast", album: "Longwave", track: 1 },
  { id: "c", title: "Loose", artist: "Hollow Coast", album: "", art: "data:image/jpeg;base64,BBB" },
  { id: "d", title: "Other loose", artist: "Hollow Coast", album: "" },
];
const got = albums(songs);
const long = got.find((a) => a.title === "Longwave"), singles = got.find((a) => a.single);
ok("a song without a cover shows its album's", long.tracks.find((t) => t.id === "b").art === songs[0].art && long.tracks[0].id === "b");
ok("  but one single's cover isn't another's", singles.tracks.find((t) => t.id === "d").art === null);
ok("the album key is artist and album together", albumKey(songs[0]) === long.id && albumKey({ artist: "X", album: "Longwave" }) !== long.id);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
