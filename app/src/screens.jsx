/**
 * The screens: first run, Home, Library, and one artist.
 *
 * There is no catalogue here and never will be. A listener adds an artist by
 * the link or website that artist gave them; everything on these screens comes
 * from artists they chose. See docs/clients.md.
 */
import { useState, useEffect, useRef, useContext } from "preact/hooks";
import { createContext } from "preact";
import { useRowSwipe } from "./gestures.js";
import { ownedCopy } from "./local.js";
import { Icon, Logo } from "./icons.jsx";
import { artStyle, mmss, isNew } from "./looks.js";
import { tracksOf, rateOf } from "./manifest.js";
import { money, SaveBackup } from "./wallet-ui.jsx";
import { backupSaved, mismatch } from "./paying.js";
import { ask, Sheet } from "./sheets.jsx";
import {
  tokenFor, originOf, whatTheyHold, askToBeForgotten, isSubscribed, subscriptionUntil, claimSubscription,
} from "./identify.js";
import { plans as plansOf, perMinute, subscriptionOnly } from "../../spec/pricing.mjs";

// ── shared bits ─────────────────────────────────────────────────────────────

export const nameOf = (entry) => entry?.manifest?.artist?.name || "Artist";
const imageOf = (entry) => entry?.manifest?.artist?.image || null;
const hostOf = (url) => { try { return new URL(url).host; } catch { return ""; } };

/** How an artist is paid, in a few characters. */
export function priceShort(entry) {
  const m = entry.manifest;
  if (isSubscribed(originOf(entry.url))) return "Subscribed";
  const rate = rateOf(m);
  if (perMinute(m) && rate) return `${money(rate.perMinute)}/min`;
  if (subscriptionOnly(m)) return "Subscribers";
  return "Free";
}

/** A song's badge: only when the artist charges, and only what differs. */
export function badgeOf(entry, track) {
  if (track?.local) return { label: track.owned ? "owned" : "local", tone: "" };
  if (track?.ownedCopy || (entry && ownedCopy(entry.url, track?.id))) return { label: "owned", tone: "good" };
  if (!entry) return null;
  const m = entry.manifest;
  const charges = perMinute(m) || plansOf(m).length > 0;
  if (!charges) return null;
  if (!track.needsWallet) return { label: "free", tone: "good" };
  if (isSubscribed(originOf(entry.url))) return { label: "sub", tone: "good" };
  if (perMinute(m)) return { label: `${money(rateOf(m).perMinute)}/min`, tone: "" };
  return { label: "sub", tone: "" };
}

function Badge({ badge }) {
  return badge ? <span class={`badge ${badge.tone}`}>{badge.label}</span> : null;
}

/**
 * What a sideways swipe on a song does, given by the app: `like(track)` for a
 * swipe left, `queue(track)` for a swipe right, `liked(track)` for which heart.
 */
export const RowSwipe = createContext(null);

export function TrackRow({ track, n, entry, current, playing, onPlay, showArtist, onMore, edit, reorder = false }) {
  const on = current && current.id === track.id && current.from === track.from;
  const acts = useContext(RowSwipe);
  const row = useRef(null);
  const [side, setSide] = useState({ side: null, ready: false });
  useRowSwipe(row, {
    on: !!acts && !edit,
    left: () => acts?.like(track),
    right: () => acts?.queue(track),
    onSide: (s, ready) => setSide((was) => (was.side === s && was.ready === ready ? was : { side: s, ready })),
  });
  const liked = acts?.liked(track);
  return (
    <div ref={row} data-reorder={reorder ? "" : undefined} class={`track${on ? " on" : ""}${side.side ? ` swiping ${side.side}` : ""}${side.ready ? " ready" : ""}`}>
      {acts && !edit && (
        <span class="swipe-under" aria-hidden="true">
          <span class="swipe-queue"><Icon.queue size={19} /></span>
          <span class="swipe-like">{liked ? <Icon.heartOn size={19} /> : <Icon.heart size={19} />}</span>
        </span>
      )}
      <div class="track-slide">
      <button class="track-main" onClick={onPlay}>
        {n != null
          ? <span class="n">{on && playing ? <span class="bars" aria-hidden="true"><i /><i /><i /></span> : n}</span>
          : <span class="art s44" style={artStyle(track.art, track.releaseTitle || track.title)} />}
        <span class="t">
          <b>{track.title}</b>
          {showArtist && <span>{track.artistName || nameOf(entry)}</span>}
        </span>
        {!edit && <Badge badge={badgeOf(entry, track)} />}
        {!edit && n != null && <span class="d">{mmss(track.duration)}</span>}
      </button>
      {edit ? (
        <span class="track-edit">
          <button class="warn-ink" onClick={edit.remove} aria-label="Remove"><Icon.close size={15} /></button>
        </span>
      ) : onMore && (
        <button class="icon-btn dim more-btn" onClick={onMore} aria-label={`More for ${track.title}`}><Icon.more size={19} /></button>
      )}
      </div>
    </div>
  );
}

function Header({ title, onAdd }) {
  return (
    <div class="head">
      <h1>{title}</h1>
      {onAdd && <button class="circle-btn" onClick={onAdd} aria-label="Add an artist"><Icon.plus size={18} /></button>}
    </div>
  );
}

// ── first run ───────────────────────────────────────────────────────────────

export function FirstRun({ onAdd, onScan }) {
  return (
    <div class="first">
      <Logo size={40} />
      <h1>Add your first<br />artist.</h1>
      <p class="dim">Artists run their own streaming service. You pay them directly.</p>
      <AddForm onAdd={onAdd} autoFocus={false} />
      <button class="scan-cta" onClick={onScan}><Icon.qr size={22} /><span>Scan a QR code</span></button>
      <span class="mono-dim first-foot">No account. Nothing to sign up for.</span>
    </div>
  );
}

/** A link or a website. Typing a domain is how verified artists are found. */
export function AddForm({ onAdd, autoFocus = true }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await onAdd(value); setValue(""); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return (
    <form class="add-form" onSubmit={submit}>
      <label class="input-row">
        <Icon.globe size={18} />
        <input type="text" inputMode="url" autocapitalize="off" autocorrect="off" spellcheck={false}
          value={value} disabled={busy} autoFocus={autoFocus}
          placeholder="Link or website" aria-label="An artist's link or website"
          onInput={(e) => setValue(e.target.value)} />
      </label>
      <button class="btn-primary wide" disabled={busy || !value.trim()}>
        {busy ? <span class="bars" aria-hidden="true"><i /><i /><i /></span> : "Add"}
      </button>
      {error && <p class="note-line warn-ink" role="alert">{error}</p>}
    </form>
  );
}

// ── home ────────────────────────────────────────────────────────────────────

export function Home({ entries, recentTracks, onOpenArtist, onPlay, current, playing, onAdd, onMore, lists, onOpenPlaylist, onNewPlaylist }) {
  // Each followed artist's latest release, newest first.
  const latest = entries.flatMap((e) => {
    const rels = (e.manifest.releases || []).filter((r) => (r.tracks || []).length);
    if (!rels.length) return [];
    const r = rels.slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))[0];
    return [{ entry: e, release: r }];
  }).sort((a, b) => String(b.release.date || "").localeCompare(String(a.release.date || "")));

  return (
    <div class="screen">
      <Header title="Home" onAdd={onAdd} />
      {latest.length > 0 && <>
        <span class="label pad">LATEST</span>
        <div class="hscroll">
          {latest.map(({ entry, release }) => (
            <button class="card-art" key={`${entry.url}#${release.id}`} onClick={() => onOpenArtist(entry.url)}>
              <span class="art s152" style={artStyle(release.art, release.title)}>
                {isNew(release.date) && <span class="new">NEW</span>}
              </span>
              <b>{release.title}</b>
              <span>{nameOf(entry)}</span>
            </button>
          ))}
        </div>
      </>}

      {recentTracks.length > 0 && <>
        <span class="label pad">RECENT</span>
        <div class="list">
          {recentTracks.map(({ track, entry }, i) => (
            <TrackRow key={`${track.from}#${track.id}`} track={track} entry={entry} showArtist
              current={current} playing={playing}
              onPlay={() => onPlay(recentTracks.map((r) => r.track), i, "Recent")} onMore={() => onMore(track)} />
          ))}
        </div>
      </>}

      <span class="label pad">PLAYLISTS</span>
      <div class="hscroll">
        {lists.map((p) => (
          <button class="card-art small" key={p.id} onClick={() => onOpenPlaylist(p.id)}>
            <span class="art s132" style={artStyle(p.art || null, p.name)}>{!p.art && <span class="art-title">{p.name}</span>}</span>
            {p.art && <b class="card-name">{p.name}</b>}
            <span>{p.tracks.length} song{p.tracks.length === 1 ? "" : "s"}</span>
          </button>
        ))}
        <button class="card-new" onClick={onNewPlaylist} aria-label="New playlist"><Icon.plus size={20} /><span>New</span></button>
      </div>

      <span class="label pad">ARTISTS</span>
      <div class="hscroll">
        {entries.map((e) => (
          <button class="card-artist" key={e.url} onClick={() => onOpenArtist(e.url)}>
            <span class="art round s84" style={artStyle(imageOf(e), nameOf(e))} />
            <span>{nameOf(e)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── library ─────────────────────────────────────────────────────────────────

const SEG = "amply.library.section.v1", SEGS = ["Playlists", "Songs", "Albums", "Artists"];

export function Library({ entries, localEntry, onOpenArtist, onAdd, lists, liked, onOpenPlaylist, onNewPlaylist, onOpenAlbum, onPlay, onMore, current, playing }) {
  // The section you were in, kept for next time — leaving for another tab or
  // an album and coming back shouldn't reset it.
  const [seg, pickSeg] = useState(() => {
    try { const kept = localStorage.getItem(SEG); if (SEGS.includes(kept)) return kept; } catch { /* storage off */ }
    return lists.length ? "Playlists" : "Artists";
  });
  const setSeg = (s) => { pickSeg(s); try { localStorage.setItem(SEG, s); } catch { /* storage off */ } };
  const albums = [...entries, ...(localEntry ? [localEntry] : [])]
    .flatMap((e) => (e.manifest.releases || []).map((r) => ({ entry: e, release: r })));
  return (
    <div class="screen">
      <Header title="Library" onAdd={onAdd} />
      <div class="segs" role="tablist">
        {SEGS.map((s) => (
          <button key={s} role="tab" aria-selected={seg === s} class={`seg${seg === s ? " on" : ""}`} onClick={() => setSeg(s)}>{s}</button>
        ))}
      </div>
      {seg === "Playlists" && (
        <div class="list">
          {lists.map((p) => (
            <button class="row-item" key={p.id} onClick={() => onOpenPlaylist(p.id)}>
              <span class="art s50" style={artStyle(p.art || null, p.name)} />
              <span class="t"><b>{p.name}</b><span class="mono-dim">{p.tracks.length} songs</span></span>
            </button>
          ))}
          <button class="row-item dim-row" onClick={onNewPlaylist}>
            <span class="art s50 dashed"><Icon.plus size={18} /></span>
            <span class="t"><b>New playlist</b></span>
          </button>
        </div>
      )}
      {seg === "Songs" && (
        <div class="list">
          {liked.map(({ track, entry }, i) => (
            <TrackRow key={`${track.from}#${track.id}`} track={track} entry={entry} showArtist current={current} playing={playing}
              onPlay={() => onPlay(liked.map((l) => l.track), i, "Liked")} onMore={() => onMore(track)} />
          ))}
          {!liked.length && <p class="dim pad"><Icon.heart size={15} /> Songs you like show up here.</p>}
        </div>
      )}
      {seg === "Albums" && (
        <div class="grid2">
          {albums.map(({ entry, release }) => (
            <button class="card-art" key={`${entry.url}#${release.id}`} onClick={() => onOpenAlbum(entry.url, release.id)}>
              <span class="art sq" style={artStyle(release.art, release.title)} />
              <b>{release.title}</b>
              <span>{release.artistName || nameOf(entry)}{entry.local && <span class="badge">local</span>}</span>
            </button>
          ))}
        </div>
      )}
      {seg === "Artists" && (
        <div class="list">
          {entries.map((e) => (
            <button class="row-item" key={e.url} onClick={() => onOpenArtist(e.url)}>
              <span class="art round s50" style={artStyle(imageOf(e), nameOf(e))} />
              <span class="t">
                <b>{nameOf(e)}</b>
                {e.domain
                  ? <span class="mono good-ink"><Icon.check size={11} /> {e.domain}</span>
                  : <span class="mono warn-ink"><Icon.warn size={11} /> no website</span>}
              </span>
              <span class="mono-dim">{priceShort(e)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── one artist ──────────────────────────────────────────────────────────────

const lengthOf = (months) => (months === 12 ? "/ year" : `/ ${months} mo`);

/**
 * Paying by card for a stretch of time. The subscription belongs to this
 * app's wallet — only as an ID, it needs no money — so its key is saved first.
 */
function Subscribe({ entry, pair, onSubscribe, onManage, ensureWallet, onClaimed, toast }) {
  const plans = plansOf(entry.manifest);
  const origin = originOf(entry.url);
  const [, redraw] = useState(0);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(null);

  useEffect(() => {
    if (!pair || !plans.length) return;
    tokenFor(pair, origin).catch(() => {}).finally(() => redraw((n) => n + 1));
  }, [pair, entry.url]);

  if (!plans.length) return null;
  const subscribed = isSubscribed(origin);

  async function go(fn) {
    setBusy(true);
    try { await fn(); } catch (e) { toast({ bad: true, text: e.message }); setBusy(false); }
  }
  async function choose(plan) {
    try {
      const who = pair || await ensureWallet();
      if (backupSaved(who.publicKey.toBase58())) return go(() => onSubscribe(entry, plan));
      setAsking(plan);
    } catch (e) { toast({ bad: true, text: e.message }); }
  }
  async function restore() {
    await go(async () => {
      const r = await claimSubscription(pair, origin);
      if (r.outcome === "recorded") { await tokenFor(pair, origin).catch(() => null); onClaimed?.(); }
      else toast({ bad: true, text: r.outcome === "pending" ? "Not finished yet — try in a minute" : "No payment found for this wallet" });
      setBusy(false);
    });
  }

  if (asking && pair && !subscribed) {
    return (
      <div class="panel stack">
        <b><Icon.key size={16} /> Save your key first</b>
        <SaveBackup pair={pair} cta={`Saved — pay $${asking.price}`} onSaved={() => go(() => onSubscribe(entry, asking))} />
        <button class="btn-quiet" onClick={() => setAsking(null)}>Back</button>
      </div>
    );
  }

  // Subscribed: one line, not a panel — the page already says how you pay.
  if (subscribed) {
    return (
      <div class="sub-line">
        <span class="chip good"><Icon.check size={12} /> Subscribed · until {new Date(subscriptionUntil(origin)).toLocaleDateString()}</span>
        <button class="icon-btn dim" disabled={busy} onClick={() => go(() => onManage(entry))} aria-label="Manage subscription"><Icon.external size={16} /></button>
      </div>
    );
  }

  return (
    <div class="panel">
      <b>Subscribe</b>
      <span class="dim small">Card · no per-minute charge · cancel anytime</span>
      <div class="row">
        {plans.map((p) => (
          <button key={p.months} class="btn-primary sm" disabled={busy} onClick={() => choose(p)}>${p.price} {lengthOf(p.months)}</button>
        ))}
        {pair && (
          <button class="icon-btn dim" disabled={busy} onClick={restore} aria-label="Already paid? Check again" title="Already paid? Check again">
            <Icon.refresh size={17} />
          </button>
        )}
      </div>
    </div>
  );
}

/** What this artist's server keeps about your wallet — see it, or erase it. */
function WhatTheyKeep({ entry, pair, toast }) {
  const [held, setHeld] = useState(null);
  const [busy, setBusy] = useState(false);
  const origin = originOf(entry.url);
  const name = nameOf(entry);

  async function look() {
    setBusy(true);
    try { setHeld(await whatTheyHold(pair, origin)); } catch (e) { toast({ bad: true, text: e.message }); } finally { setBusy(false); }
  }
  async function erase() {
    if (!(await ask({ title: `Erase your data at ${name}?`, body: "Their play totals for your wallet are deleted.", confirm: "Erase", danger: true }))) return;
    setBusy(true);
    try { await askToBeForgotten(pair, origin); setHeld(null); toast({ text: "Erased" }); }
    catch (e) { toast({ bad: true, text: e.message }); } finally { setBusy(false); }
  }
  const h = held?.held;
  return (
    <section class="keep">
      <span class="label">WHAT THEY KEEP</span>
      <p class="dim small">Play totals only — never which songs. Deleted after a year.{" "}
        <a class="link-dim" href={`${origin}/privacy`} target="_blank" rel="noopener">Privacy <Icon.external size={12} /></a></p>
      {held && (h
        ? <p class="mono-box">{h.plays} plays · {Math.round((h.seconds || 0) / 60)} min{h.lastSeen ? ` · last ${new Date(h.lastSeen).toLocaleDateString()}` : ""}{h.servingStopped ? " · stopped serving you" : ""}</p>
        : <p class="mono-box">Nothing.</p>)}
      {pair && (
        <div class="row">
          <button class="pill" disabled={busy} onClick={look}><Icon.eye size={15} /> See it</button>
          <button class="pill warn-ink" disabled={busy} onClick={erase}><Icon.trash size={15} /> Erase</button>
        </div>
      )}
    </section>
  );
}

export function ArtistPage({
  entry, ledger, current, playing, onPlay, onBack, onUnfollow, onFollow, followed, pair,
  onSubscribe, onManage, ensureWallet, onClaimed, toast, onMore, onOpenAlbum,
}) {
  // The artist's photo, tapped: it large, and what they say about themselves.
  const [about, setAbout] = useState(false);
  const [why, setWhy] = useState(false);         // the no-website mark, opened
  // Sharing an artist: their page, which shows as a card with their name and
  // picture in a message, and opens the app from its button.
  async function share() {
    const url = `${new URL(entry.url).origin}/`;
    try { if (navigator.share) { await navigator.share({ title: nameOf(entry), url }); return; } }
    catch (e) { if (e?.name === "AbortError") return; }
    try { await navigator.clipboard.writeText(url); toast({ text: "Link copied" }); }
    catch { window.prompt("Copy this link:", url); }
  }
  const m = entry.manifest;
  const artist = m.artist || {};
  const rate = rateOf(m);
  const all = tracksOf(entry).map((t) => ({ ...t, artistName: nameOf(entry), verified: !!entry.domain }));
  const held = ledger[entry.url];
  const wrong = rate?.perMinute > 0 ? mismatch(rate) : null;
  const charges = perMinute(m) || plansOf(m).length > 0;

  return (
    <div class="screen artist">
      <div class="banner" style={artStyle(artist.banner, nameOf(entry))}>
        <button class="float-btn" onClick={onBack} aria-label="Back"><Icon.back size={18} /></button>
        <div class="banner-actions">
          <button class="float-btn" onClick={share} aria-label={`Share ${nameOf(entry)}`}><Icon.share size={17} /></button>
          {followed
            ? <button class="float-pill" onClick={async () => (await ask({ title: `Unfollow ${nameOf(entry)}?`, confirm: "Unfollow", icon: <Icon.artist size={22} /> })) && onUnfollow()}>Following</button>
            : <button class="float-pill follow" onClick={onFollow}>Follow</button>}
        </div>
      </div>
      <div class="pad">
        <div class="artist-top">
          <button class="art round s76 ring about-btn" style={artStyle(artist.image, nameOf(entry))}
            onClick={() => setAbout(true)} aria-label={`About ${nameOf(entry)}`} />
          <div class="chips artist-price">
            {!isSubscribed(originOf(entry.url)) && <span class="chip solid">{priceShort(entry)}</span>}
            {perMinute(m) && plansOf(m).length > 0 && !isSubscribed(originOf(entry.url)) && <span class="chip">or subscribe</span>}
            {held?.micros > 0 && <span class="chip">owe {money(held.micros / 1e6)}</span>}
          </div>
        </div>
        <div class="artist-title">
          <h1 class="artist-name">{nameOf(entry)}</h1>
          {!entry.domain && (
            <button class={`trust-mark${why ? " on" : ""}`} onClick={() => setWhy(!why)} aria-expanded={why}
              aria-label="No website: what this means"><Icon.warn size={19} /></button>
          )}
        </div>

        {entry.domain
          ? <p class="trust good"><Icon.check size={14} /> <span>{entry.domain}</span></p>
          : why && <p class="trust warn trust-why"><Icon.warn size={14} /> <span>No website — only listen if the artist sent you this link</span></p>}

        <Subscribe entry={entry} pair={pair} onSubscribe={onSubscribe} onManage={onManage}
          ensureWallet={ensureWallet} onClaimed={onClaimed} toast={toast} />

        {wrong && <p class="trust warn"><Icon.warn size={14} /> <span>{wrong}</span></p>}
      </div>
      <Sheet sheet={about && {
        title: nameOf(entry), secondaryLabel: "Close",
        children: (
          <div class="about">
            <span class="art round about-photo" style={artStyle(entry.manifest.artist?.image, nameOf(entry))} />
            {entry.manifest.artist?.bio ? <p>{entry.manifest.artist.bio}</p> : <p class="dim">No description yet.</p>}
          </div>
        ),
      }} onClose={() => setAbout(false)} />

      {(m.releases || []).map((release) => {
        const tracks = all.filter((t) => t.releaseId === release.id);
        return (
          <section class="release" key={release.id}>
            <div class="release-head pad">
              <button class="release-open" onClick={() => onOpenAlbum(entry.url, release.id)}>
                <span class="art s58" style={artStyle(release.art, release.title)} />
                <span class="t">
                  <b>{release.title}</b>
                  <span class="mono-dim">{[release.date?.slice(0, 4), `${tracks.length} song${tracks.length === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}</span>
                </span>
              </button>
              <button class="circle-btn" onClick={() => onPlay(tracks, 0, release.title)} aria-label={`Play ${release.title}`}><Icon.play size={16} /></button>
            </div>
            {tracks.map((t, i) => (
              <TrackRow key={t.id} track={t} n={i + 1} entry={entry} current={current} playing={playing}
                onPlay={() => onPlay(tracks, i, release.title)} onMore={() => onMore(t)} />
            ))}
          </section>
        );
      })}

      <div class="pad">
        {charges && <WhatTheyKeep entry={entry} pair={pair} toast={toast} />}
        <a class="link-dim foot-link" href={entry.url.replace(/\/manifest\.json$/, "")} target="_blank" rel="noopener">
          {entry.domain || hostOf(entry.url)} <Icon.external size={13} />
        </a>
      </div>
    </div>
  );
}
