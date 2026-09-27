/**
 * The listening app.
 *
 * It opens empty on purpose. There is no catalogue to browse, no search, and
 * nothing Amply could remove or promote, because Amply holds no list of who is
 * on it. A listener adds an artist by the link or website that artist gave
 * them, exactly as a podcast app takes a feed. See docs/clients.md.
 *
 * Money appears in few places: You, and tips from Now playing. Everywhere
 * else a price is a small badge, and a decision about money is a sheet at the
 * moment it's needed.
 */
import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from "preact/hooks";
import { fetchManifest, tracksOf, rateOf, verifiedDomain } from "./manifest.js";
import { loadLibrary, saveLibrary, addArtist, addKnown, removeArtist, followedOnly, isFollowed, setFollowed } from "./library.js";
import { createPlayer } from "./player.js";
import {
  loadLedger, bank, owing, settle, settleAll, backupSaved, totalOwed, hasWallet, machinery, rateStatus, mismatch,
} from "./paying.js";
import { agreeRate } from "./spend.js";
import {
  tokenFor, reportPlayed, originOf, audioUrl, isSubscribed, subscriptionUntil, forgetToken,
  manageSubscription, claimSubscription,
} from "./identify.js";
import { perMinute, subscriptionOnly } from "../../spec/pricing.mjs";
import { Icon } from "./icons.jsx";
import { money } from "./wallet-ui.jsx";
import { recent, played, forgetRecent, theme, setTheme, waveStyle, setWaveStyle, WAVE_STYLES } from "./looks.js";
import { MiniPlayer, NowPlaying, Tips } from "./playing.jsx";
import { Sheet, Toast, refusalSheet, registerAsk, ask } from "./sheets.jsx";
import { FirstRun, Home, Library, ArtistPage, nameOf, RowSwipe } from "./screens.jsx";
import { Collection, trackMenu, AddToPlaylist, PlaylistOptions, EditDetails } from "./collections.jsx";
import {
  likes, isLiked, toggleLike, playlists, createPlaylist, renamePlaylist, deletePlaylist, addToPlaylist,
  removeFromPlaylist, movePlaylistTrack, referenced, shareLink, readShare, ref, forgetSong, setLiked, setPlaylistArt,
  readCode, songLink, albumLink,
} from "./collection.js";
import { You } from "./you.jsx";
import { AddScreen } from "./add.jsx";
import { createVisualizer } from "./visualizer.js";
import { pageScroll, setPageScroll } from "./scroll.js";
import {
  LOCAL, localSongs, audioUrl as localAudio, wavesResponse, albums as albumsOf, editSong, removeSong, saveOwned, ownedIndex, setOwned, filesOf,
  cover as coverOf,
} from "./local.js";
import {
  offerFor, offersFor, purchaseMemo, claimCard, redeemGift, downloadTrack, giftLink, rememberCheckout, takeCheckout,
  unclaimed, keepUnclaimed, dropUnclaimed, claimWallet, claimWalletPatiently, saveCopies,
} from "./buy.js";
import { BuyForm, Purchases } from "./buy-ui.jsx";
import { Handoff, needsHandoff, SHARED_LINK } from "./handoff.jsx";
import { toMicros } from "./money.js";
import { tipsFor, amplyTips, tipBlocked, tipMicros } from "./tips.js";
import { createUpdater, IDLE_MS as UPDATE_IDLE_MS } from "./update.js";
import {
  behindSplash, showSplash, fontsLoaded, imagesInView, laidOut, START_MS as SPLASH_START_MS, RESUME_MS as SPLASH_RESUME_MS,
} from "./splash.js";

/** A refusal the player can show: it carries a `kind` (see sheets.jsx). */
function refuse(kind, message = kind, data = {}) {
  const e = new Error(message);
  e.kind = kind;
  e.data = data;
  return e;
}

const BASE = { tab: "home", open: null, coll: null, you: null, add: false, depth: 0 };
/** Which screen this is, for remembering how far down it was scrolled. */
const screenOf = (u) => [u.tab, u.open, u.coll && JSON.stringify(u.coll), u.you, u.add].join("|");

export function App() {
  const [entries, setEntries] = useState(() => loadLibrary());
  const [ledger, setLedger] = useState(() => loadLedger());
  // Where the listener is. Every step deeper is a history entry, so the
  // phone's back gesture steps back out instead of leaving the app.
  const [ui, setUi] = useState(BASE);
  const uiRef = useRef(ui); uiRef.current = ui;
  // How far down each screen was: back where you were on returning to a tab,
  // or stepping back out of an album; a screen newly opened starts at the top.
  const scrolls = useRef({});
  const keepScroll = () => { scrolls.current[screenOf(uiRef.current)] = pageScroll(); };
  const screenKey = screenOf(ui);
  useLayoutEffect(() => { setPageScroll(scrolls.current[screenKey] || 0); }, [screenKey]);
  const { tab, open, coll } = ui;
  // Now playing sits over whatever page you're on; it isn't a page itself, so
  // it's no step in the history and the phone's back gesture doesn't close
  // it. It's swiped down, or closed with its arrow.
  const [np, setNpOpen] = useState(false);
  const npRef = useRef(np); npRef.current = np;
  const youView = ui.you;
  const [, bump] = useState(0);                   // redraw after likes/playlists change
  const [shared, setShared] = useState(null);     // a playlist opened from a link
  const [sheet, setSheet] = useState(null);
  const [toast, setToastState] = useState(null);
  const [pair, setPair] = useState(null);
  const [balance, setBalance] = useState(null);
  const [themeName, setThemeName] = useState(theme);
  const [wave, setWave] = useState(waveStyle);     // how Now playing draws the music
  const [fresh, setFresh] = useState(0);          // bumped when a subscription arrives
  const [state, setState] = useState({ track: null, playing: false, at: 0, duration: 0, upNext: [] });
  const [handoff, setHandoff] = useState(null);   // a link opened in Safari on an iPhone, waiting
  // Songs imported from this phone's files (local.js): never paid for, never shared.
  const [local, setLocal] = useState([]);
  const reloadLocal = () => localSongs().then(setLocal).catch(() => {});
  useEffect(() => { reloadLocal(); }, []);

  // Refs the player reads, because it outlives any one render.
  const pending = useRef({});          // seconds listened, banked on a slower clock
  const holder = useRef(null); holder.current = pair;
  const library = useRef(entries); library.current = entries;
  const funds = useRef(null); funds.current = balance;
  const session = useRef(0);           // micros accrued since the app opened
  const shown = useRef(null);          // the refusal last put in a sheet

  const go = useCallback((patch, { replace = false } = {}) => {
    // Going anywhere from Now playing closes it; that part is no history step.
    if ("np" in patch) {
      const { np: on, ...rest } = patch;
      setNpOpen(!!on);
      patch = rest;
      if (!Object.keys(patch).length) return;
    }
    const cur = uiRef.current;
    const next = { ...cur, ...patch, depth: replace ? (patch.depth ?? cur.depth ?? 0) : (patch.depth ?? cur.depth ?? 0) + 1 };
    keepScroll();
    if (!replace) delete scrolls.current[screenOf(next)];
    try { history[replace ? "replaceState" : "pushState"]({ amply: 1, ui: next }, ""); } catch { /* no history here */ }
    setUi(next);
  }, []);
  // Back steps out one level — or, at the first screen this visit (a shared
  // link opened straight into the app), goes Home rather than leaving.
  const back = () => {
    if ((uiRef.current.depth || 0) > 0) { try { history.back(); return; } catch { /* fall through */ } }
    go({ ...BASE, tab: uiRef.current.tab }, { replace: true });
  };
  useEffect(() => {
    try { history.replaceState({ amply: 1, ui: uiRef.current }, ""); } catch { /* no history here */ }
    // The app puts each screen back where it was itself (scrolls, above).
    try { history.scrollRestoration = "manual"; } catch { /* older browser */ }
    const onPop = (e) => { keepScroll(); setSheet(null); setUi(e.state?.ui || BASE); };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const setOpen = (url) => go({ open: url, coll: null, np: false });
  // The waveform's analyser. Started from the tap that opens Now playing —
  // iOS allows audio only from a gesture — and stopped when it closes.
  const viz = useMemo(() => (typeof window !== "undefined" ? createVisualizer({
    get: (url) => (url.startsWith(`${LOCAL}:`) ? wavesResponse(url.slice(LOCAL.length + 1)) : fetch(url, { priority: "low" })),
  }) : null), []);
  // Tests only: the screenshot harness reads the levels on localhost.
  try { if (location.hostname === "localhost") window.__amplyViz = viz; } catch { /* not a browser */ }
  const setNp = (on) => {
    if (on) viz?.start(player.element());
    setNpOpen(!!on);
  };
  const setYouView = (v) => (v ? go({ you: v }) : back());

  // Confirmations open as a sheet; dismissing it counts as no.
  const answer = useRef(null);
  registerAsk(({ title, body, confirm, danger, icon }) => new Promise((resolve) => {
    answer.current = resolve;
    setSheet({
      title, body, danger,
      icon: icon || (danger ? <Icon.warn size={22} /> : null), tone: danger ? "warn" : "",
      primaryLabel: confirm, secondaryLabel: "Cancel",
      primary: () => { answer.current = null; setSheet(null); resolve(true); },
    });
  }));
  const closeSheet = () => { const r = answer.current; answer.current = null; setSheet(null); r?.(false); };

  const toastTimer = useRef(0);
  const flash = useCallback((t) => {
    setToastState(t);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastState(null), 2600);
  }, []);

  const localBlob = useRef(null);                 // the local song's audio, playing now
  const player = useMemo(() => createPlayer(
    setState,
    (track, seconds) => {
      if (!track?.from || !track.needsWallet) return;
      // A subscriber has paid by card; charging by the minute too would be twice.
      if (isSubscribed(originOf(track.url))) return;
      pending.current[track.from] = (pending.current[track.from] || 0) + seconds;
      const artist = library.current.find((e) => e.url === track.from);
      const rate = artist && rateOf(artist.manifest);
      if (rate?.perMinute > 0) session.current += (seconds / 60) * rate.perMinute * 1e6;
    },
    {
      /**
       * Free songs are fetched anonymously. A paid one needs a pass from the
       * artist's server, money that can pay them, and — the first time, or
       * after a price rise — the listener's agreement to the price. Each
       * missing piece is a refusal with a kind, so the app can offer the one
       * thing that fixes it.
       */
      async resolve(track) {
        // A bought song with its copy on this phone plays that, and is free.
        if (track.ownedCopy) {
          const url = await localAudio(track.ownedCopy).catch(() => null);
          if (url) {
            if (localBlob.current) URL.revokeObjectURL(localBlob.current);
            return (localBlob.current = url);
          }
        }
        if (track.local) {
          const url = await localAudio(track.id);
          if (localBlob.current) URL.revokeObjectURL(localBlob.current);
          return (localBlob.current = url);
        }
        if (!track.needsWallet) return track.url;
        const artist = library.current.find((e) => e.url === track.from);
        const data = { url: track.from, name: nameOf(artist), art: artist?.manifest?.artist?.image || track.art || null };
        const onlySub = artist && subscriptionOnly(artist.manifest);
        if (!holder.current) throw refuse(onlySub ? "subscribe" : "nowallet", "", data);

        const origin = originOf(track.url);
        let token;
        try { token = await tokenFor(holder.current, origin); }
        catch (e) { throw refuse(e.subscribe ? "subscribe" : "refused", e.message, data); }
        if (!token) throw refuse("offline", "", data);

        if (!isSubscribed(origin) && !onlySub) {
          const rate = artist && rateOf(artist.manifest);
          // Money on the wrong network can't pay this artist, so it can't hear
          // their paid music either — or a test wallet would be free listening.
          const wrong = rate && mismatch(rate);
          if (wrong) throw refuse("mismatch", wrong, data);
          // An empty wallet is no better than none. Only once the balance is
          // known: a slow network is no reason to stop someone who pays.
          const b = funds.current;
          if (b && !(b.usdc > 0)) throw refuse("empty", "", data);
          if (b && !(b.sol > 0.001)) throw refuse("nosol", "", data);
          // No agreed price, no playing: otherwise never agreeing would mean
          // free listening.
          if (rate) {
            const status = rateStatus(track.from, rate.perMinute);
            if (status.ask) throw refuse("price", "", { ...data, rate: status.rate, was: status.was });
          }
        }
        return audioUrl(track.url, token);
      },
      onFinished(track, seconds) {
        if (!track.needsWallet || !holder.current) return;
        reportPlayed(holder.current, originOf(track.url), seconds);
      },
    },
  ), []);
  try { if (location.hostname === "localhost") window.__amplyPlayer = player; } catch { /* not a browser */ }

  // ── listening, banked and paid for ────────────────────────────────────────

  useEffect(() => {
    const flush = () => {
      const banked = pending.current;
      pending.current = {};
      if (!Object.keys(banked).length) return;
      setLedger((l) => bank(l, library.current, banked));
    };
    const timer = setInterval(flush, 5000);
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("pagehide", flush);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", flush);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  // A library is a cache of other people's pages: refresh it on opening, and
  // keep what we have if an artist's service is unreachable.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next = await Promise.all(entries.map(async (e) => {
        try {
          const { manifest } = await fetchManifest(e.url);
          // Checked afresh each time: a domain pointed elsewhere stops vouching.
          const domain = await verifiedDomain(e.url, manifest, e.domain);
          const { domain: _was, ...rest } = e;
          return { ...rest, manifest, ...(domain ? { domain } : {}) };
        } catch {
          return e;
        }
      }));
      if (!cancelled && next.length) { setEntries(next); saveLibrary(next); }
    })();
    return () => { cancelled = true; };
  }, []);

  // A wallet that exists is loaded quietly. Nobody without one ever fetches
  // the payment libraries.
  useEffect(() => {
    if (!hasWallet() || pair) return;
    machinery().then(({ wallet }) => {
      try { setPair(wallet.loadWallet()); } catch (e) { flash({ bad: true, text: e.message }); }
    });
  }, []);

  const refresh = useCallback(async () => {
    if (!pair) return;
    const { wallet } = await machinery();
    try { setBalance(await wallet.balances(pair)); }
    catch { setBalance(null); flash({ bad: true, text: "Couldn't check your wallet" }); }
  }, [pair]);
  useEffect(() => { refresh(); }, [pair, refresh]);

  /** Pay whoever is due: at the artist's amount, or a week after listening. */
  const settleNow = useCallback(async () => {
    if (!pair) return;
    const result = await settleAll(pair, entries, ledger);
    if (result.paid.length || result.failed.length) { setLedger(result.ledger); refresh(); }
    if (result.paid.length) {
      const first = result.paid[0];
      const total = result.paid.reduce((n, p) => n + p.usd, 0);
      flash({ text: result.paid.length === 1 ? `Paid ${money(total)} → ${nameOf(first.entry)}` : `Paid ${money(total)} to ${result.paid.length} artists` });
    }
    if (result.failed.length) flash({ bad: true, text: result.failed[0].message });
  }, [pair, entries, ledger, refresh]);

  useEffect(() => {
    if (!pair || !entries.some((e) => owing(e, ledger)?.due)) return;
    settleNow();
  }, [ledger, pair]);

  useEffect(() => { if (!np) viz?.stop(); }, [np]);
  // The waveform's data for the song playing, whichever screen shows it (the
  // mini player's, or Now playing's), and the next song's ahead of time.
  useEffect(() => { viz?.start(player.element()); }, []);
  useEffect(() => { viz?.show(state.track); }, [state.track]);
  useEffect(() => { viz?.prefetch(state.upNext?.[0]); }, [state.upNext?.[0]]);
  useEffect(() => {
    const vis = () => { if (document.visibilityState === "hidden") viz?.stop(); else if (npRef.current) viz?.start(player.element()); };
    document.addEventListener("visibilitychange", vis);
    return () => document.removeEventListener("visibilitychange", vis);
  }, []);

  // A newer version of the app (update.js), looked for behind the logo when
  // it opens — and only then. On a phone, opening it is often coming back to
  // it after a long while (it was kept in memory, not started again), so
  // that counts too, when nothing's playing.
  useEffect(() => {
    const updater = createUpdater({ audio: player.element() });
    // Behind the logo: the version check, the fonts, and the pictures on the
    // screen it opens to, so that screen appears complete.
    behindSplash(async () => (await Promise.all([
      updater.check(), fontsLoaded(), laidOut().then(() => imagesInView()),
    ]))[0], SPLASH_START_MS);
    let hiddenAt = 0;
    const back = () => {
      if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
      if (!hiddenAt || Date.now() - hiddenAt < UPDATE_IDLE_MS || !updater.idle()) return;
      showSplash();
      behindSplash(() => updater.check(), SPLASH_RESUME_MS);
    };
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, []);

  // Remember what was played, for Home.
  useEffect(() => { if (state.track && !state.refused) played(state.track); }, [state.track?.id, state.track?.from]);

  // ── a song that can't play opens the sheet that fixes it ──────────────────

  // Going to You from anywhere — Now playing included — shows You.
  const goYou = (view = null) => { setSheet(null); go({ ...BASE, np: false, tab: "you", you: view }); };
  useEffect(() => {
    const r = state.refused;
    if (!r || r === shown.current) return;
    shown.current = r;
    setSheet(refusalSheet(r, {
      money,
      go: {
        agree: () => { agreeRate(r.url, r.rate); setSheet(null); player.retry(); },
        you: () => goYou(),
        topUp: () => goYou("topup"),
        artist: () => { setSheet(null); go({ open: r.url, coll: null, np: false }); },
        retry: () => { setSheet(null); player.retry(); },
      },
    }));
  }, [state.refused]);

  // ── tips ──────────────────────────────────────────────────────────────────

  /**
   * Send a tip (tips.js): whatever stands in the way gets the same sheet a
   * paid song would, with the one thing that fixes it; otherwise the amount
   * is confirmed, then sent straight to them.
   */
  const tip = async (to, dollars) => {
    const blocked = tipBlocked(dollars, { hasWallet: !!pair, balance, mismatch: pair ? mismatch(to) : null });
    if (blocked === "amount") return;
    if (blocked) {
      setSheet(refusalSheet({ kind: blocked, message: pair ? mismatch(to) : "" }, {
        money, go: { you: () => goYou(), topUp: () => goYou("topup") },
      }));
      return;
    }
    const yes = await ask({
      title: `Tip ${to.name} ${money(dollars)}?`,
      body: "Straight to them, plus a tiny network fee.",
      confirm: `Send ${money(dollars)}`,
      icon: <Icon.heart size={22} />,
    });
    if (!yes) return;
    try {
      const { pay } = await machinery();
      await pay.payArtist(pair, to.recipients, tipMicros(dollars), { artistName: to.name });
      flash({ text: `Sent ${money(dollars)} → ${to.name}` });
      refresh();
    } catch (e) {
      // The payment's own words, except where they speak of a debt: a tip isn't owed.
      flash({ bad: true, text: e.kind === "network" ? "Couldn't reach the network, so nothing was sent."
        : e.message || "The tip didn't go through, so nothing was sent." });
    }
  };
  const tipsNow = useMemo(() => {
    const entry = state.track && entries.find((e) => e.url === state.track.from);
    const artist = tipsFor(entry?.manifest);
    const name = entry ? nameOf(entry) : state.track?.artistName || "this artist";
    const amply = amplyTips();
    return {
      name,
      links: artist.links,
      artist: artist.wallet ? (d) => tip({ name, ...artist.wallet }, d) : null,
      amply: amply ? (d) => tip({ name: "Amply", ...amply }, d) : null,
    };
  }, [state.track, entries, pair, balance]);

  // ── artists ───────────────────────────────────────────────────────────────

  async function add(input) {
    const found = await fetchManifest(input);
    const { url, manifest } = found;
    // Typed as a domain and found through its record: that is the proof.
    // Otherwise the manifest's own claim has to be confirmed by the domain.
    const domain = found.domain || await verifiedDomain(url, manifest);
    const next = addArtist(entries, url, manifest, domain);
    setEntries(next);
    saveLibrary(next);
    setSheet(null);
    go({ open: url, coll: null, np: false, tab: uiRef.current.tab === "you" ? "home" : uiRef.current.tab });
    flash({ text: `Following ${manifest.artist?.name || "artist"}` });
  }
  const openAdd = () => go({ add: true });

  /** Fetch and check an artist without following them — for the preview. */
  async function findArtist(input) {
    const found = await fetchManifest(input);
    const domain = found.domain || await verifiedDomain(found.url, found.manifest).catch(() => null);
    return { url: found.url, manifest: found.manifest, domain };
  }
  function followFound({ url, manifest, domain }) {
    const known = entries.some((e) => e.url === url);
    const next = known
      ? setFollowed(entries.map((e) => (e.url === url ? { ...e, manifest, ...(domain ? { domain } : {}) } : e)), url, true)
      : addArtist(entries, url, manifest, domain);
    setEntries(next);
    saveLibrary(next);
    flash({ text: `Following ${manifest.artist?.name || "artist"}` });
    go({ add: false, open: url, coll: null }, { replace: true });
  }

  // ── links: an artist, a playlist, a gift, a song, an album ────────────────

  /** An artist this app knows, or learns now — without following them. */
  async function knownArtist(url) {
    const had = library.current.find((x) => x.url === url);
    if (had) return had;
    const found = await fetchManifest(url);
    const domain = found.domain || await verifiedDomain(found.url, found.manifest).catch(() => null);
    const next = addKnown(library.current, found.url, found.manifest, domain);
    setEntries(next); saveLibrary(next);
    return next.find((x) => x.url === found.url);
  }

  /** Open a link, whichever kind (collection.js readCode). */
  async function openLink(link) {
    try {
      if (link.kind === "playlist") return openShared(link.value, { fromLink: true });
      if (link.kind === "gift") return openGift(link.value, link.code);
      if (link.kind === "artist") {
        const known = library.current.find((e) => e.url === link.value);
        if (known) return setOpen(known.url);
        return await add(link.value);
      }
      // A song or an album: its album, and for a song, a tap to play it.
      const e = await knownArtist(link.value);
      const rel = (e.manifest.releases || []).find((r) => (link.kind === "album" ? r.id === link.id : (r.tracks || []).some((t) => t.id === link.id)));
      if (!rel) { go({ ...BASE, open: e.url }, { replace: true }); flash({ text: `That ${link.kind} isn't on ${nameOf(e)}'s page any more` }); return; }
      go({ ...BASE, coll: { kind: "album", from: e.url, rid: rel.id } }, { replace: true });
      if (link.kind === "song") {
        const tracks = tracksOf(e).filter((t) => t.releaseId === rel.id);
        const i = tracks.findIndex((t) => t.id === link.id);
        setSheet({
          art: rel.art || e.manifest.artist?.image || null, seed: rel.title,
          title: tracks[i].title, body: `${nameOf(e)} · ${rel.title}`,
          primaryLabel: "Play", primary: () => { setSheet(null); player.setShuffle(false); play(tracks, i, rel.title); },
          secondaryLabel: "Not now",
        });
      }
    } catch (err) {
      flash({ bad: true, text: err.message || "That link didn't open." });
    }
  }

  // Arriving by a link. On an iPhone in Safari, first offer to hand it to the
  // app (handoff.jsx); anywhere else, open it.
  useEffect(() => {
    if (!SHARED_LINK.test(location.search)) return;
    const url = location.href;
    const link = readCode(url);
    history.replaceState({ amply: 1, ui: uiRef.current }, "", location.pathname);
    if (!link) return;
    if (needsHandoff()) setHandoff({ link, url });
    else openLink(link);
  }, []);

  /** Share a link: the phone's share sheet, or copied. */
  async function shareUrl(title, url) {
    try { if (navigator.share) { await navigator.share({ title, url }); return; } }
    catch (e) { if (e?.name === "AbortError") return; }
    try { await navigator.clipboard.writeText(url); flash({ text: "Link copied" }); }
    catch { window.prompt("Copy this link:", url); }
  }
  const shareSong = (t) => (t.local || t.from === LOCAL
    ? flash({ text: "Local songs stay on this phone" })
    : shareUrl(t.title, songLink(t.from, t.id)));

  function follow(url, on) {
    const next = setFollowed(entries, url, on);
    setEntries(next);
    saveLibrary(next);
  }

  // Opening a shared playlist fetches each artist's page from that artist, and
  // follows none of them.
  function openShared(code, { fromLink = false } = {}) {
    const list = readShare(code);
    if (!list) { flash({ bad: true, text: "That playlist link doesn't work" }); return; }
    setShared(list);
    if (fromLink) go({ ...BASE, coll: { kind: "shared" } }, { replace: true });
    else go({ add: false, coll: { kind: "shared" } }, { replace: true });
    (async () => {
      for (const url of list.artists) {
        if (library.current.some((e) => e.url === url)) continue;
        try {
          const { manifest } = await fetchManifest(url);
          const domain = await verifiedDomain(url, manifest).catch(() => null);
          setEntries((cur) => { const next = addKnown(cur, url, manifest, domain); saveLibrary(next); return next; });
        } catch { /* shown as unavailable */ }
      }
    })();
  }

  /** Unfollowing keeps an artist known while a like or playlist points at them,
   *  so those songs still play and they're still paid. Otherwise it removes
   *  them — paying what's owed first, as nothing would come back to send it. */
  async function drop(url) {
    if (referenced(url)) { follow(url, false); back(); return; }
    const leaving = entries.find((e) => e.url === url);
    if (pair && leaving && owing(leaving, ledger)) {
      try {
        const result = await settle(pair, leaving, ledger, { ending: true });
        if (result.refused) throw new Error(typeof result.refused === "string" ? result.refused : result.refused.message || "Payment not allowed");
        setLedger(result.ledger);
        refresh();
      } catch (e) {
        flash({ bad: true, text: `Pay what you owe first: ${e.message}` });
        return;
      }
    }
    const next = removeArtist(entries, url);
    setEntries(next);
    saveLibrary(next);
    back();
  }

  // ── subscriptions ─────────────────────────────────────────────────────────

  async function ensureWallet() {
    if (pair) return pair;
    const { wallet } = await machinery();
    const who = wallet.loadWallet() || wallet.createWallet();
    setPair(who);
    return who;
  }
  async function subscribe(entry, plan) {
    const who = await ensureWallet();
    const link = new URL(plan.url);
    link.searchParams.set("client_reference_id", who.publicKey.toBase58());
    location.href = link.toString();
  }
  async function manage(entry) {
    if (!pair) throw new Error("No wallet on this device");
    const back = `https://amply.stream/app/?subscribed=${encodeURIComponent(entry.url)}`;
    location.href = await manageSubscription(pair, originOf(entry.url), back);
  }

  // Back from Stripe: /app/?subscribed=<manifest>&session=<checkout>.
  useEffect(() => {
    let back = null, sessionId = "";
    try {
      const q = new URLSearchParams(location.search);
      back = q.get("subscribed");
      sessionId = q.get("session") || "";
    } catch { /* none */ }
    if (!back || !entries.some((e) => e.url === back)) return;
    history.replaceState({ amply: 1, ui: uiRef.current }, "", location.pathname);
    setOpen(back);
    const origin = originOf(back);
    let gone = false;
    (async () => {
      const { wallet } = await machinery();
      let who = null;
      try { who = wallet.loadWallet(); } catch { /* reported elsewhere */ }
      if (!who) return;
      for (let tries = 0; tries < 6 && !gone; tries++) {
        if (sessionId) {
          const r = await claimSubscription(who, origin, sessionId).catch(() => null);
          if (r?.outcome === "refused") { flash({ bad: true, text: "That payment isn't for this wallet" }); return; }
        }
        forgetToken(origin);
        await tokenFor(who, origin).catch(() => null);
        if (isSubscribed(origin)) {
          flash({ text: `Subscribed until ${new Date(subscriptionUntil(origin)).toLocaleDateString()}` });
          setFresh((n) => n + 1);
          return;
        }
        await new Promise((r) => setTimeout(r, 2500));
      }
      if (!gone) flash({ text: "Still confirming — check again shortly" });
    })();
    return () => { gone = true; };
  }, []);

  // Back from buying by card: /app/?bought=<manifest>&session=<checkout>.
  useEffect(() => {
    let back = null, sessionId = "";
    try { const q = new URLSearchParams(location.search); back = q.get("bought"); sessionId = q.get("session") || ""; } catch { /* none */ }
    const e = back && entries.find((x) => x.url === back);
    if (!e) return;
    history.replaceState({ amply: 1, ui: uiRef.current }, "", location.pathname);
    const origin = originOf(back);
    const plan = takeCheckout(origin);
    let gone = false;
    (async () => {
      const { wallet } = await machinery();
      let who = null;
      try { who = wallet.loadWallet(); } catch { /* reported elsewhere */ }
      if (!who) return;
      setSheet({ title: "Confirming your purchase…", body: `With ${nameOf(e)}'s server`, icon: <Icon.card size={22} />, secondaryLabel: "Hide" });
      for (let tries = 0; tries < 8 && !gone; tries++) {
        const r = await claimCard(who, origin, sessionId, plan?.gift).catch((err) => ({ outcome: "error", error: err.message }));
        if (r.outcome === "recorded") return bought(e, r);
        if (r.outcome === "refused") { setSheet(null); flash({ bad: true, text: r.error || "That payment isn't for this wallet" }); return; }
        await new Promise((ok) => setTimeout(ok, 2500));
      }
      if (!gone) { setSheet(null); flash({ text: "Still confirming — it'll be under You, Purchases, shortly" }); }
    })();
    return () => { gone = true; };
  }, []);

  // A gift: the artist is added if need be (not followed), the gift claimed
  // with this phone's wallet, and the songs downloaded to keep.
  function openGift(url, code) {
    (async () => {
      try {
        const e = await knownArtist(url);
        const who = await ensureWallet();
        setSheet({ title: "Opening your gift…", body: `From ${nameOf(e)}'s streaming service`, icon: <Icon.heart size={22} />, secondaryLabel: "Hide" });
        const r = await redeemGift(who, originOf(e.url), code);
        await keepSongs(e, tracksOfItem(e, r.item), titleOfItem(e, r.item));
      } catch (err) {
        setSheet(null);
        flash({ bad: true, text: err.message || "That gift couldn't be opened." });
      }
    })();
  }

  // USDC purchases paid but not yet confirmed, from last time: try again.
  useEffect(() => {
    const waiting = unclaimed().filter((u) => Date.now() - u.at < 7 * 86400_000);
    if (!waiting.length) return;
    (async () => {
      const { wallet } = await machinery();
      let who = null;
      try { who = wallet.loadWallet(); } catch { /* none */ }
      if (!who) return;
      for (const u of waiting) {
        const e = library.current.find((x) => x.url === u.url);
        if (!e) continue;
        const r = await claimWallet(who, originOf(e.url), u.tx, u.item, u.gift).catch(() => ({ outcome: "pending" }));
        if (r.outcome === "recorded") { dropUnclaimed(u.tx); bought(e, r); return; }
        if (r.outcome === "refused") dropUnclaimed(u.tx);
      }
    })();
  }, []);

  // ── what's on screen ──────────────────────────────────────────────────────

  const entry = entries.find((e) => e.url === open) || null;
  const owedAll = totalOwed(ledger);
  // Local songs, as if one more artist: albums from their tags, never followed or paid.
  const localAlbums = useMemo(() => albumsOf(local), [local]);
  const localEntry = useMemo(() => (local.length ? {
    url: LOCAL, local: true, followed: false, tracks: localAlbums.flatMap((a) => a.tracks),
    manifest: { artist: { name: "On this phone" }, releases: localAlbums.map((a) => ({ id: a.id, title: a.title, art: a.art, artistName: a.artist, tracks: a.tracks })) },
  } : null), [local, localAlbums]);
  const byUrl = (url) => (url === LOCAL ? localEntry : entries.find((e) => e.url === url));

  // Songs bought and kept on this phone, by the artist's song they came from.
  const ownedMap = useMemo(() => { setOwned(local); return ownedIndex(local); }, [local]);

  /** Songs carry their artist's name and trust, for the player and lock screen —
   *  and, when one is kept here, the copy to play instead: free, from the phone. */
  const decorate = (t) => {
    const e = byUrl(t.from);
    const kept = !t.local && ownedMap.get(`${t.from}#${t.id}`);
    return {
      ...t, artistName: t.artistName || nameOf(e), verified: !!e?.domain,
      ...(kept ? { ownedCopy: kept.id, needsWallet: false, ...(kept.waves ? { waves: `${LOCAL}:${kept.id}` } : {}) } : {}),
    };
  };
  const play = (tracks, at, label) => player.play(tracks.map(decorate), at, label);

  const recentTracks = recent().flatMap((r) => {
    const e = byUrl(r.from);
    const t = e && tracksOf(e).find((x) => x.id === r.id);
    return t ? [{ track: decorate(t), entry: e }] : [];
  }).slice(0, 5);

  /** The current song's cost, for the mini player and Now playing. */
  const cost = (() => {
    const t = state.track;
    if (!t) return { tag: "", tone: "" };
    const e = byUrl(t.from);
    if (t.local) return { tag: t.owned ? "owned" : "local", tone: "" };
    if (t.ownedCopy) return { tag: "owned", tone: "good" };
    if (!t.needsWallet) return { tag: "free", tone: "good" };
    if (isSubscribed(originOf(t.url))) return { tag: "sub", tone: "good" };
    const rate = e && rateOf(e.manifest);
    if (rate?.perMinute > 0 && perMinute(e.manifest)) return { tag: `${money(rate.perMinute)}/min`, tone: "paid" };
    return { tag: "sub only", tone: "" };
  })();
  const sessionLabel = session.current >= 100 ? money(session.current / 1e6) : null;

  const lowBalance = pair && balance && entries.some((e) => perMinute(e.manifest))
    && balance.usdc - owedAll < 0.25;
  const needsBackup = pair && !backupSaved(pair.publicKey.toBase58());

  const goTab = (t) => {
    // The tab you're already on, at its top level: back to the top of it.
    const u = uiRef.current;
    if (t === u.tab && !u.open && !u.coll && !u.you && !u.add) { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    go({ ...BASE, tab: t }, { replace: true });
  };
  const followed = followedOnly(entries);

  /** A pointer to a song, found in its artist's current page — or not. */
  const find = (r) => {
    const e = byUrl(r.from);
    const t = e && tracksOf(e).find((x) => x.id === r.id);
    return t ? { track: decorate(t), entry: e } : null;
  };
  const found = (refs) => { const rows = refs.map(find); return { rows: rows.filter(Boolean), missing: rows.filter((x) => !x).length }; };
  const lists = playlists();
  const liked = found(likes()).rows;
  const redraw = () => bump((n) => n + 1);

  async function shareList(name, all) {
    // Songs on this phone are the listener's own files: they stay here.
    const refs = all.filter((r) => r.from !== LOCAL);
    if (!all.length) { flash({ text: "This playlist is empty" }); return; }
    if (!refs.length) { flash({ text: "Local songs stay on this phone" }); return; }
    await shareUrl(name, shareLink(name, refs));
  }

  function pickPlaylist(track) {
    setSheet({
      title: "Add to playlist", secondaryLabel: "Cancel",
      children: <AddToPlaylist
        onPick={(id) => { addToPlaylist(id, track); setSheet(null); redraw(); flash({ text: `Added to ${playlists().find((p) => p.id === id)?.name}` }); }}
        onCreate={(name) => { createPlaylist(name, [track]); setSheet(null); redraw(); flash({ text: `Added to ${name}` }); }} />,
    });
  }

  const openAlbum = (from, rid) => go({ coll: { kind: "album", from, rid }, np: false });
  /** A local song has no artist page: its album instead. */
  const toArtist = (t) => (t.local ? openAlbum(LOCAL, t.releaseId) : go({ open: t.from, coll: null, np: false }));

  function editLocal(track) {
    const song = local.find((s) => s.id === track.id);
    if (!song) return;
    setSheet({
      title: "Edit details", secondaryLabel: "Cancel",
      children: <EditDetails song={song} albums={localAlbums} onSave={async (patch) => {
        try { await editSong(song.id, patch); } catch { flash({ bad: true, text: "Couldn't save that." }); return; }
        setSheet(null); reloadLocal(); flash({ text: "Saved" });
      }} />,
    });
  }
  /** A local album's songs dragged into a new order: their track numbers follow. */
  async function reorderLocal(rows, from, to) {
    const ids = rows.map((r) => r.track.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    const byId = new Map(local.map((s) => [s.id, s]));
    for (let i = 0; i < ids.length; i++) {
      const s = byId.get(ids[i]);
      if (s && s.track !== i + 1) await editSong(s.id, { track: i + 1 }).catch(() => {});
    }
    reloadLocal();
  }

  async function removeLocal(track) {
    if (!(await ask({ title: `Remove ${track.title}?`, body: "From this app only. The file stays where it was.", confirm: "Remove", danger: true }))) return;
    // Stopped first (and out of the queue): its audio is about to go.
    const it = (t) => t?.from === LOCAL && t.id === track.id;
    const wasPlaying = it(player.current());
    player.remove(it);
    if (wasPlaying && localBlob.current) { URL.revokeObjectURL(localBlob.current); localBlob.current = null; }
    if (wasPlaying) setNp(false);
    try { await removeSong(track.id); }
    catch (e) { flash({ bad: true, text: e.message }); reloadLocal(); return; }
    forgetSong(ref(track)); forgetRecent(ref(track));
    reloadLocal(); redraw();
    flash({ text: "Removed" });
  }

  function openMenu(track, playlistIndex = null) {
    const pl = coll?.kind === "playlist" ? coll.id : null;
    setSheet(trackMenu(track, {
      liked: isLiked(track),
      inPlaylist: pl && playlistIndex != null,
      onPlayNext: () => { player.playNext(decorate(track)); setSheet(null); flash({ text: "Playing next" }); },
      onQueue: () => { player.addToQueue(decorate(track)); setSheet(null); flash({ text: "Added to queue" }); },
      onLike: () => { const on = !isLiked(track); toggleLike(track); setSheet(null); redraw(); flash({ text: on ? "Liked" : "Unliked" }); },
      onAdd: () => pickPlaylist(track),
      onArtist: () => { setSheet(null); toArtist(track); },
      onRemove: () => { removeFromPlaylist(pl, playlistIndex); setSheet(null); redraw(); },
      onEdit: () => editLocal(track),
      onDelete: () => removeLocal(track),
      onShare: () => { setSheet(null); shareSong(track); },
      buys: buysFor(track),
    }));
  }

  // ── buying songs and albums ───────────────────────────────────────────────

  /** The Buy entries for a song's menu: the song, its album — unless kept already. */
  function buysFor(track) {
    if (track.local || track.ownedCopy || ownedMap.has(`${track.from}#${track.id}`)) return [];
    const e = byUrl(track.from);
    return offersFor(e, track.id).map((o) => ({
      label: `Buy ${o.kind === "album" ? "album" : "song"} · ${money(o.price)}`,
      onClick: () => startBuy(e, o),
    }));
  }
  const allKept = (e, o) => o.tracks.every((id) => ownedMap.has(`${e.url}#${id}`));

  /** Open the Buy sheet for an album or a song. */
  function startBuy(e, o) {
    const rel = (e.manifest.releases || []).find((r) => r.id === o.id || (r.tracks || []).some((t) => t.id === o.id));
    setSheet({
      art: rel?.art || e.manifest.artist?.image || null, seed: o.title,
      title: o.title, body: `${o.kind === "album" ? "Album" : "Song"} by ${nameOf(e)}`,
      secondaryLabel: "Cancel",
      children: <BuyForm offer={o} onCard={(gift) => buyByCard(e, o, gift)} onWallet={(gift) => buyByWallet(e, o, gift)} />,
    });
  }

  /** By card: to Stripe's page, carrying this wallet, and back to claim it. */
  async function buyByCard(e, o, gift) {
    const who = await ensureWallet();
    rememberCheckout(originOf(e.url), o.id, gift);
    const link = new URL(o.card);
    link.searchParams.set("client_reference_id", who.publicKey.toBase58());
    location.href = link.toString();
  }

  /** In USDC: from this wallet straight to the artist, with a note saying what for. */
  async function buyByWallet(e, o, gift) {
    const block = !pair ? "nowallet"
      : mismatch({ network: o.wallet.network }) ? "mismatch"
      : balance && !(balance.usdc - owedAll >= o.price) ? "empty"
      : balance && !(balance.sol > 0.001) ? "nosol" : null;
    if (block) {
      setSheet(refusalSheet({ kind: block, message: block === "mismatch" ? mismatch({ network: o.wallet.network }) : "", name: nameOf(e) }, {
        money, go: { you: () => goYou(), topUp: () => goYou("topup"), retry: () => startBuy(e, o) },
      }));
      return;
    }
    setSheet({ title: "Paying…", body: `${money(o.price)} to ${nameOf(e)}`, icon: <Icon.card size={22} />, secondaryLabel: "Hide" });
    let tx;
    try {
      const { pay } = await machinery();
      ({ signature: tx } = await pay.payArtist(pair, o.wallet.recipients, toMicros(o.price), { artistName: nameOf(e), memo: purchaseMemo(e, o.id) }));
    } catch (err) {
      setSheet(null);
      flash({ bad: true, text: err.kind === "network" ? "Couldn't reach the network, so nothing was sent." : err.message || "The payment didn't go through, so nothing was sent." });
      return;
    }
    refresh();
    keepUnclaimed({ url: e.url, tx, item: o.id, gift });
    const r = await claimWalletPatiently(pair, e, tx, o.id, gift);
    if (r.outcome === "recorded") { dropUnclaimed(tx); return bought(e, r); }
    if (r.outcome === "refused") { dropUnclaimed(tx); setSheet(null); flash({ bad: true, text: r.error || "The artist's server didn't accept that payment." }); return; }
    setSheet(null);
    flash({ text: `Paid. ${nameOf(e)}'s server is still confirming — it'll arrive shortly.` });
  }

  /** A purchase confirmed: a gift link to send, or the songs to keep. */
  function bought(e, r) {
    if (r.gift) return giftSheet(e, r.gift, offerFor(e, r.item)?.title || titleOfItem(e, r.item));
    return keepSongs(e, tracksOfItem(e, r.item), titleOfItem(e, r.item));
  }
  const tracksOfItem = (e, item) => {
    for (const r of e.manifest.releases || []) {
      if (r.id === item) return (r.tracks || []).map((t) => t.id);
      if ((r.tracks || []).some((t) => t.id === item)) return [item];
    }
    return [];
  };
  const titleOfItem = (e, item) => {
    for (const r of e.manifest.releases || []) {
      if (r.id === item) return r.title;
      const t = (r.tracks || []).find((x) => x.id === item);
      if (t) return t.title;
    }
    return "Your music";
  };

  /**
   * Download songs this wallet owns into the app, as owned local songs, then
   * offer to save a copy to Files — somewhere that survives deleting the app.
   */
  async function keepSongs(e, ids, title) {
    const origin = originOf(e.url);
    const all = tracksOf(e);
    const kept = [];
    let left = null;
    for (let i = 0; i < ids.length; i++) {
      const t = all.find((x) => x.id === ids[i]);
      if (!t) continue;
      setSheet({ title: `Downloading ${title}`, body: ids.length > 1 ? `${i + 1} of ${ids.length}` : t.title, icon: <Icon.downSmall size={22} />, secondaryLabel: "Hide" });
      try {
        const got = await downloadTrack(pair || await ensureWallet(), origin, t.id);
        left = got.left;
        const rel = (e.manifest.releases || []).find((r) => r.id === t.releaseId);
        const song = await saveOwned(got.file, {
          from: e.url, id: t.id, title: t.title, artist: nameOf(e), album: t.releaseTitle || "Singles",
          track: (rel?.tracks || []).findIndex((x) => x.id === t.id) + 1 || null,
          duration: t.duration, art: t.art, colors: t.colors, waves: t.waves,
        });
        kept.push(song.id);
      } catch (err) {
        flash({ bad: true, text: `${t.title}: ${err.message}` });
      }
    }
    await reloadLocal();
    if (!kept.length) { setSheet(null); return; }
    setSheet({
      title: "Yours to keep", icon: <Icon.check size={22} />,
      body: `${title} is in your music, marked owned, and plays free from this phone. Save a copy to Files too, so it's safe if this app is ever deleted.${left != null ? ` (${left} more download${left === 1 ? "" : "s"} of each song if you need them.)` : ""}`,
      primaryLabel: "Save to Files",
      primary: async () => { setSheet(null); await saveCopies(await filesOf(kept), title); },
      secondaryLabel: "Not now",
    });
  }
  /** Save kept songs to Files again, from the album page. */
  async function saveKept(e, ids, title) {
    const keys = ids.map((id) => ownedMap.get(`${e.url}#${id}`)?.id).filter(Boolean);
    await saveCopies(await filesOf(keys), title);
  }

  /** A gift bought: the link to send, which gives it to whoever opens it first. */
  function giftSheet(e, code, title) {
    const url = giftLink(e.url, code);
    setSheet({
      title: "Gift ready", icon: <Icon.heart size={22} />,
      body: `Send this link. Whoever opens it first gets ${title} to keep. It's under You, Purchases, until they do.`,
      mono: url,
      primaryLabel: "Send the link",
      primary: async () => {
        try { if (navigator.share) { await navigator.share({ title: `A gift: ${title}`, url }); setSheet(null); return; } }
        catch (err) { if (err?.name === "AbortError") return; }
        try { await navigator.clipboard.writeText(url); flash({ text: "Link copied" }); } catch { window.prompt("Copy this link:", url); }
      },
      secondaryLabel: "Done",
    });
  }

  // A song's row, swiped: left to like (or unlike), right to queue.
  const likedNow = likes();
  const rowActs = {
    liked: (t) => isLiked(t, likedNow),
    like: (t) => { const on = !isLiked(t); toggleLike(t); redraw(); flash({ text: on ? "Liked" : "Unliked" }); },
    queue: (t) => { player.addToQueue(decorate(t)); flash({ text: "Added to queue" }); },
  };

  function newPlaylist() {
    setSheet({
      title: "New playlist", secondaryLabel: "Cancel",
      children: <AddToPlaylist onPick={() => {}} onCreate={(name) => { const p = createPlaylist(name); setSheet(null); redraw(); go({ coll: { kind: "playlist", id: p.id } }); }} />,
    });
  }
  const toggleTheme = () => { const next = themeName === "dark" ? "light" : "dark"; setTheme(next); setThemeName(next); };
  const nextWave = () => { const next = WAVE_STYLES[(WAVE_STYLES.indexOf(wave) + 1) % WAVE_STYLES.length]; setWaveStyle(next); setWave(next); };

  let screen;
  const collProps = { current: state.track, playing: state.playing, onBack: back, onMore: openMenu,
    onShuffle: (tracks) => { player.setShuffle(true); play(tracks, Math.floor(Math.random() * tracks.length), undefined); } };
  if (ui.add) {
    screen = <AddScreen onBack={back} find={findArtist} follow={followFound} entries={entries}
      onLink={openLink} onImported={reloadLocal} songs={local} onEdit={editLocal}
      />;
  } else if (coll?.kind === "album") {
    const e = byUrl(coll.from);
    const rel = e && (e.manifest.releases || []).find((r) => r.id === coll.rid);
    const rows = rel ? tracksOf(e).filter((t) => t.releaseId === rel.id).map((t) => ({ track: decorate(t), entry: e })) : [];
    screen = <Collection kind="album" title={rel?.title || "Album"} art={rel?.art || null}
      meta={[rel?.artistName || nameOf(e), rel?.date?.slice(0, 4), `${rows.length} songs`].filter(Boolean).join(" · ")}
      rows={rows} {...collProps}
      liked={rows.length > 0 && rows.every((r) => isLiked(r.track, likedNow))}
      buy={(() => {
        const o = e && !e.local && rel && offerFor(e, rel.id);
        if (!o) return null;
        return allKept(e, o) ? { owned: true, onSave: () => saveKept(e, o.tracks, o.title) } : { label: money(o.price), onClick: () => startBuy(e, o) };
      })()}
      onLikeAll={() => {
        const on = !rows.every((r) => isLiked(r.track));
        setLiked(rows.map((r) => r.track), on); redraw();
        flash({ text: on ? "Album liked" : "Album unliked" });
      }}
      onShare={e && !e.local && rel ? () => shareUrl(rel.title, albumLink(e.url, rel.id)) : undefined}
      onReorder={e?.local ? (from, to) => reorderLocal(rows, from, to) : null}
      onCover={e?.local && rel && rows.length && !albumsOf(local).find((a) => a.id === rel.id)?.single ? async (file) => {
        // The album's cover: set on one song, it's every song's (local.js editSong).
        let look;
        try { look = await coverOf(file); } catch { flash({ bad: true, text: "That picture couldn't be read" }); return; }
        await editSong(rows[0].track.id, look).catch(() => flash({ bad: true, text: "Couldn't save that picture" }));
        reloadLocal();
      } : null}
      onPlay={(tracks, i) => { player.setShuffle(false); play(tracks, i, rel?.title); }}
      onShuffle={(tracks) => { player.setShuffle(true); play(tracks, 0, rel?.title); }} />;
  } else if (coll?.kind === "playlist") {
    const pl = lists.find((p) => p.id === coll.id);
    const { rows, missing } = found(pl?.tracks || []);
    screen = <Collection kind="playlist" title={pl?.name || "Playlist"} art={pl?.art || null}
      onCover={pl ? async (file) => {
        let art = null;
        try { art = (await coverOf(file, 400)).art; } catch { flash({ bad: true, text: "That picture couldn't be read" }); return; }
        if (!setPlaylistArt(pl.id, art)) flash({ bad: true, text: "There isn't room to keep that picture" });
        redraw();
      } : null}
      meta={`${rows.length} song${rows.length === 1 ? "" : "s"}`} rows={rows} missing={missing} {...collProps}
      onPlay={(tracks, i) => { player.setShuffle(false); play(tracks, i, pl?.name); }}
      onShuffle={(tracks) => { player.setShuffle(true); play(tracks, 0, pl?.name); }}
      onShare={() => pl && shareList(pl.name, pl.tracks)}
      onRemove={(i) => { removeFromPlaylist(pl.id, i); redraw(); }}
      onReorder={(from, to) => {
        // Rows are the songs still available; the playlist may hold some that aren't.
        const at = (pl?.tracks || []).map((r, i) => (find(r) ? i : -1)).filter((i) => i >= 0);
        movePlaylistTrack(pl.id, at[from], at[to]); redraw();
      }}
      onMenu={() => pl && setSheet({ title: pl.name, secondaryLabel: "Close",
        children: <PlaylistOptions playlist={pl}
          onRename={(name) => { renamePlaylist(pl.id, name); setSheet(null); redraw(); }}
          onRemoveArt={() => { setPlaylistArt(pl.id, null); setSheet(null); redraw(); }}
          onDelete={async () => { if (!(await ask({ title: `Delete ${pl.name}?`, confirm: "Delete", danger: true }))) return; deletePlaylist(pl.id); back(); }} /> })} />;
  } else if (coll?.kind === "shared" && shared) {
    const { rows, missing } = found(shared.tracks);
    screen = <Collection kind="shared" title={shared.name} art={null}
      meta={`${shared.tracks.length} songs · ${shared.artists.length} artist${shared.artists.length === 1 ? "" : "s"}`}
      rows={rows} missing={missing} {...collProps}
      onPlay={(tracks, i) => { player.setShuffle(false); play(tracks, i, shared.name); }}
      onShuffle={(tracks) => { player.setShuffle(true); play(tracks, 0, shared.name); }}
      onSave={() => { const p = createPlaylist(shared.name, shared.tracks); flash({ text: "Saved to your playlists" }); go({ coll: { kind: "playlist", id: p.id } }, { replace: true }); }}
      artists={shared.artists.map((url) => { const e = byUrl(url); return { url, entry: e, followed: !!e && isFollowed(e) }; })}
      onFollow={follow} />;
  } else if (!followed.length && !local.length && tab !== "you" && !entry) {
    screen = <FirstRun onAdd={add} onScan={openAdd} />;
  } else if (entry) {
    screen = (
      <ArtistPage key={`${entry.url}#${fresh}`} entry={entry} ledger={ledger}
        current={state.track} playing={state.playing} onPlay={play}
        onBack={back} onUnfollow={() => drop(entry.url)} onFollow={() => follow(entry.url, true)} followed={isFollowed(entry)} pair={pair}
        onSubscribe={subscribe} onManage={manage} ensureWallet={ensureWallet}
        onClaimed={() => setFresh((n) => n + 1)} toast={flash} onMore={openMenu}
        onOpenAlbum={(from, rid) => go({ coll: { kind: "album", from, rid } })} />
    );
  } else if (tab === "library") {
    screen = <Library entries={followed} localEntry={localEntry} onOpenArtist={setOpen} onAdd={openAdd} lists={lists} liked={liked}
      onOpenPlaylist={(id) => go({ coll: { kind: "playlist", id } })} onNewPlaylist={newPlaylist}
      onOpenAlbum={(from, rid) => go({ coll: { kind: "album", from, rid } })}
      onPlay={play} onMore={openMenu} current={state.track} playing={state.playing} />;
  } else if (tab === "you") {
    screen = (
      <You pair={pair} setPair={setPair} balance={balance} owed={owedAll} onRefresh={refresh}
        entries={entries} onOpenArtist={(u) => go({ open: u })} view={youView} setView={setYouView}
        themeName={themeName} onTheme={toggleTheme}
        purchases={<Purchases pair={pair} entries={entries} owned={ownedMap} onOpenArtist={(u) => go({ open: u })}
          onDownload={(e, ids) => keepSongs(e, ids, titleOfItem(e, ids[0]))}
          onShareGift={(e, code, title) => giftSheet(e, code, title)} />} />
    );
  } else {
    screen = <Home entries={followed} recentTracks={recentTracks} onOpenArtist={setOpen} onPlay={play}
      current={state.track} playing={state.playing} onAdd={openAdd} onMore={openMenu}
      lists={lists} onOpenPlaylist={(id) => go({ coll: { kind: "playlist", id } })} onNewPlaylist={newPlaylist} />;
  }

  return (
    <div class="app">
      <RowSwipe.Provider value={rowActs}><main class="content">{screen}</main></RowSwipe.Provider>

      <div class="dock">
        {lowBalance && !np && (
          <button class="lowbar" onClick={() => goYou("topup")}>
            <span>{money(Math.max(0, balance.usdc - owedAll))} left</span><b>Top up</b>
          </button>
        )}
        <MiniPlayer state={state} player={player} cost={cost} onOpen={() => setNp(true)} />
        <nav class="tabs" aria-label="Sections">
          {[["home", "Home", Icon.home], ["library", "Library", Icon.library], ["you", "You", Icon.you]].map(([id, label, I]) => (
            <button key={id} class={`tab${tab === id && !entry && !coll ? " on" : ""}`} onClick={() => goTab(id)} aria-current={tab === id ? "page" : undefined}>
              <span class="tab-icon"><I size={21} />{id === "you" && needsBackup && <span class="tab-dot" />}</span>
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </div>

      {np && state.track && <NowPlaying state={state} player={player} cost={cost} session={sessionLabel}
        onClose={() => setNp(false)}
        onArtist={() => toArtist(state.track)}
        liked={isLiked(state.track)}
        onLike={() => { toggleLike(state.track); redraw(); }}
        onAddTo={() => pickPlaylist(state.track)}
        onShare={() => shareSong(state.track)}
        onTip={() => setSheet({ title: `Tip ${tipsNow.name}`, icon: <Icon.tip size={22} />, body: "Straight to them. Amply takes nothing.", children: <Tips tips={tipsNow} />, secondaryLabel: "Close" })} viz={viz} tips={tipsNow} wave={wave} onWave={nextWave} />}
      {handoff && <Handoff link={handoff.link} url={handoff.url} onStay={() => { const l = handoff.link; setHandoff(null); openLink(l); }} />}
      <Sheet sheet={sheet} onClose={closeSheet} />
      <Toast toast={toast} />
    </div>
  );
}
