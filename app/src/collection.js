/**
 * What the listener keeps: liked songs and playlists. On this device only,
 * like everything else — no account, no server.
 *
 * A song is referred to by where it lives: its artist's manifest address and
 * its id there ({ from, id }). Nothing about the audio is copied; a playlist
 * is a list of pointers into artists' own streaming services.
 */
const LIKES = "amply.likes.v1";
const PLAYLISTS = "amply.playlists.v1";
const MAX_PLAYLIST = 500;

const read = (key, fallback) => {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
};
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };

export const ref = (t) => ({ from: t.from, id: t.id });
const same = (a, b) => a.from === b.from && a.id === b.id;

// ── likes ───────────────────────────────────────────────────────────────────

export const likes = () => read(LIKES, []);
export const isLiked = (t, all = likes()) => all.some((r) => same(r, t));
/** Like or unlike; newest first. Returns the new list. */
export function toggleLike(t) {
  const all = likes();
  const next = isLiked(t, all) ? all.filter((r) => !same(r, t)) : [ref(t), ...all];
  write(LIKES, next);
  return next;
}

/** Like (or unlike) several songs at once, as a whole album. Newest first. */
export function setLiked(tracks, on) {
  const rest = likes().filter((r) => !tracks.some((t) => same(r, t)));
  write(LIKES, on ? [...tracks.map(ref), ...rest] : rest);
}

/** A song gone for good (a local one, deleted): out of likes and every playlist. */
export function forgetSong(t) {
  write(LIKES, likes().filter((r) => !same(r, t)));
  save(playlists().map((p) => (p.tracks.some((r) => same(r, t)) ? { ...p, tracks: p.tracks.filter((r) => !same(r, t)) } : p)));
}

// ── playlists ───────────────────────────────────────────────────────────────

export const playlists = () => read(PLAYLISTS, []);
const save = (all) => { write(PLAYLISTS, all); return all; };
const edit = (id, fn) => save(playlists().map((p) => (p.id === id ? fn(p) : p)));
const newId = () => `pl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function createPlaylist(name, tracks = []) {
  const p = { id: newId(), name: String(name || "New playlist").slice(0, 80), tracks: tracks.slice(0, MAX_PLAYLIST).map(ref), created: Date.now() };
  save([p, ...playlists()]);
  return p;
}
export const renamePlaylist = (id, name) => edit(id, (p) => ({ ...p, name: String(name || p.name).slice(0, 80) }));
export const deletePlaylist = (id) => save(playlists().filter((p) => p.id !== id));
export const addToPlaylist = (id, t) => edit(id, (p) => (p.tracks.length >= MAX_PLAYLIST ? p : { ...p, tracks: [...p.tracks, ref(t)] }));
export const removeFromPlaylist = (id, i) => edit(id, (p) => ({ ...p, tracks: p.tracks.filter((_, j) => j !== i) }));
/** A playlist's own picture (a small JPEG, as a data URL), or none. False if
 *  it couldn't be kept — this storage is small. */
export function setPlaylistArt(id, art) {
  const next = playlists().map((p) => {
    if (p.id !== id) return p;
    const { art: _old, ...rest } = p;
    return art ? { ...rest, art } : rest;
  });
  return write(PLAYLISTS, next);
}

/** A playlist's song dragged from one place to another. */
export const movePlaylistTrack = (id, from, to) => edit(id, (p) => {
  if (from === to || from < 0 || to < 0 || from >= p.tracks.length || to >= p.tracks.length) return p;
  const tracks = [...p.tracks];
  const [x] = tracks.splice(from, 1);
  tracks.splice(to, 0, x);
  return { ...p, tracks };
});

/** Does anything the listener keeps point at this artist? Then unfollowing
 *  keeps them known, so those songs still play and their artist is still paid. */
export const referenced = (url) =>
  likes().some((r) => r.from === url) || playlists().some((p) => p.tracks.some((r) => r.from === url));

// ── sharing ─────────────────────────────────────────────────────────────────

/*
 * A shared playlist is a link: /app/?playlist=<code>. The code is the name and
 * the list of pointers, with each artist's address written once. Nothing is
 * uploaded anywhere; whoever opens the link fetches each artist's page from
 * that artist, and pays them as usual.
 */
const MAX_SHARED_ARTISTS = 40;

const b64url = (text) => btoa(unescape(encodeURIComponent(text))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (code) => decodeURIComponent(escape(atob(code.replace(/-/g, "+").replace(/_/g, "/"))));

export function shareCode(name, tracks) {
  const artists = [];
  const t = tracks.slice(0, MAX_PLAYLIST).map((r) => {
    let i = artists.indexOf(r.from);
    if (i < 0) { i = artists.length; artists.push(r.from); }
    return [i, r.id];
  });
  return b64url(JSON.stringify({ v: 1, n: String(name || "Playlist").slice(0, 80), a: artists, t }));
}
export const shareLink = (name, tracks, base = "https://amply.stream/app/") =>
  `${base}?playlist=${shareCode(name, tracks)}`;

/** Read a shared code, refusing anything that isn't the shape we write. */
export function readShare(code) {
  try {
    const d = JSON.parse(unb64url(String(code)));
    if (!d || d.v !== 1 || !Array.isArray(d.a) || !Array.isArray(d.t)) return null;
    if (d.a.length > MAX_SHARED_ARTISTS || d.t.length > MAX_PLAYLIST) return null;
    const artists = d.a.map(String);
    if (!artists.every((u) => /^https:\/\/[^\s]+$/.test(u))) return null;
    const tracks = d.t
      .filter((x) => Array.isArray(x) && Number.isInteger(x[0]) && x[0] >= 0 && x[0] < artists.length && typeof x[1] === "string")
      .map(([i, id]) => ({ from: artists[i], id: id.slice(0, 200) }));
    return { name: String(d.n || "Playlist").slice(0, 80), artists, tracks };
  } catch {
    return null;
  }
}

// ── scanned codes ───────────────────────────────────────────────────────────

/**
 * What a link or a scanned code means. The app's own links:
 *   /app/?add=<manifest>                 an artist
 *   /app/?playlist=<code>                a playlist
 *   /app/?gift=<manifest>&code=<code>    a gift
 *   /app/?song=<manifest>&id=<track>     a song
 *   /app/?album=<manifest>&id=<release>  an album
 * and an artist's own page, `https://their.page/?song=<id>` or `?album=<id>`,
 * which is what's shared for a song or album (it previews as a card). Else
 * an artist: their website or address.
 */
const ITEM_ID = /^[a-z0-9-]{1,64}$/;
export function readCode(text) {
  const raw = String(text || "").trim();
  try {
    const u = new URL(raw);
    const gift = u.searchParams.get("gift"), code = u.searchParams.get("code");
    if (gift && code) return { kind: "gift", value: gift, code };
    for (const kind of ["song", "album"]) {
      const v = u.searchParams.get(kind);
      if (!v) continue;
      const inApp = /^https:\/\//.test(v);
      const id = inApp ? u.searchParams.get("id") : v;
      if (id && ITEM_ID.test(id) && (inApp || u.protocol === "https:")) {
        return { kind, value: inApp ? v : `${u.origin}/manifest.json`, id };
      }
    }
    const add = u.searchParams.get("add");
    if (add) return { kind: "artist", value: add };
    const playlist = u.searchParams.get("playlist");
    if (playlist) return { kind: "playlist", value: playlist };
    if (u.protocol === "https:") return { kind: "artist", value: raw };
    return null;
  } catch {
    // Not a URL: a bare domain like hollowcoast.com is fine; anything else isn't.
    return /^[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(raw) ? { kind: "artist", value: raw } : null;
  }
}

/** A song's link to share: the artist's own page, naming it, which previews
 *  as a card with its title and cover, and opens it in the app. */
export const songLink = (manifestUrl, id) => `${new URL(manifestUrl).origin}/?song=${encodeURIComponent(id)}`;
/** An album's, the same way. */
export const albumLink = (manifestUrl, id) => `${new URL(manifestUrl).origin}/?album=${encodeURIComponent(id)}`;
