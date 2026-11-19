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
import { loadLibrary, saveLibrary, addArtist, addKnown, removeArtist, followedOnly, isFollowed, setFollowed, noteReach, reachable, CHECK_EVERY_MS, feesCovered } from "./library.js";
import { createPlayer } from "./player.js";
import {
  loadLedger, bank, owing, settle, settleAll, backupSaved, totalOwed, hasWallet, machinery, rateStatus, mismatch, exclusive, payClaim,
} from "./paying.js";
import { agreeRate } from "./spend.js";
import { claimOf, noteClaim, claimDue, wakeClaims } from "./owes.js";
import {
  tokenFor, reportPlayed, reportHeard, originOf, nodePaysFees, audioUrl, isSubscribed, subscriptionUntil, forgetToken,
  manageSubscription, claimSubscription, reportPaid,
} from "./identify.js";
import { perMinute, subscriptionOnly, plans as plansOf } from "../../spec/pricing.mjs";
import { Icon } from "./icons.jsx";
import { money } from "./wallet-ui.jsx";
import { recent, played, forgetRecent, theme, setTheme, waveStyle, setWaveStyle, WAVE_STYLES } from "./looks.js";
import { MiniPlayer, NowPlaying, Tips } from "./playing.jsx";
import { Sheet, Toast, refusalSheet, unpaidSheet, registerAsk, ask } from "./sheets.jsx";
import { FirstRun, Home, Library, ArtistPage, nameOf, RowSwipe } from "./screens.jsx";
import { Collection, trackMenu, AddToPlaylist, PlaylistOptions, EditDetails } from "./collections.jsx";
import {
  likes, isLiked, toggleLike, playlists, createPlaylist, renamePlaylist, deletePlaylist, addToPlaylist,
  removeFromPlaylist, movePlaylistTrack, referenced, shareLink, readShare, ref, forgetSong, setLiked, setPlaylistArt,
  readCode, songLink, albumLink,
} from "./collection.js";
import { You } from "./you.jsx";
import { Onboard } from "./onboard.jsx";
import { AddScreen } from "./add.jsx";
import { createVisualizer } from "./visualizer.js";
import { pageScroll, setPageScroll, scrollToTop } from "./scroll.js";
import { useDesktop, MainPanel, TopBar, Sidebar, PlayerBar, SidePanel, Expanded, useKeys, useVolume } from "./desktop.jsx";
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
import { networkName, NETWORKS } from "./networks.js";

/** How long an answer about an artist's fees account stands while listening. */
const FEES_FRESH_MS = 15 * 60_000;
import { tipsFor, amplyTips, tipBlocked, tipMicros, tipMemo } from "./tips.js";
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
  // On a computer: a sidebar, a player bar, and a panel beside the music.
  const desk = useDesktop();
  const [panel, setPanelState] = useState(() => { try { const p = localStorage.getItem("amply.panel"); return p === "" ? null : p || "np"; } catch { return "np"; } });
  const setPanel = (p) => { setPanelState(p); try { localStorage.setItem("amply.panel", p || ""); } catch { /* fine */ } };
  const youView = ui.you;
  const [, bump] = useState(0);                   // redraw after likes/playlists change
  const [shared, setShared] = useState(null);     // a playlist opened from a link
  const [sheet, setSheetState] = useState(null);
  // Kept in step at once, not at the next render: a payment finishing in the
  // same moment has to see which sheet is up (showOwes).
  const setSheet = (next) => { sheetNow.current = next; setSheetState(next); };
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
  const heardFrom = useRef(new Set());  // artists heard since the last bank
  const holder = useRef(null); holder.current = pair;
  const library = useRef(entries); library.current = entries;
  const funds = useRef(null); funds.current = balance;
  const session = useRef(0);           // micros accrued since the app opened
  const shown = useRef(null);          // the refusal last put in a sheet
  const refusedNow = useRef(null);     // the player's refusal, as of the last render
  const sheetNow = useRef(null);       // the sheet on screen, as of the last render

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
      // Every artist being heard has their page and fees account looked at
      // again now and then (recheckArtists), free tracks included: a paused
      // artist's songs are free, and they must be charged for once they aren't.
      if (track?.from) heardFrom.current.add(track.from);
      if (!track?.from || !track.needsWallet) return;
      // A subscriber has paid by card; charging by the minute too would be twice.
      if (isSubscribed(originOf(track.url))) return;
      pending.current[track.from] = (pending.current[track.from] || 0) + seconds;
      const artist = library.current.find((e) => e.url === track.from);
      const rate = artist && rateOf(artist.manifest);
      if (rate?.perMinute > 0 && feesCovered(artist)) session.current += (seconds / 60) * rate.perMinute * 1e6;
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
        const data = {
          url: track.from, name: nameOf(artist), art: artist?.manifest?.artist?.image || track.art || null,
          // For the sheet that asks a fan with no wallet: what it costs, and whether a card will do.
          rate: (artist && rateOf(artist.manifest)?.perMinute) || null,
          plans: artist ? plansOf(artist.manifest) : [],
        };
        const onlySub = artist && subscriptionOnly(artist.manifest);
        if (!holder.current) throw refuse(onlySub ? "subscribe" : "nowallet", "", data);

        const origin = originOf(track.url);
        let token;
        try { token = await tokenFor(holder.current, origin); }
        catch (e) {
          // Auto-block: their server wants paying first. What it says is
          // owed is kept (owes.js), so it's paid even if the app is closed
          // before the sheet is answered, and survives a reload.
          if (e.unpaid) {
            noteClaim(track.from, e.owes);
            throw refuse("unpaid", e.message, { ...data, owes: e.owes });
          }
          throw refuse(e.subscribe ? "subscribe" : "refused", e.message, data);
        }
        if (!token) throw refuse("offline", "", data);

        // An artist who can't be paid right now (their fees account is
        // empty) is free to hear: no money needed, no price to agree to.
        if (!isSubscribed(origin) && !onlySub && feesCovered(artist)) {
          const rate = artist && rateOf(artist.manifest);
          // Money on the wrong network can't pay this artist, so it can't hear
          // their paid music either — or a test wallet would be free listening.
          const wrong = rate && mismatch(rate);
          if (wrong) throw refuse("mismatch", wrong, data);
          // An empty wallet is no better than none. Only once the balance is
          // known: a slow network is no reason to stop someone who pays.
          const b = funds.current;
          if (b && !(b.usdc > 0)) throw refuse("empty", "", data);
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
        // The song's own count, for the artist's "most played": nothing about
        // who is kept, so free tracks count too. A paid one is counted only
        // with this wallet's pass. Songs on this phone aren't anyone's.
        if (track.id && /^https:/.test(track.url || "")) {
          const origin = originOf(track.url);
          if (!track.needsWallet) reportHeard(origin, track.id, seconds);
          else if (holder.current) {
            tokenFor(holder.current, origin).catch(() => null)
              .then((token) => token && reportHeard(origin, track.id, seconds, token));
          }
        }
        if (!track.needsWallet || !holder.current) return;
        // Listening that costs nothing isn't reported as listening owed for.
        const artist = library.current.find((e) => e.url === track.from);
        if (!isSubscribed(originOf(track.url)) && !(artist && rateOf(artist.manifest) && feesCovered(artist))) return;
        reportPlayed(holder.current, originOf(track.url), seconds);
      },
    },
  ), []);
  try { if (location.hostname === "localhost") window.__amplyPlayer = player; } catch { /* not a browser */ }
  // A computer's volume slider, and its keys: space, arrows, M, L.
  const volume = useVolume(player);
  useKeys({ player, state, volume, onLike: () => { if (state.track) { toggleLike(state.track); bump((n) => n + 1); } } });

  // ── listening, banked and paid for ────────────────────────────────────────

  useEffect(() => {
    const flush = () => {
      const banked = pending.current;
      const heard = [...heardFrom.current];
      pending.current = {};
      heardFrom.current = new Set();
      if (heard.length) recheckArtists(heard);
      if (!Object.keys(banked).length) return;
      // Onto the ledger as it's stored, which every tab shares: another tab
      // may have banked or paid since this one last looked.
      setLedger(bank(loadLedger(), library.current, banked));
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

  // Each artist being listened to, looked at again every quarter of an hour:
  // their page (a price paused or unpaused, raised or lowered) and whether
  // their fees account can pay. One whose account runs dry stops being
  // charged within minutes; one who fills it starts being paid.
  const recheckArtists = useCallback(async (urls) => {
    const now = Date.now();
    const stale = urls.filter((u) => {
      const e = library.current.find((x) => x.url === u);
      return e && !(now - (e.feesCheckedAt || 0) < FEES_FRESH_MS);
    });
    if (!stale.length) return;
    // Marked as checked first, so a slow answer isn't asked for twice.
    noteFees(stale, null, now);
    const pages = await Promise.all(stale.map((u) => fetchManifest(u).then((r) => r.manifest).catch(() => null)));
    if (pages.some(Boolean)) {
      setEntries((all) => {
        const next = all.map((e) => { const i = stale.indexOf(e.url); return i >= 0 && pages[i] ? { ...e, manifest: pages[i] } : e; });
        saveLibrary(next);
        return next;
      });
    }
    const found = await Promise.all(stale.map((u, i) => {
      const m = pages[i] || library.current.find((x) => x.url === u)?.manifest;
      return m && rateOf(m) ? nodePaysFees(originOf(u), networkName()) : false;
    }));
    noteFees(stale, found, now);
  }, []);
  /** Record whether these artists can be paid (null: only when it was asked). */
  const noteFees = useCallback((urls, found, now = Date.now()) => {
    setEntries((all) => {
      const next = all.map((e) => {
        const i = urls.indexOf(e.url);
        if (i < 0) return e;
        return found ? { ...e, feesPaid: !!found[i], feesCheckedAt: now } : { ...e, feesCheckedAt: now };
      });
      saveLibrary(next);
      return next;
    });
  }, []);

  // A library is a cache of other people's pages (library.js). Check every
  // artist's real page when the app opens, when it comes back after a while,
  // and every few hours while it's open. A page that answers replaces the copy,
  // so removed songs go; one that doesn't is marked, and its songs are hidden
  // until it answers again.
  const checking = useRef(false);
  const lastCheck = useRef(0);
  const checkArtists = useCallback(async () => {
    if (checking.current) return;
    checking.current = true;
    lastCheck.current = Date.now();
    try {
      const checked = await Promise.all(loadLibrary().map(async (e) => {
        try {
          const { manifest } = await fetchManifest(e.url);
          // Checked afresh each time: a domain pointed elsewhere stops vouching.
          const domain = await verifiedDomain(e.url, manifest, e.domain);
          const { domain: _was, ...rest } = e;
          // Whether their node pays the network fee, so paying them needs no SOL.
          const feesPaid = await nodePaysFees(originOf(e.url), networkName());
          return noteReach({ ...rest, manifest, feesPaid, feesCheckedAt: Date.now(), ...(domain ? { domain } : {}) }, true);
        } catch {
          return noteReach(e, false);
        }
      }));
      const byUrl = new Map(checked.map((e) => [e.url, e]));
      // Onto the library as it is now: someone may have followed or unfollowed
      // an artist while the pages were loading.
      setEntries((now) => {
        const merged = now.map((e) => (byUrl.has(e.url) ? { ...byUrl.get(e.url), followed: e.followed } : e));
        saveLibrary(merged);
        return merged;
      });
    } finally {
      checking.current = false;
    }
  }, []);
  useEffect(() => {
    checkArtists();
    const back = () => {
      if (document.visibilityState === "visible" && Date.now() - lastCheck.current > CHECK_EVERY_MS) checkArtists();
    };
    document.addEventListener("visibilitychange", back);
    const t = setInterval(checkArtists, CHECK_EVERY_MS);
    return () => { document.removeEventListener("visibilitychange", back); clearInterval(t); };
  }, [checkArtists]);

  // A wallet that exists is loaded quietly. Nobody without one ever fetches
  // the payment libraries.
  useEffect(() => {
    if (!hasWallet() || pair) return;
    machinery().then(({ wallet }) => {
      try { setPair(wallet.loadWallet()); } catch (e) { flash({ bad: true, text: e.message }); }
    });
  }, []);

  const lastBalance = useRef(null);
  const refresh = useCallback(async () => {
    if (!pair) return;
    const { wallet } = await machinery();
    try {
      const next = await wallet.balances(pair);
      // Money bought on Stripe's page arrives while the fan is away: say so
      // when it lands, rather than quietly changing a number.
      const was = lastBalance.current;
      const arrived = was && next.usdc > was.usdc + 0.001;
      if (arrived) flash({ text: `${money(next.usdc - was.usdc)} has arrived. Paid songs will play now.` });
      lastBalance.current = next;
      setBalance(next);
      // Money arrived: whatever was waiting for it is tried now, not at the
      // end of its back-off.
      if (arrived) { funds.current = next; retryAt.current = 0; wakeClaims(["funds"]); settleRef.current?.(); }
    }
    catch { setBalance(null); flash({ bad: true, text: "Couldn't check your wallet" }); }
  }, [pair]);
  useEffect(() => { refresh(); }, [pair, refresh]);
  // Coming back from Stripe's page is coming back to this tab: look again.
  useEffect(() => {
    const back = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, [refresh]);

  /**
   * Pay whoever is due: at the artist's amount, or a week after listening.
   *
   * One payment at a time. Listening is banked every few seconds, and each
   * time the debt is looked at again; a payment takes that long and more to
   * confirm, and until it does the debt is still on the books. Without this,
   * the same debt would be sent a second time while the first was on its way.
   * After a failure it waits a minute before trying again; one that may
   * still have gone through is looked up on the network before anything more
   * is sent (paying.js), so it can't be paid twice.
   *
   * An artist whose server has refused this wallet until it pays (Auto-block,
   * owes.js) is paid what that server says, here too, as its own back-off
   * allows: that back-off is kept on the device, so closing the app or
   * reloading it doesn't lose it, and nothing about it ever gives up.
   */
  const retryAt = useRef(0);
  /** The artist whose "paused your listening" sheet is open, if any. */
  const owesView = useRef(null);
  /** Pay, through the one lock every payment for listening goes through. */
  const payWith = (job) => exclusive(job);
  const claimOptions = () => ({
    report: reportPaid,
    // Asking for a pass again, after paying: a refusal says what's still owed.
    token: async (origin) => {
      forgetToken(origin);
      const t = await tokenFor(holder.current, origin);
      if (!t) throw new Error("Their streaming service isn't answering. Amply will ask again shortly.");
      return t;
    },
    balanceMicros: funds.current && Number.isFinite(funds.current.usdc) ? Math.floor(funds.current.usdc * 1e6) : null,
  });
  const settleNow = useCallback(async () => {
    if (!pair) return;
    const now = Date.now();
    const anyClaim = library.current.some((e) => claimDue(claimOf(e.url), now));
    if (now < retryAt.current && !anyClaim) return;
    // One tab at a time, and one payment at a time in this tab: each tab has
    // its own copy of the page, but the debt is one, stored where they all
    // see it. Read afresh inside the lock.
    const result = await payWith(() => settleAll(pair, library.current, loadLedger(), { ...claimOptions(), fromLedger: now >= retryAt.current }));
    if (!result) return;                       // already paying, here or in another tab
    // What's stored is the truth: taken off what was owed as it stood then,
    // so listening banked meanwhile (here or elsewhere) still counts.
    setLedger(loadLedger());
    if (result.paid.length || result.failed.length) refresh();
    // A minute before trying again after a failure. The loop below comes back
    // to it then, whether or not anything is being listened to.
    const ledgerFailed = result.failed.filter((f) => !f.claim);
    if (ledgerFailed.length) retryAt.current = Date.now() + 60_000;
    if (result.paid.length) {
      const first = result.paid[0];
      const total = result.paid.reduce((n, p) => n + p.usd, 0);
      flash({ text: result.paid.length === 1 ? `Paid ${money(total)} → ${nameOf(first.entry)}` : `Paid ${money(total)} to ${result.paid.length} artists` });
    }
    // Their node said it can't pay the fee: stop charging for them now, not
    // at the next check. What's owed waits for their fees account.
    const refused = result.failed.filter((f) => f.kind === "paused").map((f) => f.entry.url);
    if (refused.length) noteFees(refused, refused.map(() => false));
    for (const c of result.claimed) claimSettled(c.entry, c);
    for (const f of result.failed.filter((x) => x.claim)) claimFailed(f.entry, f);
    // A failure for an artist whose sheet is open is said there instead.
    const loud = result.failed.find((f) => !(f.claim && owesView.current?.url === f.entry.url));
    if (loud) flash({ bad: true, text: loud.message });
  }, [pair, entries, ledger, refresh, noteFees]);
  const settleRef = useRef(null); settleRef.current = settleNow;

  useEffect(() => {
    if (!pair || !entries.some((e) => owing(e, ledger)?.due)) return;
    settleNow();
  }, [ledger, pair]);

  // Not only when listening is banked: a payment that failed, a payment
  // waiting to be seen landing, and every artist who has refused this wallet
  // until it pays are come back to on their own. When the app opens, every
  // half-minute while it's open, when it comes back to the front, when the
  // network comes back, and when money arrives (refresh, above).
  useEffect(() => {
    if (!pair) return;
    const tick = () => {
      const now = Date.now();
      const due = library.current.some((e) => claimDue(claimOf(e.url), now))
        || (now >= retryAt.current && library.current.some((e) => owing(e, loadLedger())?.due));
      if (due) settleRef.current?.();
    };
    const back = () => { if (document.visibilityState === "visible") tick(); };
    const online = () => { retryAt.current = 0; wakeClaims(); tick(); };
    tick();
    const t = setInterval(tick, 30_000);
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    window.addEventListener("online", online);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("focus", back);
      window.removeEventListener("online", online);
    };
  }, [pair]);

  // ── an artist who won't play until they're paid (Auto-block) ──────────────

  /** Put the sheet for this artist's claim on screen, in `state`. */
  function showOwes(url, state, extra = {}, { open = false } = {}) {
    const view = owesView.current;
    if (!view || view.url !== url) return;
    // Only ever replaces its own sheet: one closed, or replaced by another,
    // stays closed (the paying carries on behind it).
    if (!open && sheetNow.current?.owesUrl !== url) { owesView.current = null; return; }
    const claim = claimOf(url);
    const entry = library.current.find((e) => e.url === url);
    view.state = state;
    setSheet({ ...unpaidSheet({
      name: entry ? nameOf(entry) : view.name, art: view.art,
      owes: claim ? Math.max(claim.remaining, 0) : view.owes,
      state, ...extra,
    }, {
      money,
      go: {
        pay: () => payOwes(url),
        topUp: () => { owesView.current = null; goYou("topup"); },
        you: () => { owesView.current = null; goYou(); },
      },
    }), owesUrl: url });
  }
  /** A go at a claim finished (settleAll or the Pay button): say how. */
  function claimSettled(entry, r) {
    const url = entry.url;
    const sum = r.paid.reduce((n, m) => n + m, 0);
    if (r.state === "clear") {
      // Their server has given a pass again: back to the music, if it was
      // waiting for this.
      if (owesView.current?.url === url) { owesView.current = null; setSheet(null); }
      if (refusedNow.current?.kind === "unpaid" && refusedNow.current.url === url) player.retry();
      return;
    }
    const state = r.state === "ask" ? (r.why === "daily" ? "daily" : "ask")
      : r.state === "owes" ? "ask"
      : r.state === "token" ? "error"
      : r.state;
    showOwes(url, state, { partial: sum > 0, message: r.message || "" });
  }
  function claimFailed(entry, f) {
    showOwes(entry.url, f.kind === "paused" ? "paused" : f.kind === "unconfirmed" ? "unsure" : f.kind === "funds" ? "funds" : "error", { message: f.message });
  }
  /** The Pay button: the listener's own yes to this amount. */
  async function payOwes(url) {
    const entry = library.current.find((e) => e.url === url);
    if (!pair || !entry) return;
    showOwes(url, "paying");
    let r;
    try {
      r = await payWith(() => payClaim(pair, entry, { ...claimOptions(), explicit: true }));
    } catch (e) {
      setLedger(loadLedger());
      if (e.kind === "paused") noteFees([url], [false]);
      if (e.paid?.length) refresh();
      claimFailed(entry, e);
      return;
    }
    // Something else is paying right now (the background loop, or another
    // tab): it will say how it went. Look again shortly in case it was
    // another tab, whose result this one doesn't hear.
    if (!r) { setTimeout(() => settleRef.current?.(), 5_000); return; }
    setLedger(loadLedger());
    const sum = r.paid.reduce((n, m) => n + m, 0);
    if (sum > 0) { refresh(); flash({ text: `Paid ${money(sum / 1e6)} → ${nameOf(entry)}` }); }
    claimSettled(entry, r);
  }
  /** The player was refused for this: open the sheet, and pay at once if the
   *  listener has already agreed to pay this artist. */
  async function openOwes(r) {
    const claim = claimOf(r.url);
    owesView.current = { url: r.url, name: r.name, art: r.art, owes: claim?.remaining ?? r.owes };
    // A claim waiting out a back-off is shown as it stands, with its Pay
    // button: the listener can pay now, but tapping play again doesn't
    // hammer anyone. One that's due is paid straight away, if it may be
    // without asking (paying.js settleClaim), and the sheet follows how
    // that goes (claimSettled).
    if (!claimDue(claim)) { showOwes(r.url, sheetStateOf(claim), {}, { open: true }); return; }
    showOwes(r.url, "paying", {}, { open: true });
    await settleRef.current?.();
    // Still "paying" means this go didn't reach it (another was under way,
    // here or in another tab): say what's owed, and look again shortly.
    if (owesView.current?.url === r.url && owesView.current.state === "paying") {
      showOwes(r.url, sheetStateOf(claimOf(r.url)));
      setTimeout(() => settleRef.current?.(), 5_000);
    }
  }
  const sheetStateOf = (claim) => (!claim ? "ask"
    : claim.kind === "paused" ? "paused"
    : claim.kind === "funds" ? "funds"
    : claim.kind === "counting" ? "counting"
    : claim.kind === "unsure" || claim.kind === "unconfirmed" ? "unsure"
    : claim.kind === "ask-daily" ? "daily"
    : "ask");

  // Another tab banked or paid: this one sees it too.
  useEffect(() => {
    const seen = (e) => { if (e.key === null || e.key === "amply.owed.v2") setLedger(loadLedger()); };
    window.addEventListener("storage", seen);
    return () => window.removeEventListener("storage", seen);
  }, []);

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
  refusedNow.current = state.refused;

  // ── a song that can't play opens the sheet that fixes it ──────────────────

  // Going to You from anywhere — Now playing included — shows You.
  const goYou = (view = null) => { setSheet(null); go({ ...BASE, np: false, tab: "you", you: view }); };
  useEffect(() => {
    const r = state.refused;
    if (!r || r === shown.current) return;
    shown.current = r;
    // Their ID first, then money, then the song: one screen, step by step.
    const setup = () => { setSheet(null); needWallet({ needsMoney: true }).then((who) => who && player.retry()); };
    // Their server wants paying first (Auto-block): its own sheet, which
    // pays and then plays on.
    if (r.kind === "unpaid") { openOwes(r); return; }
    const unsaved = pair && !backupSaved(pair.publicKey.toBase58());
    if ((r.kind === "nowallet" && !(r.plans || []).length) || (r.kind === "empty" && unsaved)) { setup(); return; }
    setSheet(refusalSheet(r, {
      money,
      go: {
        setup,
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
    const blocked = tipBlocked(dollars, { hasWallet: !!pair, balance, mismatch: pair ? mismatch(to) : null, feesCovered: !!to.feesPaid });
    if (blocked === "amount") return;
    if (blocked === "nowallet") {
      if (await needWallet({ needsMoney: true })) tip(to, dollars);
      return;
    }
    if (blocked) {
      setSheet(refusalSheet({ kind: blocked, message: pair ? mismatch(to) : "" }, {
        money, go: { you: () => goYou(), topUp: () => goYou("topup") },
      }));
      return;
    }
    const yes = await ask({
      title: `Tip ${to.name} ${money(dollars)}?`,
      body: "Straight to them.",
      confirm: `Send ${money(dollars)}`,
      icon: <Icon.heart size={22} />,
    });
    if (!yes) return;
    try {
      const { pay } = await machinery();
      await pay.payArtist(pair, to.recipients, tipMicros(dollars), {
        artistName: to.name,
        // Marked as a tip, through the artist's node, which pays the fee.
        ...(to.origin ? { memo: tipMemo(to.origin), node: { origin: to.origin, tip: true, extra: { tip: true } } } : {}),
      });
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
      artist: artist.wallet ? (d) => tip({ name, ...artist.wallet, origin: entry ? originOf(entry.url) : undefined, feesPaid: feesCovered(entry) }, d) : null,
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
    // An artist whose server has said what's owed is paid that way, by the
    // loop that keeps at it (settleNow), not from the ledger here as well.
    if (pair && leaving && owing(leaving, ledger) && !claimOf(url)) {
      try {
        // Through the same lock as every other payment: the loop may be part
        // way through paying this very debt, and both would send it.
        const result = await payWith(() => settle(pair, leaving, loadLedger(), { ending: true, report: reportPaid }));
        if (!result) throw new Error("A payment is on its way. Try again in a moment.");
        if (result.refused) throw new Error(typeof result.refused === "string" ? result.refused : result.refused.message || "Payment not allowed");
        setLedger(loadLedger());
        refresh();
      } catch (e) {
        flash({ bad: true, text: `Pay what you owe first: ${e.message}` });
        return;
      }
    }
    // Something still owed that can't go now (their fees account is empty,
    // under a cent, a payment not yet seen landing, or what their server
    // says is owed): keep them known, out of the library, so it's paid when
    // it can be rather than lost.
    if (loadLedger()[url]?.micros > 0 || claimOf(url)) { follow(url, false); back(); return; }
    const next = removeArtist(entries, url);
    setEntries(next);
    saveLibrary(next);
    back();
  }

  // ── subscriptions ─────────────────────────────────────────────────────────

  /**
   * A saved wallet, or the ID screen to make or bring one back (onboard.jsx):
   * nothing is ever made behind the listener's back, and nothing they can lose
   * is kept unsaved. Resolves with the wallet, or null if they backed out.
   * `needsMoney`: what comes next costs money, so the screen ends with adding
   * some.
   */
  const [onboard, setOnboard] = useState(null);
  function needWallet({ needsMoney = false } = {}) {
    if (pair && backupSaved(pair.publicKey.toBase58()) && (!needsMoney || !balance || balance.usdc > 0)) return Promise.resolve(pair);
    return new Promise((done) => setOnboard({ needsMoney, done }));
  }
  const ensureWallet = () => needWallet().then((who) => { if (!who) throw new Error("Save your ID first."); return who; });
  async function subscribe(entry, plan) {
    const who = await needWallet();
    if (!who) return;
    const link = new URL(plan.url);
    link.searchParams.set("client_reference_id", who.publicKey.toBase58());
    location.href = link.toString();
  }
  async function manage(entry) {
    if (!pair) throw new Error("No wallet on this device");
    const back = `https://amply.stream/app/?subscribed=${encodeURIComponent(entry.url)}`;
    location.href = await manageSubscription(pair, originOf(entry.url), back);
  }

  // Back from Coinbase: /app/?added=coinbase. The money is on its way, not
  // here yet; keep looking for a few minutes so it's announced when it lands.
  useEffect(() => {
    let from = null;
    try { from = new URLSearchParams(location.search).get("added"); } catch { /* none */ }
    if (from !== "coinbase") return;
    history.replaceState({ amply: 1, ui: uiRef.current }, "", location.pathname);
    flash({ text: "Coinbase is sending your money. It usually arrives within a few minutes." });
    let n = 0;
    const t = setInterval(() => { refresh(); if (++n >= 12) clearInterval(t); }, 15_000);
    return () => clearInterval(t);
  }, [refresh]);

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
  // Songs are found only on services that answer: an artist that's offline or
  // gone drops out of playlists, likes and history until it's back.
  const byUrl = (url) => (url === LOCAL ? localEntry : entries.find((e) => e.url === url && reachable(e)));

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
    if (t === u.tab && !u.open && !u.coll && !u.you && !u.add) { scrollToTop(); return; }
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
    const who = await needWallet();
    if (!who) return;
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
      : !feesCovered(e) ? "paused" : null;
    if (block === "nowallet" || (block === "empty" && pair && !backupSaved(pair.publicKey.toBase58()))) {
      if (await needWallet({ needsMoney: true })) startBuy(e, o);
      return;
    }
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
      ({ signature: tx } = await pay.payArtist(pair, o.wallet.recipients, toMicros(o.price), { artistName: nameOf(e), memo: purchaseMemo(e, o.id), node: { origin: originOf(e.url), item: o.id } }));
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
    screen = <Collection kind="album" title={rel?.title || "Album"} art={rel?.art || null} tint={rel?.colors?.accent || null}
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
  } else if (coll?.kind === "liked") {
    screen = <Collection kind="liked" title="Liked songs" art={null} likedArt
      meta={`${liked.length} song${liked.length === 1 ? "" : "s"}`} rows={liked} {...collProps}
      onPlay={(tracks, i) => { player.setShuffle(false); play(tracks, i, "Liked songs"); }}
      onShuffle={(tracks) => { player.setShuffle(true); play(tracks, 0, "Liked songs"); }} />;
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
        onSetUp={() => needWallet()}
        entries={entries} onOpenArtist={(u) => go({ open: u })} view={youView} setView={setYouView}
        themeName={themeName} onTheme={toggleTheme}
        purchases={<Purchases pair={pair} entries={entries} owned={ownedMap} onOpenArtist={(u) => go({ open: u })}
          onDownload={(e, ids) => keepSongs(e, ids, titleOfItem(e, ids[0]))}
          onShareGift={(e, code, title) => giftSheet(e, code, title)} />} />
    );
  } else {
    screen = <Home entries={followed.filter(reachable)} recentTracks={recentTracks} onOpenArtist={setOpen} onPlay={play}
      current={state.track} playing={state.playing} onAdd={openAdd} onMore={openMenu}
      lists={lists} onOpenPlaylist={(id) => go({ coll: { kind: "playlist", id } })} onNewPlaylist={newPlaylist} />;
  }

  const onTip = () => setSheet({ title: `Tip ${tipsNow.name}`, icon: <Icon.tip size={22} />, body: "Straight to them. Amply takes nothing.", children: <Tips tips={tipsNow} />, secondaryLabel: "Close" });
  const overlays = <>
    {handoff && <Handoff link={handoff.link} url={handoff.url} onStay={() => { const l = handoff.link; setHandoff(null); openLink(l); }} />}
    <Sheet sheet={sheet} onClose={closeSheet} />
    {onboard && (
      <Onboard pair={pair} needsMoney={onboard.needsMoney} balance={balance} network={NETWORKS[networkName()]}
        onPair={(p) => { setPair(p); }}
        onDone={(p) => { setOnboard(null); refresh(); onboard.done(p); }}
        onClose={() => { setOnboard(null); onboard.done(null); }} />
    )}
    <Toast toast={toast} />
  </>;

  if (desk) {
    const t = state.track;
    const here = entry ? entry.url : coll?.kind === "playlist" ? `pl:${coll.id}` : coll?.kind === "liked" ? "liked" : null;
    const artistNow = t && !t.local ? byUrl(t.from) : null;
    const showPanel = panel && !np;
    return (
      <div class={`app d-app${showPanel ? " with-panel" : ""}`}>
        <Sidebar tab={tab} onTab={goTab} here={here} entries={followed} lists={lists} liked={liked.length} localEntry={localEntry}
          onOpenArtist={setOpen} onOpenPlaylist={(id) => go({ coll: { kind: "playlist", id }, open: null, np: false })}
          onOpenLiked={() => go({ coll: { kind: "liked" }, open: null, np: false })} onOpenLocal={() => goTab("library")}
          onNewPlaylist={newPlaylist} onAdd={openAdd} playingFrom={t?.from} playing={state.playing} needsBackup={needsBackup} />
        <MainPanel screenKey={screenKey}
          top={<TopBar onAdd={add} depth={ui.depth} themeName={themeName} onTheme={toggleTheme} balance={balance} pair={pair}
            onYou={() => goYou()} needsBackup={needsBackup} low={lowBalance} />}>
          <RowSwipe.Provider value={rowActs}>{screen}</RowSwipe.Provider>
        </MainPanel>
        {showPanel && (
          <SidePanel mode={panel} state={state} player={player} artist={artistNow} liked={!!t && isLiked(t)}
            onLike={() => { toggleLike(t); redraw(); }} onArtist={() => t && toArtist(t)}
            followed={!!artistNow && isFollowed(artistNow)} onFollow={() => artistNow && follow(artistNow.url, true)}
            onClose={() => setPanel(null)} onAddTo={() => pickPlaylist(t)} onShare={() => shareSong(t)}
            onTip={onTip} tips={tipsNow} onPlayAt={(k) => player.jump(k)} />
        )}
        <PlayerBar state={state} player={player} viz={viz} cost={cost} liked={!!t && isLiked(t)}
          onLike={() => { if (t) { toggleLike(t); redraw(); } }} onArtist={() => t && toArtist(t)}
          onAlbum={() => t && t.releaseId && openAlbum(t.from, t.releaseId)}
          panel={showPanel ? panel : null} onPanel={(p) => { if (np) setNp(false); setPanel(panel === p && !np ? null : p); }}
          expanded={np} onExpand={() => setNp(!np)} volume={volume} />
        {np && t && <Expanded state={state} player={player} viz={viz} cost={cost} wave={wave} onWave={nextWave}
          onClose={() => setNp(false)} onArtist={() => toArtist(t)} liked={isLiked(t)}
          onLike={() => { toggleLike(t); redraw(); }} onAddTo={() => pickPlaylist(t)} onShare={() => shareSong(t)}
          onTip={onTip} tips={tipsNow} session={sessionLabel} onPlayAt={(k) => player.jump(k)} />}
        {overlays}
      </div>
    );
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
        onTip={onTip} viz={viz} tips={tipsNow} wave={wave} onWave={nextWave} />}
      {overlays}
    </div>
  );
}
