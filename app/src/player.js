/**
 * Playback, and the only thing that counts as listening.
 *
 * A few things here are less obvious than they look.
 *
 * **Counting.** The artist charges per minute listened, so what accrues is
 * audio actually played, measured as it plays: the clock moving forward while
 * the element is not paused. Not elapsed wall time, which would charge for a
 * paused track, and not track duration, which would charge in full for a song
 * skipped after ten seconds. Seeking is not listening either, so a jump in the
 * clock is ignored rather than counted.
 *
 * **Not ending.** In a home-screen web app on iOS, a track that *ends* while
 * the app is in the background does not start the next one, and the lock screen
 * controls stop responding until the app is reopened (WebKit bug 261858, open
 * since 2023). The fix is to never reach the end: move to the next track a
 * fraction of a second early, while the element is still playing. See
 * docs/clients.md.
 *
 * **The queue.** `list` is what was asked to play, in its own order; `order`
 * is the order it actually plays in (the same, or shuffled), as positions in
 * `list`; `pos` is where in `order` we are. Shuffling reorders only what is
 * still to come, so the song playing now carries on.
 *
 * **Losing signal.** When the connection drops mid-song, the element doesn't
 * pause or fail: it waits for data, still "playing", and on iOS often never
 * asks again once the signal is back. So a watchdog looks at the clock each
 * second. Not moving for STUCK_S while it should be is shown as buffering;
 * for RECOVER_S, or an error, and the song is fetched afresh from where it
 * got to — again every few seconds, and at once when the phone says it's
 * back online.
 */
import { gradientImage } from "./looks.js";

const LEAD = 0.35;          // seconds before the end to move on
const MAX_STEP = 2;         // a bigger jump than this is a seek, not listening
const STUCK_S = 2;          // clock still this long while playing: buffering
const RECOVER_S = 5;        // this long: fetch the song again from where it was
const RETRY_MAX_S = 10;     // and again, at most this far apart: a signal that comes back is not announced

export const REPEAT = { OFF: 0, ALL: 1, ONE: 2 };

/** Fisher–Yates, with an injectable source of randomness for tests. */
export function shuffled(items, random = Math.random) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function createPlayer(onChange, onListened, {
  /** Turn a track into the URL to actually fetch. Paid tracks need a token,
   *  which takes a round trip, so this is asynchronous. A refusal is thrown as
   *  an Error whose `kind` says why (see app.jsx), so the app can offer the
   *  one thing that fixes it. */
  resolve = async (track) => track.url,
  /** Called when a track is done with, having played for this long. */
  onFinished = () => {},
  random = Math.random,
  /** Milliseconds, for the watchdog; injectable for tests. */
  clock = () => Date.now(),
} = {}) {
  const audio = new Audio();
  audio.preload = "auto";

  let list = [];
  let order = [];
  let pos = -1;
  let from = "";
  let shuffle = false;
  let repeat = REPEAT.OFF;
  let refused = null;
  let last = 0;             // where the clock was when we last looked
  let advancing = false;
  let played = 0;           // seconds of this track actually heard
  let loading = 0;          // guards against a slow resolve landing out of order
  let wanted = false;       // the listener means it to be playing
  let recovering = false;   // fetching the song again after losing signal
  let seen = { t: -1, at: 0 };   // the clock, and when it last moved
  let tries = 0, nextTry = 0;
  let waiting = false;      // shown as buffering

  const now = () => (pos >= 0 && pos < order.length ? list[order[pos]] : null);
  const hasNext = () => pos < order.length - 1 || (repeat === REPEAT.ALL && order.length > 0);

  function report() {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.playbackState = audio.paused ? "paused" : "playing";
      const total = audio.duration;
      if (Number.isFinite(total) && total > 0) {
        navigator.mediaSession.setPositionState({
          duration: total,
          position: Math.min(Math.max(audio.currentTime || 0, 0), total),
          playbackRate: audio.playbackRate || 1,
        });
      }
    } catch { /* a browser with some of this and not the rest */ }
  }

  const tell = () => {
    report();
    onChange({
      track: now(), playing: !audio.paused && !audio.ended, waiting,
      at: audio.currentTime || 0,
      duration: audio.duration || now()?.duration || 0,
      hasNext: hasNext(),
      hasPrev: pos > 0,
      shuffle, repeat, from,
      upNext: order.slice(pos + 1).map((i) => list[i]),
      refused,
    });
  };

  /** Tell whoever is counting that the track we were on is finished with. */
  function finish() {
    const track = now();
    if (track && played > 0) onFinished(track, played);
    played = 0;
  }

  async function load(p, autoplay = true) {
    if (p < 0 || p >= order.length) return;
    finish();

    const mine = ++loading;
    pos = p;
    last = 0;
    advancing = false;
    refused = null;
    const track = now();
    describe(track);
    audio.pause();
    wanted = autoplay; recovering = false; waiting = false; tries = 0;
    seen = { t: -1, at: clock() };
    tell();

    let url = track.url;
    try {
      url = await resolve(track);
    } catch (e) {
      if (mine !== loading) return;
      refused = { kind: e.kind || "refused", message: e.message, ...(e.data || {}) };
      tell();
      return;
    }
    if (mine !== loading) return;   // a later track won the race

    audio.src = url;
    if (autoplay) audio.play().catch(() => tell());
    tell();
  }

  /** The next song, as repeat decides. */
  function advance() {
    if (repeat === REPEAT.ONE) {
      finish();
      last = 0;
      advancing = false;
      audio.currentTime = 0;
      audio.play().catch(() => {});
      return;
    }
    if (pos < order.length - 1) return load(pos + 1);
    if (repeat === REPEAT.ALL && order.length) return load(0);
    audio.pause();
    tell();
  }

  /**
   * What the phone shows on the lock screen: the release's artwork, or — when
   * it has none — the same gradient the app shows, drawn as an image. Sizes
   * are given because iOS picks from them and ignores artwork without.
   */
  function describe(track) {
    if (!("mediaSession" in navigator) || !track) return;
    const art = track.art || gradientImage(track.releaseTitle || track.title);
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title || "Untitled",
        artist: track.artistName || "",
        album: track.releaseTitle || "",
        artwork: art ? ["96x96", "256x256", "512x512"].map((sizes) => ({ src: art, sizes })) : [],
      });
    } catch { /* MediaMetadata missing */ }
  }

  audio.addEventListener("timeupdate", () => {
    const t = audio.currentTime;
    const step = t - last;
    last = t;

    // Only forward movement of a plausible size is listening.
    if (step > 0 && step <= MAX_STEP && !audio.paused) {
      played += step;
      onListened(now(), step);
    }

    // Move on before the element can end, not after.
    const total = audio.duration;
    if (!advancing && Number.isFinite(total) && total > 0 && total - t <= LEAD) {
      advancing = true;
      advance();
    }
    tell();
  });

  // A safety net: if a track ends anyway, carry on. In the background on iOS
  // this will not fire usefully, which is what the lead time above is for.
  audio.addEventListener("ended", () => advance());
  for (const e of ["play", "pause", "loadedmetadata", "error"]) audio.addEventListener(e, tell);

  // What the listener means: playing once it plays; paused when it pauses —
  // by them, the lock screen, or a phone call — but not when losing signal,
  // or our own reloading, pauses it.
  audio.addEventListener("playing", () => { wanted = true; recovering = false; tries = 0; });
  audio.addEventListener("pause", () => { if (!recovering && !audio.error) wanted = false; });

  /** Fetch the song again and carry on from where it got to. */
  async function recover() {
    const track = now();
    if (!track) return;
    const mine = loading, at = audio.currentTime || 0;
    recovering = true;
    tries++;
    nextTry = clock() + Math.min(RETRY_MAX_S, RECOVER_S * tries) * 1000;
    let url;
    try { url = await resolve(track); } catch { return; }   // still no signal: try again later
    if (mine !== loading || !wanted) return;
    audio.addEventListener("loadedmetadata", () => { last = at; audio.currentTime = at; }, { once: true });
    audio.src = url;
    audio.play().catch(() => {});
  }

  /** The watchdog: once a second, is it moving when it should be? */
  function check() {
    const t = audio.currentTime || 0, ms = clock();
    if (t !== seen.t) seen = { t, at: ms };
    const should = wanted && now() && !refused && !audio.ended && (!audio.paused || audio.error || recovering);
    const still = should ? (ms - seen.at) / 1000 : 0;
    const was = waiting;
    waiting = should && (still >= STUCK_S || !!audio.error);
    if (should && (still >= RECOVER_S || audio.error) && ms >= nextTry) recover();
    if (!should) { recovering = false; tries = 0; nextTry = 0; }
    if (waiting !== was) tell();
  }
  if (typeof setInterval === "function") setInterval(check, 1000);
  if (typeof window !== "undefined") {
    window.addEventListener?.("online", () => { if (waiting) { nextTry = 0; recover(); } });
  }

  /**
   * Tell the phone this is music.
   *
   * Safari's audio session defaults to "auto", which starts out as ambient:
   * incidental sound, which ducks and mixes with whatever else is going on.
   * "playback" is the type for music and podcasts, and it does not duck.
   * iOS 17 and later; everywhere else this does nothing.
   */
  try {
    if (navigator.audioSession) navigator.audioSession.type = "playback";
  } catch { /* not supported, and no harm */ }

  /**
   * What the lock screen may ask of us.
   *
   * Applied at startup and again whenever playback starts, because iOS builds
   * its now-playing session when audio begins. No seeking of any kind: iOS
   * prefers seeking to skipping, and offering any of it gets skip-ten-seconds
   * where next-track belongs. The app's own scrubber still seeks.
   */
  function installHandlers() {
    if (!("mediaSession" in navigator)) return;
    const set = (action, fn) => {
      try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* unsupported */ }
    };
    set("play", () => { wanted = true; audio.play().catch(() => {}); });
    set("pause", () => audio.pause());
    set("nexttrack", () => api.next());
    set("previoustrack", () => api.prev());
    set("seekto", null);
    set("seekbackward", null);
    set("seekforward", null);
  }

  installHandlers();
  audio.addEventListener("play", installHandlers);

  /** Rebuild the play order after the current song, keeping it where it is. */
  function reorder() {
    const current = order[pos];
    const rest = list.map((_, i) => i).filter((i) => i !== current);
    if (shuffle) {
      order = current == null ? shuffled(rest, random) : [current, ...shuffled(rest, random)];
      pos = current == null ? -1 : 0;
    } else {
      order = list.map((_, i) => i);
      pos = current == null ? -1 : current;
    }
  }

  const api = {
    /** Play a list from a given position. `label` says where it came from. */
    play(tracks, at = 0, label = "") {
      list = tracks.slice();
      from = label;
      order = list.map((_, i) => i);
      pos = at;
      if (shuffle) reorder();
      load(pos);
    },
    toggle() {
      if (!now()) return;
      if (refused) return load(pos);
      if (audio.paused) { wanted = true; audio.play().catch(() => {}); } else { wanted = false; audio.pause(); }
    },
    next() {
      if (pos < order.length - 1) return load(pos + 1);
      if (repeat === REPEAT.ALL && order.length) return load(0);
    },
    /** Back to the start of the song, or to the one before if we're near it. */
    prev() {
      if (audio.currentTime > 3 || pos <= 0) { api.seek(0); tell(); return; }
      load(pos - 1);
    },
    seek(seconds) { last = seconds; audio.currentTime = seconds; },
    /** Try the current song again — after agreeing a price, topping up… */
    retry() { if (now()) load(pos); },
    setShuffle(on) { shuffle = !!on; if (list.length) reorder(); tell(); },
    toggleShuffle() { api.setShuffle(!shuffle); },
    cycleRepeat() { repeat = (repeat + 1) % 3; tell(); },
    /** Up next, by position in what's still to come. */
    removeNext(k) {
      const at = pos + 1 + k;
      if (at <= pos || at >= order.length) return;
      order.splice(at, 1);
      tell();
    },
    /** Up next, dragged from one place to another. */
    moveNextTo(from, to) {
      const a = pos + 1 + from, b = pos + 1 + to;
      if (a === b || a <= pos || b <= pos || a >= order.length || b >= order.length) return;
      const [x] = order.splice(a, 1);
      order.splice(b, 0, x);
      tell();
    },
    /** Play straight after this one. */
    playNext(track) {
      list.push(track);
      if (pos < 0) { order = [list.length - 1]; return load(0); }
      order.splice(pos + 1, 0, list.length - 1);
      tell();
    },
    addToQueue(track) {
      list.push(track);
      order.push(list.length - 1);
      if (pos < 0) return load(0);
      tell();
    },
    /**
     * Take songs out: from what's been played and what's to come. If one is
     * playing, it stops — it may no longer exist (a local song, deleted).
     */
    remove(match) {
      const cur = now();
      if (cur && match(cur)) return api.stop();
      const keep = [];
      order.forEach((i, k) => {
        if (!match(list[i])) keep.push(i);
        else if (k < pos) pos--;
      });
      order = keep;
      tell();
    },
    stop() { finish(); wanted = false; audio.pause(); audio.removeAttribute("src"); list = []; order = []; pos = -1; refused = null; tell(); },
    /** The playing element — read by the waveform, never rerouted. */
    element: () => audio,
    current: now,
    /** Tests: run the watchdog now, rather than waiting a second. */
    check,
  };
  return api;
}
