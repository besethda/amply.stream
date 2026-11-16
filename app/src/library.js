/**
 * The listener's library, which lives on their device and nowhere else.
 *
 * This is the whole of Amply's "discovery": a list of addresses someone chose
 * to add. There is no server holding it, no account, and nothing to sync. That
 * is not modesty, it is the legal line: a shipped or hosted list of where music
 * is would make this a catalogue rather than a player, and turn Amply into the
 * thing it exists not to be. See docs/legal.md and docs/clients.md.
 *
 * Kept in localStorage, which every browser and both native shells share. Each
 * manifest is a few kilobytes and the cap keeps a large library from filling
 * the quota; the manifests are a cache, refetched whenever the app opens.
 */
const KEY = "amply.library.v1";
const MAX_ARTISTS = 300;

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;   // private window, blocked storage, or corrupt
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;      // out of quota, or storage refused
  }
}

/** [{ url, manifest, added }], newest first. */
export const loadLibrary = () => read(KEY, []);

export function saveLibrary(entries) {
  return write(KEY, entries.slice(0, MAX_ARTISTS));
}

/** Follow an artist: added deliberately, shown under Artists and on Home. */
export function addArtist(entries, url, manifest, domain = null) {
  const without = entries.filter((e) => e.url !== url);
  return [{ url, manifest, added: Date.now(), followed: true, ...(domain ? { domain } : {}) }, ...without];
}

/**
 * Know an artist without following them: someone shared a playlist with one
 * of their songs in it. The app needs their page to play the song and show its
 * price, and to pay them for it — but opening a playlist follows no one.
 */
export function addKnown(entries, url, manifest, domain = null) {
  if (entries.some((e) => e.url === url)) return entries;
  return [...entries, { url, manifest, added: Date.now(), followed: false, ...(domain ? { domain } : {}) }];
}

/** Entries written before following existed were all followed. */
export const isFollowed = (e) => e.followed !== false;
export const followedOnly = (entries) => entries.filter(isFollowed);
export const setFollowed = (entries, url, on) => entries.map((e) => (e.url === url ? { ...e, followed: !!on } : e));

export const removeArtist = (entries, url) => entries.filter((e) => e.url !== url);

// ── whether an artist's service still answers ──────────────────────────────
//
// An artist can take their service down, or a song off it. The manifest kept
// here is a copy, so the app checks each artist's real page regularly: when it
// opens, when it comes back after a while, and every few hours while open. A
// song that's no longer on the page is gone from playlists, likes and history
// at once, since those only point at songs. An artist whose service doesn't
// answer has their songs hidden too: their audio and artwork live on the same
// server, so they couldn't play anyway. They come back when it answers again.

/** How often to check every artist's page. */
export const CHECK_EVERY_MS = 6 * 3600_000;
/** How long without an answer before the app says the service seems gone. */
export const GONE_AFTER_MS = 30 * 86400_000;

/** An entry after a check: when it last answered, or since when it hasn't. */
export function noteReach(entry, ok, now = Date.now()) {
  if (ok) {
    const { unreachableSince: _was, ...rest } = entry;
    return { ...rest, lastSeen: now };
  }
  return { ...entry, unreachableSince: entry.unreachableSince ?? now };
}

/** Whether this artist's node paid listeners' network fees at the last check. */
export const feesCovered = (e) => !!e?.feesPaid;

/** Whether any followed artist who charges still needs the listener to hold
 *  SOL for fees: only then is "add $1 for fees" worth saying. */
export const feesNeeded = (entries, charges) =>
  (entries || []).some((e) => isFollowed(e) && reachable(e) && charges(e.manifest) && !feesCovered(e));

/** Whether this artist's service answered at the last check. */
export const reachable = (e) => !!e && !e.unreachableSince;

/** Whether it has been silent long enough to say it's probably gone. */
export const seemsGone = (e, now = Date.now()) => !!e?.unreachableSince && now - e.unreachableSince >= GONE_AFTER_MS;
