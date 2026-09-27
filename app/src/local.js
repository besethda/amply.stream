/**
 * Your own music, on this phone: songs imported from Files (iCloud Drive
 * included), played alongside the artists you follow.
 *
 * A home-screen web app can't keep a link to a file outside it, so importing
 * copies the song into the app's own storage (IndexedDB), with its cover,
 * details and waveform worked out here. Nothing is uploaded or shared: these
 * are the listener's own files, for their own listening. They're never paid
 * for, never counted, and never go in a shared playlist.
 */
import { readTags, trackNumber } from "./tags.js";
import { wavesFrom, WAVES_RATE } from "../../spec/waves.mjs";
import { colorsOf } from "../../spec/colors.mjs";

export const LOCAL = "local";                    // a local track's `from`
const DB = "amply-local", VERSION = 1;
const COVER_PX = 600;                            // covers kept at this size, as data URLs
const LONGEST_S = 30 * 60;

// ── the database ────────────────────────────────────────────────────────────

let opening = null;
function db() {
  opening ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore("tracks", { keyPath: "id" });   // details
      d.createObjectStore("audio");                       // id → the file itself
      d.createObjectStore("waves");                       // id → waves bytes
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return opening;
}
async function run(stores, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(stores, mode);
    const out = fn(...stores.map((s) => tx.objectStore(s)));
    tx.oncomplete = () => resolve(out?.result ?? out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Every local song's details. */
export const localSongs = () => run(["tracks"], "readonly", (t) => t.getAll());
/** A local song's audio, as a URL the player can play (revoke it when done). */
export async function audioUrl(id) {
  const blob = await run(["audio"], "readonly", (a) => a.get(id));
  if (!blob) throw new Error("That song isn't on this phone any more.");
  return URL.createObjectURL(blob);
}
/** A local song's waves bytes, as the visualizer fetches them. */
export async function wavesResponse(id) {
  const bytes = await run(["waves"], "readonly", (w) => w.get(id));
  return bytes ? { ok: true, arrayBuffer: async () => bytes } : { ok: false, status: 404 };
}
/**
 * Change a song's details (title, artist, album, track, art, colours). A new
 * cover is the album's cover: every song in the same album takes it too —
 * except loose singles, which only share the word "Singles".
 */
export async function editSong(id, patch) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(["tracks"], "readwrite"), store = tx.objectStore("tracks");
    const all = store.getAll();
    all.onsuccess = () => {
      const was = all.result.find((s) => s.id === id);
      if (!was) return;
      const next = { ...was, ...patch, id };
      if ("track" in patch) next.track = trackNumber(patch.track);
      store.put(next);
      if (next.art && next.art !== was.art && next.album) {
        for (const s of all.result) {
          if (s.id !== id && albumKey(s) === albumKey(next)) store.put({ ...s, art: next.art, colors: next.colors || null });
        }
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
/** Remove a song, its audio and its waves from this phone — and make sure. */
export async function removeSong(id) {
  await run(["tracks", "audio", "waves"], "readwrite", (t, a, w) => { t.delete(id); a.delete(id); w.delete(id); });
  const left = await run(["tracks", "audio", "waves"], "readonly", (t, a, w) => [t.count(id), a.count(id), w.count(id)]);
  if (left.some((r) => r.result > 0)) throw new Error("It couldn't be removed. Try again.");
}
/** How much room local music takes, and how much there is, in bytes. */
export async function usage() {
  const songs = await localSongs();
  const used = songs.reduce((s, x) => s + (x.size || 0), 0);
  const estimate = await navigator.storage?.estimate?.().catch(() => null);
  return { used, quota: estimate?.quota || null, count: songs.length };
}

// ── as tracks, beside everyone else's ───────────────────────────────────────

/** Which album a song is in: its artist and album name together. */
export const albumKey = (s) => `${LOCAL}:${s.artist || "Unknown artist"}\u0000${s.album || "Singles"}`;

/** A local song as a track the rest of the app understands. */
export function asTrack(s) {
  const artist = s.artist || "Unknown artist", album = s.album || "Singles";
  return {
    id: s.id, title: s.title || "Untitled", duration: s.duration || 0,
    url: `${LOCAL}:${s.id}`, waves: s.waves ? `${LOCAL}:${s.id}` : null,
    art: s.art || null, colors: s.colors || null,
    artistName: artist, releaseTitle: album, releaseId: albumKey(s),
    from: LOCAL, local: true, needsWallet: false, track: s.track || null, added: s.added,
    // Bought from an artist: whose song it is, to find the artist again.
    owned: !!s.owned, source: s.source || null,
  };
}
/** The kept copy of an artist's song, if it's on this phone: `${from}#${id}` → song. */
export const ownedIndex = (songs) => new Map(songs.filter((s) => s.owned && s.source).map((s) => [`${s.source.from}#${s.source.id}`, s]));
let owned = new Map();
/** For the badges: which artist songs have a kept copy here. Set by the app. */
export const setOwned = (songs) => { owned = ownedIndex(songs); };
export const ownedCopy = (from, id) => owned.get(`${from}#${id}`) || null;

/**
 * Keep a bought song: the file from the artist's server, with their details,
 * cover and waveform, as an owned local song. Its id is the artist's song, so
 * downloading it again replaces it rather than adding a second.
 */
export async function saveOwned(file, { from, id, title, artist, album, track, duration, art, colors, waves }) {
  try { await navigator.storage?.persist?.(); } catch { /* best effort */ }
  let look = { art: null, colors: colors || null };
  if (art) {
    try {
      const res = await fetch(art);
      if (res.ok) look = await cover(await res.blob());
      if (colors) look.colors = colors;       // the artist's own, taken from the full-size cover
    } catch { /* the song plays without it */ }
  }
  let wavesBytes = null;
  if (waves) {
    try { const res = await fetch(waves); if (res.ok) wavesBytes = await res.arrayBuffer(); } catch { /* none, then */ }
  }
  const key = `own:${from}#${id}`;
  const song = {
    id: key, title, artist, album, track: track || null, duration: Math.round(duration || 0),
    art: look.art, colors: look.colors, waves: !!wavesBytes, size: file.size, name: file.name,
    added: Date.now(), owned: true, source: { from, id },
  };
  await run(["tracks", "audio", "waves"], "readwrite", (t, a, w) => {
    t.put(song);
    a.put(file, key);
    if (wavesBytes) w.put(wavesBytes, key); else w.delete(key);
  });
  return song;
}

/** The files themselves, to save a copy elsewhere (Files, iCloud). */
export async function filesOf(ids) {
  const out = [];
  for (const id of ids) {
    const f = await run(["audio"], "readonly", (a) => a.get(id));
    if (f) out.push(f instanceof File ? f : new File([f], `${id}.mp3`, { type: f.type || "audio/mpeg" }));
  }
  return out;
}

/** Local songs grouped into albums, each in track order. */
export function albums(songs) {
  const by = new Map();
  for (const t of songs.map(asTrack)) {
    if (!by.has(t.releaseId)) by.set(t.releaseId, { id: t.releaseId, title: t.releaseTitle, artist: t.artistName, art: null, colors: null, single: !songs.find((s) => s.id === t.id).album, tracks: [] });
    const a = by.get(t.releaseId);
    a.tracks.push(t);
    if (!a.art && t.art) { a.art = t.art; a.colors = t.colors; }
  }
  for (const a of by.values()) {
    a.tracks.sort((x, y) => (x.track || 999) - (y.track || 999) || x.title.localeCompare(y.title));
    // A song without a cover shows its album's (never another single's).
    if (!a.single) for (const t of a.tracks) if (!t.art) { t.art = a.art; t.colors = a.colors; }
  }
  return [...by.values()].sort((x, y) => x.artist.localeCompare(y.artist) || x.title.localeCompare(y.title));
}

// ── importing ───────────────────────────────────────────────────────────────

/** A cover as a small JPEG data URL (images from blob: URLs aren't allowed here), and its colours. */
export async function cover(blob, px = COVER_PX) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, px / Math.max(bitmap.width, bitmap.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bitmap.width * scale); c.height = Math.round(bitmap.height * scale);
  const g = c.getContext("2d");
  g.drawImage(bitmap, 0, 0, c.width, c.height);
  const small = document.createElement("canvas");
  small.width = small.height = 48;
  const sg = small.getContext("2d", { willReadFrequently: true });
  sg.drawImage(bitmap, 0, 0, 48, 48);
  bitmap.close?.();
  return { art: c.toDataURL("image/jpeg", 0.85), colors: colorsOf(sg.getImageData(0, 0, 48, 48).data) };
}

async function decode(bytes) {
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  let ctx;
  for (const rate of [WAVES_RATE, 22050, 44100]) {
    try { ctx = new Offline(1, 1, rate); break; } catch { /* next */ }
  }
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(bytes, resolve, reject);
    p?.then?.(resolve, reject);
  });
}

/**
 * Import files: for each, read its tags, decode it (which also proves it
 * plays, and gives its length), work out its waveform and its cover's
 * colours, and keep the lot. `onEach` hears how each went.
 */
export async function importFiles(files, onEach = () => {}) {
  try { await navigator.storage?.persist?.(); } catch { /* best effort */ }
  const known = await localSongs().catch(() => []);
  const added = [];
  for (const file of Array.from(files)) {
    try {
      const bytes = await file.arrayBuffer();
      const tags = readTags(bytes, file.name);
      const buffer = await decode(bytes.slice(0)).catch(() => { throw new Error("This phone can't play that file."); });
      if (buffer.duration > LONGEST_S) throw new Error("It's longer than 30 minutes.");
      const waves = await wavesFrom(buffer).catch(() => null);
      let look = { art: null, colors: null };
      if (tags.picture) look = await cover(new Blob([tags.picture.data], { type: tags.picture.mime })).catch(() => look);
      // No cover of its own, but joining an album that has one: that one.
      const kin = !look.art && tags.album && known.find((s) => s.art && albumKey(s) === albumKey(tags));
      if (kin) look = { art: kin.art, colors: kin.colors };
      const id = crypto.randomUUID();
      const song = {
        id, title: tags.title, artist: tags.artist, album: tags.album, track: trackNumber(tags.track),
        duration: Math.round(buffer.duration), art: look.art, colors: look.colors,
        waves: !!waves, size: file.size, name: file.name, added: Date.now(),
      };
      await run(["tracks", "audio", "waves"], "readwrite", (t, a, w) => {
        t.put(song);
        a.put(file, id);
        if (waves) w.put(waves.buffer.slice(waves.byteOffset, waves.byteOffset + waves.byteLength), id);
      });
      added.push(song);
      known.push(song);
      onEach({ file, ok: true, song });
    } catch (e) {
      onEach({ file, ok: false, message: e.message || "That file couldn't be added." });
    }
  }
  return added;
}
