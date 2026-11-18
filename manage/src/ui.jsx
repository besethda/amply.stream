/**
 * The artist's workspace.
 *
 * It runs in exactly one place: on the artist's own node, behind Cloudflare
 * Access. There is no hosted copy, Amply is not involved in an artist editing
 * their own music, and a second way of doing it would quietly undo that.
 *
 * Three tabs on one page rather than routes, because routing is another thing
 * the node would have to serve and this is one file either way.
 *
 * Talks to an injected `api` adapter rather than fetching directly, so the
 * interface stays testable without a live node.
 */
import { createContext, Fragment, Component } from "preact";
import { useState, useEffect, useCallback, useRef, useMemo, useContext } from "preact/hooks";

/**
 * Work in progress (uploads, resizing, evening out a song's volume), shown in
 * one floating card per job beside the other notices. `start(title)` returns
 * a job: `step(text, fraction?)` says what it's doing now, `done()` clears it.
 */
const Jobs = createContext(null);
const noJob = { step() {}, done() {} };
/**
 * A component that renders again only when one of its props changes (by
 * identity), like preact/compat's memo without pulling in compat.
 */
export function memo(Inner) {
  return class Memo extends Component {
    shouldComponentUpdate(next) {
      const was = this.props;
      for (const k in next) if (next[k] !== was[k]) return true;
      for (const k in was) if (!(k in next)) return true;
      return false;
    }
    render(props) { return <Inner {...props} />; }
  };
}

const useJob = () => { const jobs = useContext(Jobs); return (title) => (jobs ? jobs.start(title) : noJob); };

function JobCard({ job }) {
  const pct = job.pct == null ? null : Math.max(0, Math.min(1, job.pct));
  return (
    <div class="banner job" role="status" aria-live="polite">
      <div class="job-text"><b>{job.title}</b><span>{job.text}{pct != null ? ` ${Math.round(pct * 100)}%` : ""}</span></div>
      <div class={`job-bar${pct == null ? " busy" : ""}`} role="progressbar" aria-valuemin="0" aria-valuemax="100"
        aria-valuenow={pct == null ? undefined : Math.round(pct * 100)}><i style={pct == null ? undefined : `width:${pct * 100}%`} /></div>
    </div>
  );
}
import { validate } from "../../spec/manifest-rules.mjs";
import { charges, SETTLE_WITHIN_DAYS, LISTEN_MIN_MICROS } from "../../spec/pricing.mjs";
import { bareDomain, recordFor, lookup, confirms } from "../../spec/domain.mjs";
import { makeWaves, wavesKey } from "./waves.js";
import { prepareStream, TooLong } from "./stream-copy.js";
import { coverColors } from "./colors.js";
import { shrink, COVER_PX, BANNER_PX } from "./images.js";
import { mayOfferPasskey, createPasskeySeed, restorePasskeySeed, addressOf, publicKeyOf, base58, NoPasskeySecret, signWithSeed } from "../../spec/passkey-wallet.mjs";
import { readTransaction, writeTransaction, base64, keyOf } from "../../node/src/solana-tx.ts";
import { checkFeePayment } from "../../node/src/feepay.ts";
import { SiteEditor } from "./site-editor.jsx";
import { paymentsTo, mergePayments, usdcBalance, NETWORKS } from "./chain.js";
import { coinbaseSolPage, coinbaseCashoutPage, sellMessage, topupUrl } from "../../app/src/topup.js";

export const MAX_UPLOAD = 90 * 1024 * 1024;

/**
 * What the audio pickers offer, as explicit extensions and types.
 *
 * Not "audio/*": phones read the wildcard as "media". iOS opens the photo
 * library and some Android versions open a sound recorder, so an artist trying
 * to upload a song from their phone is only offered pictures. Naming the file
 * types makes both open the Files picker. The list matches what the node
 * accepts (AUDIO_TYPES in node/src/index.ts), so nothing offered here is
 * something the node will then refuse to play.
 */
export const AUDIO_ACCEPT = [
  ".mp3", ".m4a", ".mp4", ".aac", ".ogg", ".oga", ".opus",
  ".flac", ".wav", ".wave", ".aiff", ".aif",
  "audio/mpeg", "audio/mp4", "audio/aac", "audio/ogg", "audio/flac",
  "audio/wav", "audio/x-wav", "audio/aiff", "audio/x-aiff",
].join(",");
const MAX_ART = 8 * 1024 * 1024;

/** How long a song we quote prices against. Long enough to be honest, round
 *  enough to do in your head. */
const TYPICAL_SONG_MIN = 4;
/**
 * The price a new artist starts with: half a cent a minute, about 2¢ for a
 * four-minute song. Several times what a stream pays elsewhere, and still
 * only a few dollars a month for a fan who listens every day.
 */
export const DEFAULT_RATE = 0.005;
/** What a stream typically pays elsewhere, in dollars, for the comparison beside the price. */
const STREAM_PAYS_ELSEWHERE = 0.004;

/** Price input to dollars: a number to the cent, or null for "not for sale". */
export function salePrice(text) {
  const n = Math.round(Number(String(text).replace(/[$,\s]/g, "")) * 100) / 100;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Everything priced to sell in a manifest: albums (with tracks) and songs. */
export function saleItems(manifest) {
  const out = [];
  for (const r of manifest.releases || []) {
    if (!r.tracks?.length) continue;
    if (r.sale?.price) out.push({ item: r.id, title: r.title || "Untitled", price: r.sale.price });
    for (const t of r.tracks) if (t.sale?.price) out.push({ item: t.id, title: t.title || "Untitled", price: t.sale.price });
  }
  return out;
}

/** The manifest with each sale's card link set (or taken away where there is none). */
export function withSaleLinks(manifest, links) {
  const put = (x) => {
    if (!x.sale) return x;
    const { url: _old, ...sale } = x.sale;
    return { ...x, sale: links[x.id] ? { ...sale, url: links[x.id] } : sale };
  };
  return { ...manifest, releases: (manifest.releases || []).map((r) => ({ ...put(r), tracks: (r.tracks || []).map(put) })) };
}

/** Cloudflare-safe, stable, and never reused, ids are permanent once published. */
function makeId(title, taken) {
  const base = (title || "")
    .toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "untitled";
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

function collectIds(manifest) {
  const s = new Set();
  for (const r of manifest.releases || []) {
    s.add(r.id);
    for (const t of r.tracks || []) s.add(t.id);
  }
  return s;
}

const mmss = (sec) =>
  Number.isFinite(sec) ? `${Math.floor(sec / 60)}:${String(Math.floor(sec) % 60).padStart(2, "0")}` : "–";

/** Prices live in the manifest as dollars and read on screen as cents, because
 *  every real rate is a fraction of one. Keep two decimals where they carry
 *  meaning, drop them where they don't: 0.75¢, 2¢, 20¢. */
export function cents(usd) {
  const c = usd * 100;
  if (c === 0) return "free";
  if (c < 10) return `${Number(c.toFixed(2))}¢`;
  return `${Math.round(c)}¢`;
}

/**
 * Whether a file is too heavy to stream well, judged by bitrate rather than by
 * format: a 320kbps MP3 is fine, and a WAV or FLAC of the same song is several
 * times the size for no difference a listener on a phone can hear. What they
 * notice is the wait before it starts and the stalls partway through.
 *
 * 400kbps sits above every lossy format anyone exports and below every
 * lossless one (CD-quality WAV is 1,411kbps, FLAC usually 700 to 1,000).
 */
export const STREAM_KBPS_LIMIT = 400;
const TARGET_KBPS = 256;

export function sizeAdvice(bytes, duration) {
  if (!(bytes > 0) || !(duration > 0)) return null;
  const kbps = (bytes * 8) / duration / 1000;
  if (kbps <= STREAM_KBPS_LIMIT) return null;
  // Decimal megabytes, which is what Finder and most file managers show, so
  // the figure matches the one the artist sees next to their file.
  const mb = (n) => (n / 1e6 >= 10 ? Math.round(n / 1e6) : (n / 1e6).toFixed(1));
  return {
    kbps: Math.round(kbps),
    now: mb(bytes),
    after: mb((duration * TARGET_KBPS * 1000) / 8),
  };
}

// ── small pieces ────────────────────────────────────────────────────────────

/** A labelled field. Its hint, if any, sits behind a ? by the label. */
const Field = ({ label, hint, children }) => (
  <label class="field">
    <span class="field-label">{label}{hint && <> <Help about={String(label).toLowerCase()}>{hint}</Help></>}</span>
    {children}
  </label>
);

const Text = ({ value, onInput, ...rest }) => (
  <input type="text" value={value ?? ""} onInput={(e) => onInput(e.target.value)} {...rest} />
);

function Banner({ kind, children, onDismiss, action }) {
  if (!children) return null;
  return (
    <div class={`banner ${kind}`} role={kind === "error" ? "alert" : "status"}>
      <span>{children}</span>
      {action && <button class="link" onClick={action.run}>{action.label}</button>}
      {onDismiss && <button class="link" onClick={onDismiss}>dismiss</button>}
    </div>
  );
}

/**
 * A question mark that opens its explanation right where it is, and closes it
 * again. The editor is for doing things: what each part is for stays out of
 * the way until it's asked about. `at` links to the fuller reasoning on
 * amply.stream, which can be improved for everybody without anyone rebuilding.
 */
function Help({ about, at, children }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button" class={`why${open ? " on" : ""}`} aria-expanded={open}
        aria-label={open ? "Hide this explanation" : `What's this? ${about}`}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((o) => !o); }}
      >?</button>
      {open && (
        <span class="help" role="note">
          {children || <>{about.charAt(0).toUpperCase()}{about.slice(1)}.</>}
          {at && <> <a href={`https://amply.stream/why#${at}`} target="_blank" rel="noopener">Read more ↗</a></>}
        </span>
      )}
    </>
  );
}

/** A button that confirms it did the thing, then goes quiet again. */
function CopyButton({ text, label, className = "quiet-link", onCopied }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 2000);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      class={`${className}${done ? " done" : ""}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          onCopied?.();
        } catch {
          // Clipboard access can be refused. Select it instead of failing silently.
          window.prompt("Copy this:", text);
          onCopied?.();
        }
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

/** An image you click to replace. Used for the avatar, the banner and cover art. */
function ImagePick({ url, onPick, cls, children, alt }) {
  const ref = useRef(null);
  return (
    <>
      <input
        ref={ref} type="file" accept="image/*" hidden
        onChange={(e) => { const f = e.target.files[0]; e.target.value = ""; if (f) onPick(f); }}
      />
      <button type="button" class={`${cls}${url ? " set" : ""}`} onClick={() => ref.current.click()}>
        {url ? <img src={url} alt={alt || ""} /> : children}
      </button>
    </>
  );
}

/** Shown under a track whose file is too heavy to stream well. A flag, not a
 *  block: the music is up and playable, it is just slow to arrive. */
function SizeWarning({ advice, duration }) {
  return (
    <div class="track-warn">
      <div class="what">
        <strong>This file is too large to stream properly</strong>
        <p>
          It is {advice.now}MB for {mmss(duration)} of music. Listeners will wait for it to
          load, and it may stop partway through while the rest catches up, which breaks the
          listening experience. Saved as an MP3 at {TARGET_KBPS}kbps it would be about{" "}
          {advice.after}MB and sound the same to them.
        </p>
        <p>
          Use a tool like{" "}
          <a href="https://www.audacityteam.org/download/" target="_blank" rel="noopener">
            Audacity
          </a>{" "}
          to make it smaller. It is free: open the file, then choose File, Export Audio, and
          MP3. Then use Replace audio here, and the track keeps its place and its listeners.
        </p>
      </div>
    </div>
  );
}

// ── music ───────────────────────────────────────────────────────────────────

/**
 * Play and pause, drawn rather than typed: a ▶ character sits wherever its
 * font puts it, a little off centre. The triangle is nudged right of the
 * middle on purpose, because it carries its weight on the left and looks off
 * centre when it isn't.
 */
function PlayIcon({ playing = false }) {
  return playing
    ? <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1" width="3" height="10" rx="1" fill="currentColor" /><rect x="7.5" y="1" width="3" height="10" rx="1" fill="currentColor" /></svg>
    : <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 1.2v9.6a.6.6 0 0 0 .9.5l7.2-4.8a.6.6 0 0 0 0-1L4.4.7a.6.6 0 0 0-.9.5Z" fill="currentColor" /></svg>;
}

/** One track's row. Its callbacks are the release's, stable and taking the
 *  track (or its id), so a row redraws only when its own props change. */
const Track = memo(function Track({
  track, first, last, playing, onPlay, onChange: changeTrack, onMove, onRemove, onReplace,
  heavy, warnOpen, onWarn, charging,
}) {
  const onChange = (next) => changeTrack(track.id, next);
  // If the artist charges, every track is paid for unless they make it free —
  // the same rule their server enforces (spec/pricing.mjs). Free is the choice
  // an artist makes, one track at a time; paid is simply what charging means.
  const free = track.free === true;
  const toggleFree = () => {
    const { free: _was, needsWallet: _old, ...rest } = track;
    onChange(free ? rest : { ...rest, free: true });
  };
  // Selling the song on its own, to keep. A dollar to start; the artist sets it.
  const toggleSale = () => {
    const { sale: _was, ...rest } = track;
    onChange(track.sale ? rest : { ...rest, sale: { price: 1 } });
  };
  const ref = useRef(null);
  // Its options open in a panel under the row, the same on a phone and a
  // computer: labelled, full-size, and nothing to hunt for behind a ⋯.
  const [open, setOpen] = useState(false);
  const name = track.title || "this track";
  return (
    <div class={`track-block${open ? " open" : ""}`}>
      <div class="track-row">
        <div class="track-order">
          <button class="icon stack2" disabled={first} onClick={() => onMove(track.id, -1)} aria-label="Move up">▲</button>
          <button class="icon stack2" disabled={last} onClick={() => onMove(track.id, 1)} aria-label="Move down">▼</button>
        </div>
        <button
          class={`play${playing ? " on" : ""}`} onClick={() => onPlay(track)} disabled={!track.url}
          aria-label={playing ? `Pause ${track.title}` : `Play ${track.title}`}
        >
          <PlayIcon playing={playing} />
        </button>
        <Text
          value={track.title} class="track-title" placeholder="Untitled"
          onInput={(v) => onChange({ ...track, title: v })}
        />
        {/* What's set, at a glance: its length, free, a price to keep it, and a
            mark on a heavy file (the reason opens on demand). On a computer they
            sit in the row; on a phone they take a line under the title. */}
        <span class="track-tags">
          <span class="track-dur">{mmss(track.duration)}</span>
          {charging && free && <span class="track-mark" title="Anyone can play this, with or without a wallet">free</span>}
          {track.sale?.price > 0 && <span class="track-mark sale" title="What it costs to buy and keep">${track.sale.price.toFixed(2)}</span>}
          {heavy && (
            <button
              class="warn-toggle" aria-expanded={warnOpen} onClick={() => onWarn(track.id)}
              aria-label={`${track.title || "This track"} is too large to stream properly. ${warnOpen ? "Hide" : "Show"} why.`}
              title="Too large to stream properly"
            >! too large</button>
          )}
        </span>
        <button class={`track-edit-btn${open ? " on" : ""}`} aria-expanded={open}
          aria-label={`${open ? "Close" : "Edit"} ${name}`} onClick={() => setOpen((o) => !o)}>
          <span class="edit-word">{open ? "Done" : "Edit"}</span>
          <span class="edit-icon" aria-hidden="true">{open ? "✓" : "✎"}</span>
        </button>
        <input
          ref={ref} type="file" accept={AUDIO_ACCEPT} hidden
          onChange={(e) => { const f = e.target.files[0]; e.target.value = ""; if (f) onReplace(track.id, f); }}
        />
      </div>

      {open && (
        <div class="track-panel" role="group" aria-label={`Options for ${name}`}>
          {track.sale ? (
            <div class="panel-sale">
              <label class="track-price">
                <span class="label">Price to keep</span>
                <span class="money">$<input type="number" min="0.5" max="1000" step="0.01" value={track.sale.price ?? ""}
                  aria-label={`Price to buy ${name}, in dollars`}
                  onInput={(e) => onChange({ ...track, sale: { ...track.sale, price: salePrice(e.target.value) ?? undefined } })} /></span>
              </label>
              <button class="btn ghost" onClick={toggleSale}>Stop selling</button>
            </div>
          ) : (
            <button class="btn ghost" onClick={toggleSale}>Sell this song</button>
          )}
          {charging && (
            <button
              class="btn ghost" title={free
                ? "Charge for this track at your price, like the rest"
                : "Let anyone play this for nothing, even without a wallet"}
              onClick={toggleFree}
            >{free ? "Charge for this" : "Make free"}</button>
          )}
          <button class="btn ghost" onClick={() => ref.current.click()}>Replace audio</button>
          <button class="btn ghost danger" onClick={() => onRemove(track.id)}>Remove</button>
        </div>
      )}
    </div>
  );
});

/**
 * Upload a song's files in order, with one progress figure for all of them.
 * `required` must arrive or the whole upload fails; any other part that the
 * service refuses (too large for its storage, say) is just left out. Resolves
 * to the set of keys that arrived. `stop` is asked between parts; once it
 * says so, nothing more is sent and Stopped is thrown, carrying what arrived.
 */
export class Stopped extends Error { constructor() { super("stopped"); this.arrived = new Set(); } }

const mb = (bytes) => `${Math.round(bytes / 1048576)} MB`;

export async function sendParts(parts, required, upload, onProgress = () => {}, stop = () => false) {
  const total = parts.reduce((n, [, b]) => n + b.size, 0) || 1;
  const arrived = new Set();
  let sent = 0;
  for (const [k, b] of parts) {
    // Stopped (the release was deleted): send nothing more, and hand back
    // what arrived so it can be taken out again.
    if (stop()) throw Object.assign(new Stopped(), { arrived });
    const before = sent;
    try {
      await upload(k, b, (f) => onProgress((before + f * b.size) / total));
      arrived.add(k);
    } catch (e) {
      if (k === required) throw e;
    }
    sent += b.size;
  }
  return arrived;
}

/** A release and its tracks. Drawn again only when its props change: the
 *  music tab hands it stable callbacks, so playing a song or a toast
 *  appearing doesn't redraw every release. */
const Release = memo(function Release({
  release, node, manifest, art, player,
  onChange, onRemove, upload, notify, sizeOf, charging, deleteObject,
}) {
  const [problems, setProblems] = useState([]);
  // Set when the release is deleted mid-upload: what's still to send isn't,
  // and what already arrived is removed again, rather than left in storage.
  const stopped = useRef(false);
  const sent = useRef(new Set());   // files from uploads cut short by that, to take back
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(0);
  const startJob = useJob();
  const [sizes, setSizes] = useState({});   // track url -> bytes
  const [warnOpen, setWarnOpen] = useState(null);   // track id whose reason is showing
  const asked = useRef(new Set());          // urls already sent a HEAD
  const fileRef = useRef(null);

  const tracks = release.tracks || [];
  const noteSize = (url, bytes) => setSizes((m) => ({ ...m, [url]: bytes }));

  // Tracks uploaded before this session: the node knows their size. One HEAD
  // each, once, and a failure just means no flag rather than a wrong one.
  useEffect(() => {
    if (!sizeOf) return;
    for (const t of tracks) {
      if (!t.url || t.url in sizes || asked.current.has(t.url)) continue;
      asked.current.add(t.url);
      sizeOf(t.url).then((b) => b && noteSize(t.url, b)).catch(() => {});
    }
  }, [tracks.map((t) => t.url).join("|")]);
  // Changes are functions of the release as it is when they land, never of
  // this render's copy: an upload finishing later must not undo what was
  // edited, added or reordered meanwhile.
  const setTracks = (fn) => onChange((cur) => ({ ...cur, tracks: fn(cur.tracks || []) }));

  /**
   * Upload a song, and beside it its waves file (spec/waves.mjs), worked out
   * here from the file in hand while the song uploads. The song is what
   * matters: if the waves can't be made or sent, it goes up without them.
   */
  async function uploadSong(file, duration, job = noJob) {
    const key = `audio/${safeKey(file.name)}`;
    const streamKey = key.replace(/\.[^./]+$/, "") + ".stream.mp3";
    // The most the service stores in one file (25 MB on KV); an older service
    // doesn't say, and then the old ceiling stands.
    const maxFile = node.maxFile || MAX_UPLOAD;
    // Its loudness, and a streaming copy at the common level where it needs
    // one (stream-copy.js), at a bitrate that fits the storage. An original
    // too big to store gets a copy whatever it is. If none can be made, the
    // song goes up as it is.
    const r = await prepareStream(file, duration, {
      maxBytes: maxFile,
      force: file.size > maxFile,
      onStage: (text) => job.step(text),
      onProgress: (f) => job.step("Optimizing for streaming…", f),
    }).catch((e) => { if (e instanceof TooLong) throw e; return null; });
    job.step("Drawing its waveform…");
    const wavesBytes = await makeWaves(file, duration).catch(() => null);
    // Then everything goes up, with one bar for all of it. What listeners
    // play must arrive: the streaming copy when there is one, else the
    // original. With a copy, the original is kept for downloads if it fits.
    // A WAV is ~10 MB a minute, and a service on KV takes 25 MB a file, so a
    // long one is refused there; the song still goes up, and downloads get
    // the copy instead (the node falls back to it).
    const required = r?.blob ? streamKey : key;
    // Nothing is sent that the storage would refuse: an original that doesn't
    // fit is left behind (downloads use the copy), and a song with nothing
    // small enough says so before a byte goes up.
    const parts = [...(r?.blob ? [[streamKey, r.blob]] : []), [key, file],
      ...(wavesBytes ? [[wavesKey(key), new Blob([wavesBytes], { type: "application/octet-stream" })]] : [])]
      .filter(([k, b]) => k === required || b.size <= maxFile);
    const needed = parts.find(([k]) => k === required)[1];
    if (needed.size > maxFile) {
      throw new Error(`It's ${mb(needed.size)}, and your storage takes ${mb(maxFile)} a file. Try a shorter song, or turn on R2 storage in Cloudflare for bigger files.`);
    }
    let arrived;
    try {
      arrived = await sendParts(parts, required, upload, (f) => job.step("Uploading…", f), () => stopped.current);
    } catch (e) {
      if (e instanceof Stopped) for (const k of e.arrived) sent.current.add(k);
      throw e;
    }
    const waves = arrived.has(wavesKey(key)) ? `${node.url}/${wavesKey(key)}` : null;
    const stream = r ? { loudness: Math.round(r.lufs * 10) / 10, ...(r.blob ? { size: r.blob.size, url: `${node.url}/${streamKey}` } : {}) } : null;
    const original = arrived.has(key) ? `${node.url}/${key}` : null;
    if (original) noteSize(original, file.size);
    if (stream?.url) noteSize(stream.url, stream.size);
    return [{
      // Listeners stream the even copy; the original, where it fit, stays for downloads.
      url: stream?.url || original,
      ...(stream?.url && original ? { master: original } : {}),
      ...(stream?.loudness != null ? { loudness: stream.loudness } : {}),
      ...(waves ? { waves } : {}),
    }, arrived];
  }

  /** Put one audio file on the node and hand back a manifest track, and the
   *  files it put in storage. */
  async function ingest(file, taken, label) {
    const title = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
    const job = startJob(label || `Adding “${title}”`);
    let song, keys, duration;
    try {
      job.step("Reading the song…");
      duration = await readDuration(file);
      [song, keys] = await uploadSong(file, duration, job);
    } finally {
      job.done();
    }
    const id = makeId(title, taken);
    taken.add(id);
    return { track: { id, title, duration, ...song }, keys };
  }

  async function addFiles(files) {
    const taken = collectIds(manifest);
    const list = Array.from(files);
    setBusy((n) => n + list.length);
    for (const [n, file] of list.entries()) {
      if (stopped.current) { setBusy((b) => b - 1); continue; }
      try {
        const name = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
        const { track, keys } = await ingest(file, taken, list.length > 1 ? `Song ${n + 1} of ${list.length}: “${name}”` : undefined);
        // Each song joins as soon as it's up, so one that fails later in the
        // batch can't hold back the ones that worked. One that finished just
        // as its release was deleted has nowhere to go: take its files back.
        if (stopped.current) for (const k of keys) sent.current.add(k);
        else setTracks((t) => [...t, track]);
      } catch (e) {
        if (!(e instanceof Stopped)) setProblems((p) => [...p, { key: `${file.name}-${Date.now()}-${n}`, file, message: e.message }]);
      } finally {
        setBusy((b) => b - 1);
      }
    }
    if (stopped.current) cleanUp();
  }

  /** The release is gone: take back what uploads cut short by that left in
   *  storage. Songs that had finished are left alone: a page published since
   *  may still be playing them. */
  function cleanUp() {
    const keys = [...sent.current];
    sent.current.clear();
    for (const k of keys) deleteObject?.(k).catch(() => {});
  }

  function removeRelease() {
    if (busy > 0 && !window.confirm("Songs are still uploading to this release. Delete it anyway? The uploads stop, and what's already uploaded is removed.")) return;
    stopped.current = true;
    onRemove();
  }

  async function retry(problem) {
    setProblems((p) => p.filter((x) => x !== problem));
    await addFiles([problem.file]);
  }

  async function replaceAudio(id, file) {
    const title = tracks.find((t) => t.id === id)?.title || "this song";
    const job = startJob(`Replacing the audio on “${title}”`);
    try {
      setBusy((n) => n + 1);
      job.step("Reading the song…");
      const duration = await readDuration(file);
      const [song, keys] = await uploadSong(file, duration, job);
      if (stopped.current) { for (const k of keys) sent.current.add(k); return; }
      // The id never changes: listeners' saved state keys off it, and this is
      // the same song with a better master, not a new one. The old waves
      // belong to the old audio, so they go even if new ones couldn't be made.
      // By id: the song may have moved since, or been removed (then nothing).
      setTracks((all) => all.map((t) => {
        if (t.id !== id) return t;
        const { waves, master, loudness, ...rest } = t;
        return { ...rest, duration, ...song };
      }));
      notify("ok", `Replaced the audio on “${title}”.`);
    } catch (e) {
      if (!(e instanceof Stopped)) notify("error", `Could not replace that audio: ${e.message}`);
    } finally {
      job.done();
      setBusy((n) => n - 1);
      if (stopped.current) cleanUp();
    }
  }

  const moveTrack = (id, delta) => setTracks((all) => {
    const t = [...all];
    const i = t.findIndex((x) => x.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= t.length) return all;
    [t[i], t[j]] = [t[j], t[i]];
    return t;
  });

  // The tracks' callbacks, the same functions every render (so each Track
  // can skip redrawing), always reaching this render's state.
  const latest = useRef(null);
  latest.current = { player, moveTrack, replaceAudio, setTracks };
  const trackDo = useMemo(() => ({
    play: (t) => latest.current.player.toggle(t),
    move: (id, d) => latest.current.moveTrack(id, d),
    replace: (id, f) => latest.current.replaceAudio(id, f),
    change: (id, next) => latest.current.setTracks((all) => all.map((x) => (x.id === id ? next : x))),
    remove: (id) => { latest.current.player.stopIf(id); latest.current.setTracks((all) => all.filter((x) => x.id !== id)); },
    warn: (id) => setWarnOpen((open) => (open === id ? null : id)),
  }), []);

  return (
    <section class="card release">
      <div class="release-head">
        <ImagePick
          cls="release-art" url={release.art} alt={`${release.title} cover`}
          onPick={(f) => art(f, async (url) => {
            // Its colours (spec/colors.mjs), for listening apps to tint
            // themselves with. A new cover's replace the old one's.
            const colors = await coverColors(f);
            onChange((cur) => {
              const { colors: _old, ...rest } = cur;
              return { ...rest, art: url, ...(colors ? { colors } : {}) };
            });
          })}
        >
          <svg width="19" height="19" viewBox="0 0 18 18" fill="none"
               stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <rect x="1" y="1" width="16" height="16" rx="2.5" />
            <rect x="5.4" y="5.4" width="7.2" height="7.2" rx="1" fill="currentColor" stroke="none" />
          </svg>
          <span>add artwork</span>
        </ImagePick>

        <div class="release-fields">
          <Text
            value={release.title} class="release-title" placeholder="Name this release"
            onInput={(v) => onChange((cur) => ({ ...cur, title: v }))}
          />
          <span class="count">
            {busy > 0
              ? `adding ${busy} file${busy === 1 ? "" : "s"}…`
              : `${tracks.length} track${tracks.length === 1 ? "" : "s"} ready`}
          </span>
        </div>

        <div class="release-side">
          <label class="side-field">
            <span class="label">Released</span>
            <input
              type="date" value={release.date || ""}
              onInput={(e) => { const date = e.target.value || undefined; onChange((cur) => ({ ...cur, date })); }}
            />
          </label>
          <label class="side-field">
            <span class="label">Album price <Help about="the album's price">What the whole album costs to buy and keep, separate from your per-minute price for listening. Leave it empty if it isn't for sale.</Help></span>
            <span class="release-price">
              <span>$</span>
              <input type="number" min="0.5" max="1000" step="0.01" placeholder="None"
                value={release.sale?.price ?? ""} aria-label="Price to buy this album, in dollars"
                onInput={(e) => {
                  const price = salePrice(e.target.value);
                  onChange((cur) => {
                    const { sale: _was, ...rest } = cur;
                    return price ? { ...rest, sale: { ...(cur.sale || {}), price } } : rest;
                  });
                }} />
            </span>
          </label>
        </div>
      </div>

      {!tracks.length && !busy && (
        <p class="release-draft">Add a track, then publish.</p>
      )}

      <ul class="tracks">
        {tracks.map((t, i) => (
          <li class="track" key={t.id}>
            <Track
              track={t} first={i === 0} last={i === tracks.length - 1} charging={charging}
              playing={player.current === t.id && player.playing}
              onPlay={trackDo.play}
              onMove={trackDo.move}
              onReplace={trackDo.replace}
              onChange={trackDo.change}
              onRemove={trackDo.remove}
              heavy={!!sizeAdvice(sizes[t.url], t.duration)}
              warnOpen={warnOpen === t.id}
              onWarn={trackDo.warn}
            />
            {warnOpen === t.id && sizeAdvice(sizes[t.url], t.duration) && (
              <SizeWarning advice={sizeAdvice(sizes[t.url], t.duration)} duration={t.duration} />
            )}
          </li>
        ))}

        {problems.map((p) => (
          <li class="track" key={p.key}>
            <div class="track-row">
              <div class="track-order" />
              <button class="play" disabled aria-hidden="true"><PlayIcon /></button>
              <span class="track-title" style="opacity:.55">{p.file.name}</span>
              <span class="track-dur">–</span>
            </div>
            <div class="track-problem">
              <div class="what">
                <strong>This one didn't finish uploading</strong>
                <p>{p.message.replace(/[.!?]?\s*$/, ".")} Nothing else was affected, the file is still on your computer.</p>
              </div>
              <div class="problem-do">
                <button class="btn sm dark" onClick={() => retry(p)}>Try again</button>
                {/* Or give up on this file, say to add a smaller one instead. */}
                <button class="btn sm ghost" onClick={() => setProblems((all) => all.filter((x) => x !== p))}>Remove</button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      <input
        ref={fileRef} type="file" accept={AUDIO_ACCEPT} multiple hidden
        onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
      />
      <button
        type="button" class={`dropzone${over ? " over" : ""}`}
        onClick={() => fileRef.current.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); addFiles(e.dataTransfer.files); }}
      >
        + Add tracks
      </button>

      <div class="release-foot">
        <button class="link" onClick={removeRelease}>Delete this release</button>
      </div>
    </section>
  );
});

/**
 * What a new artist does, in order, until their music is live: shown at the
 * top of the music tab, which is where they land, rather than anywhere they
 * would have to go looking.
 */
function FirstSteps({ hasMusic, paid, live, url, onSettings, onAdd, folded }) {
  const step = (n, done, title, detail) => (
    <li class={done ? "done" : ""}>
      <span class="n">{done ? "✓" : n}</span>
      <span class="t">{title}{detail && <span class="detail">{detail}</span>}</span>
    </li>
  );
  const list = (
      <ol class="steps">
        {step(1, hasMusic, "Add your music",
          <>Make a release (an album, an EP or a single), then add your songs to it.{" "}
            <button class="quiet-link" onClick={onAdd}>+ Add a release</button></>)}
        {step(2, paid, "Get paid",
          <>Make your wallet with Face ID and add $5 for network fees, or take card subscriptions. Skip it and your music is free.
            <button class="btn ghost sm step-btn" onClick={onSettings}>Open Earnings</button></>)}
        {step(3, live, "Publish",
          <>Press <b>Publish</b> at the top. Nothing is public until you do.</>)}
        {step(4, false, "Share your link",
          <>Send it to people who already listen to you.{" "}
            <CopyButton text={url} label="Copy your link" /></>)}
      </ol>
  );
  const done = [hasMusic, paid, live].filter(Boolean).length;
  if (folded) {
    return (
      <details class="card first-steps folded">
        <summary><b>Getting started</b> <span class="muted small">{done} of 4 done</span></summary>
        {list}
      </details>
    );
  }
  return (
    <section class="card first-steps">
      <h2>Getting started</h2>
      {list}
    </section>
  );
}

/**
 * The moment the checklist ends: music is public, and the one thing left is
 * telling people. Shown until the artist closes it, once per browser.
 */
const SHARED_KEY = "amply.editor.shared";
function YoureLive({ url }) {
  const [gone, setGone] = useState(() => { try { return localStorage.getItem(SHARED_KEY) === "1"; } catch { return false; } });
  if (gone) return null;
  const close = () => { try { localStorage.setItem(SHARED_KEY, "1"); } catch { /* shown again next time */ } setGone(true); };
  return (
    <section class="card first-steps">
      <h2>You're live. Share your link.</h2>
      <p>Put it in your bio, a post or a message.</p>
      <div class="copy-row">
        <CopyButton text={url} label="Copy your link" className="btn sm" />
        <code>{url.replace(/^https:\/\//, "")}</code>
      </div>
      <p><button class="quiet-link" onClick={close}>Done, hide this</button></p>
    </section>
  );
}

/**
 * Songs uploaded before volumes were evened out: measured and, where needed,
 * given a streaming copy now (stream-copy.js), one at a time. The original
 * stays where it is and becomes the song's `master`.
 */
function EvenOut({ manifest, node, update, upload, readAudio, notify }) {
  const [working, setWorking] = useState(null);   // { done, of, pct }
  const startJob = useJob();
  const older = [];
  (manifest.releases || []).forEach((r, ri) => (r.tracks || []).forEach((t, ti) => {
    if (t.loudness === undefined && !t.master && String(t.url || "").startsWith(`${node.url}/audio/`)) older.push([ri, ti, t]);
  }));
  if (!older.length && !working) return null;

  async function go() {
    const changes = new Map();
    let n = 0;
    const job = startJob("Evening out older songs");
    for (const [ri, ti, t] of older) {
      setWorking({ done: n, of: older.length, pct: 0 });
      job.step(`Song ${n + 1} of ${older.length}: “${t.title || "Untitled"}”…`);
      try {
        const key = decodeURIComponent(new URL(t.url).pathname.slice(1));
        const blob = await readAudio(key);
        const file = new File([blob], key.split("/").pop(), { type: blob.type });
        const r = await prepareStream(file, t.duration, {
          onStage: (text) => job.step(`Song ${n + 1} of ${older.length}: ${text}`),
          onProgress: (f) => { setWorking({ done: n, of: older.length, pct: f }); job.step(`Song ${n + 1} of ${older.length}: Optimizing for streaming…`, f); },
        });
        if (r) {
          const loudness = Math.round(r.lufs * 10) / 10;
          if (r.blob) {
            const streamKey = key.replace(/\.[^./]+$/, "") + ".stream.mp3";
            await upload(streamKey, r.blob, (f) => job.step(`Song ${n + 1} of ${older.length}: Uploading…`, f));
            changes.set(`${ri}.${ti}`, { url: `${node.url}/${streamKey}`, master: t.url, loudness });
          } else {
            changes.set(`${ri}.${ti}`, { loudness });
          }
        }
      } catch { /* that one stays as it is */ }
      n++;
    }
    setWorking(null);
    job.done();
    if (!changes.size) { notify("error", "Couldn't even out those songs in this browser. Try again in Chrome on a computer."); return; }
    update({
      ...manifest,
      releases: manifest.releases.map((r, ri) => ({
        ...r, tracks: (r.tracks || []).map((t, ti) => (changes.has(`${ri}.${ti}`) ? { ...t, ...changes.get(`${ri}.${ti}`) } : t)),
      })),
    });
    notify("ok", `Evened out ${changes.size} song${changes.size === 1 ? "" : "s"}. Publish to put it live.`);
  }

  return (
    <section class="card even-out">
      <h2>Even out volume <Help about="evening out volume">Each song is measured and, if it's much quieter or louder than
        most music, listeners get a copy at the usual level, so your songs sit well next to anyone else's. Your original
        file isn't changed; buyers still download it.</Help></h2>
      {working ? (
        <p class="muted">Working on song {working.done + 1} of {working.of}… {Math.round(working.pct * 100)}%</p>
      ) : (
        <>
          <p class="muted">{older.length} song{older.length === 1 ? "" : "s"} uploaded before this was automatic.</p>
          <button class="btn sm" onClick={go}>Even out {older.length === 1 ? "it" : "them"}</button>
        </>
      )}
    </section>
  );
}

function MusicTab({ manifest, node, update, upload, art, notify, player, sizeOf, charging, paid, live, onSettings, readAudio, deleteObject }) {
  const trackCount = (manifest.releases || []).reduce((n, r) => n + (r.tracks?.length || 0), 0);
  // Each release's callbacks, made once per release id, so Release can skip
  // redrawing when nothing of its own changed.
  const latestUpdate = useRef(update);
  latestUpdate.current = update;
  const handlers = useRef(new Map());
  const handlersFor = (id) => {
    let made = handlers.current.get(id);
    if (!made) {
      made = {
        onChange: (change) => latestUpdate.current((m) => ({
          ...m,
          releases: (m.releases || []).map((x) => (x.id === id ? (typeof change === "function" ? change(x) : change) : x)),
        })),
        onRemove: () => latestUpdate.current((m) => ({ ...m, releases: (m.releases || []).filter((x) => x.id !== id) })),
      };
      handlers.current.set(id, made);
    }
    return made;
  };

  const addRelease = () => {
    const taken = collectIds(manifest);
    update({
      ...manifest,
      // Newest first: a new release goes above the ones already there, here,
      // on the artist's page and in the app.
      releases: [{ id: makeId("release", taken), title: "", tracks: [] }, ...(manifest.releases || [])],
    });
  };

  return (
    <>
      <div class="page-head">
        <h1>
          Your music
          <span class="count">
            {trackCount} track{trackCount === 1 ? "" : "s"} in your storage
          </span>
        </h1>
        <button class="btn sm" onClick={addRelease}>+ Add a release</button>
      </div>

      <div class="stack">
        {!live && (
          <FirstSteps hasMusic={trackCount > 0} paid={paid} live={live} url={node.url} onSettings={onSettings} onAdd={addRelease}
            folded={(manifest.releases || []).length > 0} />
        )}
        {live && trackCount > 0 && <YoureLive url={node.url} />}
        {readAudio && <EvenOut manifest={manifest} node={node} update={update} upload={upload} readAudio={readAudio} notify={notify} />}
        {/* By id, and applied to the latest manifest: an upload finishing a
            minute later must land on its own release as it is by then, not
            on whatever now sits at its old position, and not undo edits made
            meanwhile. A release deleted since simply isn't there to change. */}
        {(manifest.releases || []).map((r) => (
          <Release
            key={r.id} release={r} node={node} manifest={manifest} charging={charging}
            upload={upload} art={art} notify={notify} player={player} sizeOf={sizeOf} deleteObject={deleteObject}
            onChange={handlersFor(r.id).onChange} onRemove={handlersFor(r.id).onRemove}
          />
        ))}

        {/* While the steps above are showing, they already say this. */}
        {live && !manifest.releases?.length && (
          <section class="card nothing">
            <h2>No music yet. <Help about="releases">A release is an album, an EP or a single. Make one, add your songs to it, and publish.</Help></h2>
            <button class="btn sm" onClick={addRelease}>+ Add a release</button>
          </section>
        )}
      </div>
    </>
  );
}

// ── settings ────────────────────────────────────────────────────────────────

/**
 * The price control.
 *
 * One step of the slider is exactly one step of the number beside it: a
 * hundredth of a cent per minute. That makes the two inputs the same control
 * seen twice, with no rounding between them, so dragging never lands on a value
 * you cannot type and typing never puts the handle somewhere it cannot sit.
 *
 * Not a curve: at the bottom of one, several steps round to the same displayed
 * price, so the first stretch of travel does nothing. Capped at 5¢ a minute,
 * the range is small enough that linear is simply better. Above that is not a
 * price, it is a dare: 5¢ a minute is about 20¢ a song, roughly fifty times
 * what a stream pays elsewhere.
 */
export const RATE_MAX = 0.05;                 // dollars per minute
const PER_DOLLAR = 10000;                     // steps in a dollar, so 0.01¢ each
export const SLIDER_STEPS = Math.round(RATE_MAX * PER_DOLLAR);   // 500

// Divide rather than multiply by a fraction: 3 * 0.0001 is not 0.0003.
export const fromSlider = (v) => Math.round(v) / PER_DOLLAR;
export const toSlider = (rate) =>
  Math.min(Math.max(Math.round((Number(rate) || 0) * PER_DOLLAR), 0), SLIDER_STEPS);

/**
 * How often a listener pays: every song, or every few.
 *
 * Nobody holds the money in between. The listener's own app keeps a tally of
 * what it owes this artist and, when the tally reaches the threshold, sends it
 * straight from the listener's wallet to the artist's. Batching only means
 * fewer payments for the listener to approve; a Solana transfer costs a small
 * fraction of a cent, so paying every song is affordable too.
 *
 * The manifest stores the threshold in dollars (`settleAt`), because songs vary
 * in length. The editor thinks in songs, which is what the artist chose, and
 * converts at the typical song length. When the price changes, the threshold is
 * recomputed so "every 5 songs" stays every 5 songs.
 */
export const BATCHES = [1, 5, 10];
export const DEFAULT_BATCH = 5;
const SETTLE_MIN = 0.01;
const SETTLE_MAX = 100;

/** The dollar threshold for paying every `songs` songs at `rate` a minute. */
export function settleFor(songs, rate) {
  const usd = Math.round(songs * rate * TYPICAL_SONG_MIN * 100) / 100;
  return Math.min(Math.max(usd, SETTLE_MIN), SETTLE_MAX);
}

/**
 * What one payment's network fee costs, in dollars: about 10,000 lamports (two
 * signatures), which is roughly a tenth of a cent at SOL's late-2026 price of
 * about $90–145. It's paid from the fees account, never from the payment.
 */
export const NETWORK_FEE_USD = 0.001;

/** One payment's size at `songs` a payment, and the fee's share of it. */
export function payoutFee(songs, rate) {
  const payment = settleFor(songs, rate);
  return { payment, share: NETWORK_FEE_USD / payment };
}

/** Which choice a stored threshold corresponds to, nearest wins. */
export function batchOf(wallet) {
  const perSong = (wallet.ratePerMinute ?? 0) * TYPICAL_SONG_MIN;
  if (!(perSong > 0) || !(wallet.settleAt > 0)) return DEFAULT_BATCH;
  const songs = wallet.settleAt / perSong;
  return BATCHES.reduce((best, b) =>
    (Math.abs(Math.log(b / songs)) < Math.abs(Math.log(best / songs)) ? b : best));
}

/** A price change, with the batch kept in songs rather than in dollars. */
export function withPrice(wallet, rate) {
  const next = { ...wallet, ratePerMinute: rate };
  if (rate > 0) next.settleAt = settleFor(batchOf(wallet), rate);
  return next;
}

/**
 * Amply's Stripe App: installing it makes a key with exactly the six
 * permissions below, so an artist copies one key instead of building it. The
 * app lives in stripe-app/. Stripe only gives out a public install link once
 * it has reviewed and published the app; until then this is null and the
 * editor shows the manual steps alone.
 */
const STRIPE_APP_INSTALL = null;

const PLAN_DEFAULTS = [
  { months: 12, price: 10, label: "Yearly" },
  { months: 6, price: 6, label: "Every 6 months" },
  { months: 3, price: 3, label: "Every 3 months" },
];

/**
 * Selling subscriptions by card, through the artist's own Stripe account.
 *
 * Offered instead of the per-minute price, or alongside it; the artist
 * chooses. The Stripe key goes to their own server and stays there — this page
 * never shows it again — and the server sets up everything in Stripe (the
 * product, and a price and a payment link for each plan) and asks Stripe who
 * has paid. Amply is never the seller and never sees the money.
 */
function Subscriptions({ manifest, update, api }) {
  const [status, setStatus] = useState(null);
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [newKey, setNewKey] = useState(false);   // replacing the stored key, e.g. test → live
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState(null);
  const [chosen, setChosen] = useState(() =>
    Object.fromEntries(PLAN_DEFAULTS.map((p) => [p.months, { on: p.months === 12, price: p.price }])));

  useEffect(() => {
    api?.stripeStatus?.().then(setStatus).catch(() => setStatus({ connected: false }));
  }, []);

  const entry = (manifest.payment || []).find((p) => p.type === "stripe-subscription");

  /** Put the plans on the page, or take them off it. Publishing does the rest. */
  const publishPlans = (plans) => {
    const rest = (manifest.payment || []).filter((p) => p.type !== "stripe-subscription");
    update({
      ...manifest,
      payment: plans?.length
        ? [...rest, { type: "stripe-subscription", plans: plans.map(({ months, price, currency, url }) => ({ months, price, currency, url })) }]
        : rest,
    });
  };

  async function go() {
    const plans = PLAN_DEFAULTS
      .filter((p) => chosen[p.months].on)
      .map((p) => ({ months: p.months, price: Number(chosen[p.months].price) }));
    if (!plans.length) return setSaid({ bad: true, text: "Choose at least one plan." });
    if (plans.some((p) => !(p.price >= 2))) return setSaid({ bad: true, text: "Each price needs to be at least $2 — below that, card fees take too much of it." });
    if ((!status?.connected || newKey) && !key.trim()) return setSaid({ bad: true, text: "Paste your Stripe key first." });
    setBusy(true); setSaid(null);
    try {
      const view = await api.connectStripe(key.trim(), plans);
      setStatus(view);
      publishPlans(view.plans);
      setKey("");
      setNewKey(false);
      setEditing(false);
      setSaid({ text: view.live
        ? "Connected. Publish your changes to start selling."
        : "Connected in test mode. Publish, then try it — steps below." });
    } catch (e) {
      setSaid({ bad: true, text: e.message });
    } finally {
      setBusy(false);
    }
  }

  /** Connect the key for selling songs and albums, with no subscription plans. */
  async function salesOnly() {
    if (!key.trim()) return setSaid({ bad: true, text: "Paste your Stripe key first." });
    setBusy(true); setSaid(null);
    try {
      await api.stripeSales(key.trim(), []);
      setStatus(await api.stripeStatus());
      setKey("");
      setSaid({ text: "Connected. Put a price on an album or a song, under Music, then publish." });
    } catch (e) {
      setSaid({ bad: true, text: e.message });
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (!window.confirm("Stop selling subscriptions? Nobody new can subscribe. People already subscribed keep listening, and keep being renewed by Stripe, until they cancel — you can cancel or refund them in Stripe.")) return;
    setBusy(true); setSaid(null);
    try {
      await api.disconnectStripe();
      setStatus(await api.stripeStatus().catch(() => ({ connected: false })));
      publishPlans(null);
      setSaid({ text: "Stopped. Publish your changes to take subscriptions off your page." });
    } catch (e) {
      setSaid({ bad: true, text: e.message });
    } finally {
      setBusy(false);
    }
  }

  const form = (
    <>
      <div class="plans">
        {PLAN_DEFAULTS.map((p) => (
          <label class="plan" key={p.months}>
            <input
              type="checkbox" checked={chosen[p.months].on}
              onChange={(e) => setChosen({ ...chosen, [p.months]: { ...chosen[p.months], on: e.target.checked } })}
            />
            <span class="plan-name">{p.label}</span>
            <span class="plan-price">$
              <input
                type="number" min="2" max="1000" step="1" value={chosen[p.months].price}
                disabled={!chosen[p.months].on}
                aria-label={`${p.label} price in dollars`}
                onInput={(e) => setChosen({ ...chosen, [p.months]: { ...chosen[p.months], price: e.target.value } })}
              />
            </span>
          </label>
        ))}
      </div>

      {status?.connected && !newKey && (
        <p class="muted">
          Using your {status.live ? "live" : "test-mode"} key.{" "}
          <button class="link" onClick={() => setNewKey(true)}>
            {status.live ? "Use a different key" : "Switch to a live key"}
          </button>
        </p>
      )}

      {(!status?.connected || newKey) && (
        <>
          {/* The one-click way: Amply's Stripe App makes a key with exactly
              the permissions below. By hand is the fallback. */}
          {STRIPE_APP_INSTALL && (
            <ol class="stripe-steps">
              <li><a class="btn sm" href={STRIPE_APP_INSTALL} target="_blank" rel="noopener">Install Amply for Artists ↗</a></li>
              <li>In Stripe, choose <strong>View API keys</strong> and copy the key it made.</li>
              <li>Paste it here.</li>
            </ol>
          )}
          <Field
            label={newKey ? "Your new Stripe key" : "Your Stripe key"}
            hint={<>Kept on your streaming service, never shown again; Amply never sees it. Start with a test key
              (<code>rk_test_</code>): nothing real is charged, and you can switch to a live one later.
              {newKey && " Saving replaces your checkout links; people already subscribed stay subscribed."}
              {" "}No Stripe account? <a href="https://dashboard.stripe.com/register" target="_blank" rel="noopener">Make one ↗</a></>}
          >
            <input type="password" value={key} placeholder="rk_test_… or rk_live_…"
              autocomplete="off" spellcheck={false} onInput={(e) => setKey(e.target.value)} />
          </Field>
          {/^pk_/.test(key.trim()) && (
            <p class="warn">That's the <strong>publishable key</strong>. Copy the <strong>secret key</strong> shown
              with it, which starts <code>rk_</code> (Stripe may hide it behind <em>Reveal</em>).</p>
          )}
          {/^(pk|rk|sk)_live_/.test(key.trim()) && !status?.live && !newKey && (
            <p class="muted">That's a <strong>live</strong> key: real payments, and Stripe's test card won't work.</p>
          )}
          {/^sk_/.test(key.trim()) && (
            <p class="warn">That's Stripe's <strong>standard secret key</strong>, which can do anything in your
              account, including paying money out. Please use {STRIPE_APP_INSTALL ? "the Amply for Artists key" : "a key with only the permissions below"} instead.</p>
          )}
          <details class="where-dns">
            <summary>{STRIPE_APP_INSTALL ? "Or make the key by hand" : "How do I make a key?"}</summary>
            <ol>
              <li>Open <a href={newKey || status?.live === false ? "https://dashboard.stripe.com/apikeys" : "https://dashboard.stripe.com/test/apikeys"}
                target="_blank" rel="noopener">API keys ↗</a> and create a restricted key, choosing
                <strong> Building your own integration</strong>.</li>
              <li>Set exactly these, everything else <em>None</em>:
                <table class="perms">
                  <tbody>
                    <tr><td>Products</td><td>Write</td></tr>
                    <tr><td>Payment Links</td><td>Write</td></tr>
                    <tr><td>Prices</td><td>Write</td></tr>
                    <tr><td>Customer portal</td><td>Write</td></tr>
                    <tr><td>Subscriptions</td><td>Read</td></tr>
                    <tr><td>Checkout Sessions</td><td>Read</td></tr>
                    <tr><td>PaymentIntents</td><td>Read (recommended)</td></tr>
                    <tr><td>Charges</td><td>Read (recommended)</td></tr>
                  </tbody>
                </table>
              </li>
              <li>Create it, copy it (it starts <code>rk_</code>) and paste it above. Missed a permission?
                Connecting says which.</li>
            </ol>
          </details>
        </>
      )}

      {!status?.connected && (
        <p class="muted">Only want card payments for songs and albums people buy, no subscriptions?{" "}
          <button class="link" disabled={busy} onClick={salesOnly}>Connect for one-time sales only</button></p>
      )}
      <div class="row-actions">
        <button class="btn sm" disabled={busy} onClick={go}>
          {busy ? "Connecting…" : status?.connected ? "Save plans" : "Connect Stripe"}
        </button>
        {status?.connected && <button class="link" onClick={() => { setEditing(false); setNewKey(false); }}>Cancel</button>}
      </div>
    </>
  );

  return (
    <section class="card">
      <h2>Card subscriptions <span class="note">optional · about 15 minutes in Stripe</span>
        <Help at="subscriptions" about="subscriptions">Fans pay by card, through your own Stripe account, for a year
          or for six or three months of everything you charge for. Subscribers aren't charged by the minute and
          need no crypto wallet. Offer it instead of your per-minute price (set that to free) or alongside it.
          Stripe pays you directly and takes its usual fee; Amply takes nothing.{" "}
          <a href="https://amply.stream/stripe" target="_blank" rel="noopener">Step-by-step guide ↗</a></Help></h2>

      {status && !status.connected && !editing && (
        <p class="muted">Let fans pay by card for a year (or a few months) of your music, through your own free
          Stripe account. Setting it up means copying one key from Stripe, which the{" "}
          <a href="https://amply.stream/stripe" target="_blank" rel="noopener">step-by-step guide ↗</a> walks
          through with pictures.</p>
      )}
      {status === null ? <p class="muted">Checking…</p>
        : status.connected && !editing ? (
          <>
            {!status.plans?.length && <p class="muted">Connected for selling songs and albums. You can add subscription plans too.</p>}
            <ul class="plain">
              {status.plans.map((p) => (
                <li key={p.months}><strong>${p.price}</strong> {p.months === 12 ? "a year" : `every ${p.months} months`}</li>
              ))}
            </ul>
            {!status.live && (
              <details class="try-it">
                <summary>Try it with Stripe's test card</summary>
                <ol>
                  <li>Publish, so the plans are on your page.</li>
                  <li>Open your page in the Amply app and tap a plan.</li>
                  <li>Pay with Stripe's test card: <code>4242 4242 4242 4242</code>, any future date, any three digits.</li>
                  <li>You land back in the app, subscribed. Here, under Listeners, you'll see them as a subscriber.</li>
                </ol>
                <p class="muted">Happy with it? <button class="link" onClick={() => { setEditing(true); setNewKey(true); }}>Switch to a live key</button>{" "}
                  — Stripe will ask you to finish setting up your account first. <a href="https://amply.stream/stripe#live" target="_blank" rel="noopener">How ↗</a></p>
              </details>
            )}
            <p class="muted">
              {status.live ? "Taking real payments." : "Stripe test mode — nothing real is charged."}
              {!status.cancellable && " Your key couldn't set up Stripe's cancellation page; give it Customer portal permission and save again, because subscribers must be able to cancel."}
            </p>
            {!entry && status.plans?.length > 0 && (
              <p class="warn">These aren't on your page yet.{" "}
                <button class="link" onClick={() => publishPlans(status.plans)}>Add them</button>, then publish.</p>
            )}
            <div class="row-actions">
              <button class="btn ghost sm" onClick={() => setEditing(true)}>Change plans</button>
              <button class="link danger" disabled={busy} onClick={stop}>Stop selling subscriptions</button>
            </div>
          </>
        ) : form}

      {status?.winding && !editing && (
        <p class="muted">You've stopped selling subscriptions. Your streaming service still follows the people
          who subscribed before, so their renewals and cancellations count, and lets go of your Stripe key
          once the last one ends.</p>
      )}
      {said && <p class={said.bad ? "warn" : "muted"} role="status">{said.text}</p>}
    </section>
  );
}

/**
 * Real money, or play money.
 *
 * A Solana address is valid on every network, so nothing about a payment
 * reveals which one it happened on: a listener testing against a real release
 * sends tokens that cannot be spent, and both ends see a successful payment.
 * The artist says which they mean, their listeners' apps read it, and one that
 * disagrees pays nothing and says why.
 *
 * Absent means real money, so an artist who never finds this control — which
 * is almost all of them — is asking for the thing they think they are asking
 * for.
 */
function TestMoney({ wallet, onChange }) {
  const testing = wallet.network === "devnet";
  return (
    <div class="test-money">
      <label>
        <input
          type="checkbox" checked={testing}
          onChange={(e) => {
            const { network, ...rest } = wallet;
            onChange(e.target.checked ? { ...rest, network: "devnet" } : rest);
          }}
        />
        <span>Use pretend money for now</span>
      </label>
      {testing && <p class="warn">Test network: nothing anyone sends you is worth anything, and apps set to
        real money pay you nothing. Turn this off before you release.</p>}
    </div>
  );
}

/**
 * Fill in an address from Phantom instead of copying it.
 *
 * Phantom puts a provider on the page when it is installed as a browser
 * extension, or when this page is opened in Phantom's own browser on a phone.
 * Asking it to connect reads the public address and nothing else — no
 * signing, no permissions over the wallet — which is all an artist needs to
 * give to be paid. Where there is no Phantom, the button simply isn't shown.
 */
function FromPhantom({ onAddress }) {
  const provider = typeof window !== "undefined" ? window.phantom?.solana : null;
  const [said, setSaid] = useState(null);
  if (!provider?.isPhantom) return null;

  async function fill() {
    setSaid(null);
    try {
      const { publicKey } = await provider.connect();
      onAddress(publicKey.toString());
      setSaid("Filled in from Phantom.");
    } catch {
      setSaid("Phantom didn't share an address. You can paste it instead.");
    }
  }

  return (
    <span class="from-phantom">
      <button type="button" class="link" onClick={fill}>Use my Phantom address</button>
      {said && <span class="muted"> {said}</span>}
    </span>
  );
}

/**
 * A wallet made from the artist's passkey (spec/passkey-wallet.mjs): Face
 * ID, Touch ID, Windows Hello, or their phone from a computer. Only its
 * address is kept, in the split below. Nothing secret is stored: the passkey
 * makes the key again whenever money has to move, so cashing out asks for
 * Face ID once more. The passkey belongs to this service's own address.
 */
const PASSKEY_WALLET_KEY = "amply.editor.passkey-wallet";
const BACKUP_SAVED_KEY = "amply.editor.backup-saved";

/**
 * A Face ID payout wallet only opens at this editor's own address: the
 * passkey belongs to it. If the address ever changed (a renamed Worker or
 * Cloudflare subdomain), the backup key would be the only way back to the
 * money. So until the artist says they've saved it, Earnings asks.
 */
function BackupReminder({ payees }) {
  const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const made = read(PASSKEY_WALLET_KEY);
  const [saved, setSaved] = useState(() => read(BACKUP_SAVED_KEY) === made);
  if (!made || saved || !payees.some((p) => p.address === made)) return null;
  const done = () => { try { localStorage.setItem(BACKUP_SAVED_KEY, made); } catch { /* asked again next time */ } setSaved(true); };
  return (
    <section class="card backup-reminder">
      <h2>Save your wallet's backup key</h2>
      <p class="muted">Your Face ID wallet only opens at this editor's address. If that address ever changed, this key
        would be the only way back to your money. Save it in a password manager, and nowhere else.</p>
      <ShowWalletKey payees={payees} />
      <button class="btn ghost sm" onClick={done}>I've saved it</button>
    </section>
  );
}

function PasskeyWallet({ onAddress }) {
  const [offer, setOffer] = useState(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState(null);
  useEffect(() => { mayOfferPasskey().then(setOffer); }, []);
  if (offer === null) return null;
  if (!offer) {
    return <p class="warn small">This browser can't make a Face ID wallet. Open your editor on your phone, or paste a
      wallet address below.</p>;
  }

  async function go(seedFn) {
    setBusy(true); setSaid(null);
    try {
      const seed = await seedFn({ name: "Amply payouts" });
      const address = await addressOf(seed);
      seed.fill(0);
      // Remembered so Earnings can ask for its backup key to be saved
      // (BackupReminder): the passkey only works at this editor's address.
      try { localStorage.setItem(PASSKEY_WALLET_KEY, address); } catch { /* the reminder just won't show */ }
      onAddress(address);
      setSaid({ good: true, text: "Wallet ready. Publish to start getting paid." });
    } catch (e) {
      if (e instanceof NoPasskeySecret) {
        setSaid({ text: "This device can't make it. Try again and choose your phone." });
      } else if (e.name !== "Cancelled") setSaid({ text: e.message });
    } finally { setBusy(false); }
  }

  return (
    <div class="passkey-wallet">
      <button class="btn sm" disabled={busy} onClick={() => go(createPasskeySeed)}>
        {busy ? "Waiting for you…" : "Make my wallet with Face ID"}
      </button>
      <p class="muted small">Syncs with your Apple or Google account ·{" "}
        <button class="quiet-link" disabled={busy} onClick={() => go(restorePasskeySeed)}>Made one before?</button></p>
      {said && <p class={said.good ? "good" : "warn"} role="status">{said.text}</p>}
    </div>
  );
}

/**
 * Opening a passkey wallet somewhere else. Until cashing out is built into
 * the editor, an artist moves their money with a wallet app: the passkey
 * makes the key again, and it's shown once, for importing into Phantom or
 * Solflare. The key is checked against Who gets paid first, so the artist
 * knows it's the right wallet, and it's never stored or sent anywhere.
 */
function ShowWalletKey({ payees }) {
  const [state, setState] = useState(null);   // { key, address, ours } | { error }
  const [busy, setBusy] = useState(false);
  // A key left on screen is a key someone else can read: it hides itself.
  useEffect(() => {
    if (!state?.key) return;
    const t = setTimeout(() => setState(null), 2 * 60_000);
    return () => clearTimeout(t);
  }, [state?.key]);

  async function reveal() {
    setBusy(true); setState(null);
    try {
      const seed = await restorePasskeySeed();
      const pub = await publicKeyOf(seed);
      const secret = new Uint8Array(64);
      secret.set(seed); secret.set(pub, 32);
      const address = base58(pub);
      setState({ key: base58(secret), address, ours: payees.some((p) => p.address === address) });
      seed.fill(0); secret.fill(0);
    } catch (e) {
      if (e instanceof NoPasskeySecret) setState({ error: "This device's passkey can't open the wallet. Try again and choose your phone." });
      else if (e.name !== "Cancelled") setState({ error: e.message });
    } finally { setBusy(false); }
  }

  if (!state?.key) {
    return (
      <div class="passkey-wallet">
        <p class="warn small">Treat it like a password: anyone who has it can take your money, and nobody from
          Amply will ever ask for it.</p>
        <button class="btn ghost sm" disabled={busy} onClick={reveal}>{busy ? "Waiting for you…" : "Show my backup key"}</button>
        {state?.error && <p class="warn" role="alert">{state.error}</p>}
      </div>
    );
  }
  return (
    <div class="passkey-wallet">
      <p class={state.ours ? "good" : "warn"}>{state.ours
        ? "This is the payout wallet your listeners pay into."
        : `This passkey opens a wallet (${state.address.slice(0, 4)}…${state.address.slice(-4)}) that isn't in Who gets paid.`}</p>
      <p class="mono key-box">{state.key}</p>
      <div class="row">
        <CopyButton text={state.key} label="Copy key" className="btn ghost sm" />
        <button class="quiet-link" onClick={() => setState(null)}>Hide it</button>
      </div>
      <p class="warn"><b>Keep this private.</b> Anyone who has it can take your money, and Amply will never ask
        for it. Paste it only into Phantom. It hides itself after two minutes.</p>
    </div>
  );
}

/**
 * Once the payout wallet is filled in: say so plainly, remind to publish if it
 * isn't live yet, and let the artist check their Face ID really opens it
 * (the passkey makes the key again; only the address is compared).
 */
function PayoutReady({ address, live, held = false }) {
  const [check, setCheck] = useState(null);   // { ok } | { other } | { error } | "busy"
  const [canPasskey, setCanPasskey] = useState(false);
  useEffect(() => {
    let mine = false;
    try { mine = localStorage.getItem(PASSKEY_WALLET_KEY) === address; } catch { /* unknown */ }
    if (mine) mayOfferPasskey().then(setCanPasskey);
  }, []);
  async function verify() {
    setCheck("busy");
    try {
      const seed = await restorePasskeySeed();
      const mine = await addressOf(seed);
      seed.fill(0);
      setCheck(mine === address ? { ok: true } : { other: mine });
    } catch (e) {
      if (e?.name === "Cancelled" || e?.name === "NotAllowedError") setCheck(null);
      else if (e instanceof NoPasskeySecret) setCheck({ error: "This device's passkey can't open it. Try again and choose your phone." });
      else setCheck({ error: e?.message || "Couldn't check just now." });
    }
  }
  return (
    <div class="payout-ready" role="status">
      <p><b>✓ Step 1: wallet ready</b> <span class="mono muted small">{address.slice(0, 4)}…{address.slice(-4)}</span></p>
      {!live && (held
        ? <p class="warn small">Next: add $5 for network fees, below.</p>
        : <p class="warn small">Press <b>Publish</b> at the top so fans can start paying you.</p>)}
      {canPasskey && (
        check?.ok ? <p class="good small">Your Face ID opens this wallet. All good.</p>
          : check?.other ? <p class="warn small">That Face ID opens a different wallet ({check.other.slice(0, 4)}…{check.other.slice(-4)}).
              Try again and pick the passkey you made for Amply payouts.</p>
          : <button class="quiet-link" disabled={check === "busy"} onClick={verify}>
              {check === "busy" ? "Waiting for Face ID…" : "Check it opens with my Face ID"}</button>
      )}
      {check?.error && <p class="warn small">{check.error}</p>}
    </div>
  );
}

function Splits({ payees, rate, onChange, live }) {
  const total = payees.reduce((n, p) => n + (Number(p.split) || 0), 0);
  const ok = Math.abs(total - 100) <= 0.01;
  const perSong = rate * TYPICAL_SONG_MIN;

  const set = (i, next) => onChange(payees.map((p, j) => (j === i ? next : p)));

  const evenly = () => {
    // The last share absorbs the rounding so the total still lands on 100.
    const each = Math.floor((100 / payees.length) * 100) / 100;
    onChange(payees.map((p, i) =>
      ({ ...p, split: i === payees.length - 1 ? Math.round((100 - each * (payees.length - 1)) * 100) / 100 : each })));
  };

  return (
    <section class="card">
      {!payees.some((p) => p.address) && (
        <div class="card-note">
          <p><b>To be paid, you need a payout wallet.</b> It's like a bank account for what listeners pay you:
            their payments go straight into it, never through Amply. Making one takes a tap.</p>
          <PasskeyWallet onAddress={(a) => set(0, { ...payees[0], address: a })} />
          <details>
            <summary>Already use Phantom? Use that instead</summary>
          <ol>
            <li>Install <a href="https://phantom.com/download" target="_blank" rel="noopener">Phantom ↗</a> on
              your phone or computer, and sign up with Google or Apple, then choose a PIN. There are no recovery words to write down, but don't forget the PIN.</li>
            <li>In Phantom, tap <b>Receive</b>, choose <b>Solana</b>, and copy the address.</li>
            <li>Paste it below, under <b>Wallet address</b>.</li>
          </ol>
          </details>
          <p class="muted">Rather be paid by card only? Set your price to free, and offer Subscriptions instead.</p>
        </div>
      )}
      <h2>Where your money goes <span class="note">and who you split it with</span>
        <Help at="wallet" about="where your money goes">Each payment goes straight to the payout wallets here; it
          never passes through Amply. Playing with a band or a producer? Add them, each with their own payout
          wallet and share, and every payment is divided the moment it's made. Use your own wallet here, not a
          deposit address from Coinbase or Cash App.</Help></h2>

      <div class="split-bar">
        {payees.map((p, i) => (
          <i key={i} style={`width:${Math.max(0, Math.min(100, Number(p.split) || 0))}%`} />
        ))}
      </div>
      <p class={`split-sum ${ok ? "ok" : "off"}`}>
        <b>{Number(total.toFixed(2))}% of every payment</b>
        <em>{ok ? "adds up, ready to publish" : `needs to add up to 100%, ${total > 100 ? "that is too much" : "that leaves some unclaimed"}`}</em>
      </p>

      {payees.map((p, i) => (
        <div class="payee" key={i}>
          <div class="payee-top">
            <span class={`swatch${i % 2 ? " two" : ""}`} aria-hidden="true" />
            <Text
              value={p.name} placeholder={i === 0 ? "You" : "Their name"}
              onInput={(v) => set(i, { ...p, name: v })}
            />
            <button
              class="icon" disabled={payees.length === 1}
              aria-label="Remove this person"
              onClick={() => onChange(payees.filter((_, j) => j !== i))}
            >×</button>
          </div>
          <div class="payee-split">
            <div class="where">
              <Field label="Payout wallet address">
                <Text
                  value={p.address} class="mono" placeholder={i === 0 ? "Filled in when you make your wallet above" : "Their Solana address, e.g. from their Amply editor or Phantom"}
                  onInput={(v) => set(i, { ...p, address: v.trim() })}
                />
              </Field>
              {/* Only the first row is the artist themselves; collaborators
                  give their own addresses. */}
              {i === 0 && <FromPhantom onAddress={(a) => set(0, { ...p, address: a })} />}
            </div>
            <div class="share">
              <Field label="Their share">
                <div class="pct">
                  <input
                    type="number" min="0" max="100" step="0.01" value={p.split}
                    onInput={(e) => set(i, { ...p, split: Number(e.target.value) })}
                  />
                  <span>%</span>
                </div>
              </Field>
            </div>
          </div>
          {perSong > 0 && (
            <p class="payee-earns">
              {p.name || (i === 0 ? "You" : "They")} get about{" "}
              {cents(perSong * (Number(p.split) || 0) / 100)} of every {cents(perSong)} song.
            </p>
          )}
        </div>
      ))}

      <div class="choices">
        <button class="btn ghost" onClick={() => onChange([...payees, { name: "", address: "", split: 0 }])}>
          + Split with someone
        </button>
        {payees.length > 1 && (
          <button class="btn ghost" onClick={evenly}>Split equally between everyone</button>
        )}
      </div>
    </section>
  );
}

/**
 * Link the artist's own website domain.
 *
 * One DNS record, which every domain host lets you add — Squarespace, Wix,
 * GoDaddy, all of them — and which only the domain's owner can add. Listeners
 * can then add this artist by typing their domain, and see it beside their
 * name: the answer to "is this really them?" that nobody can fake. Nothing
 * about the website changes, and no nameservers move.
 */
function OwnDomain({ manifest, update }) {
  const artist = manifest.artist || {};
  const [typed, setTyped] = useState(artist.domain || "");
  const [check, setCheck] = useState(null);
  // The editor always runs on the service itself, so its own address is where
  // the manifest is. (No `location` when rendered outside a browser, in tests.)
  const manifestUrl = `${typeof location === "undefined" ? "" : location.origin}/manifest.json`;
  const host = bareDomain(typed);

  const setDomain = (v) => {
    setTyped(v);
    setCheck(null);
    const next = bareDomain(v);
    update({ ...manifest, artist: { ...artist, domain: next || undefined } });
  };

  async function look() {
    if (!host) return;
    setCheck("looking");
    try {
      if (await confirms(host, manifestUrl)) return setCheck("ok");
      setCheck((await lookup(host)) ? "elsewhere" : "missing");
    } catch {
      setCheck("error");
    }
  }

  return (
    <section class="card">
      <h2>Link your website <span class="note">recommended: proves it's really you</span>
        <Help about="linking your website">Listeners can find you by typing your website's address, and see it
          next to your name, so they know it's really you and not someone copying your music. Your website
          itself doesn't change.</Help></h2>

      <Field label="Your website's domain">
        <Text value={typed} placeholder="yourname.com" onInput={setDomain} />
      </Field>

      {host && (
        <>
          <p>Add this record wherever you manage <strong>{host}</strong>:</p>
          <div class="dns-record">
            <div><span class="k">Type</span><code>TXT</code></div>
            <div><span class="k">Name / Host</span><code>_amply</code>
              <CopyButton text="_amply" label="Copy" /></div>
            <div><span class="k">Value</span><code class="v">{recordFor(manifestUrl)}</code>
              <CopyButton text={recordFor(manifestUrl)} label="Copy" /></div>
          </div>

          <details class="where-dns">
            <summary>Where do I add it?</summary>
            <ul>
              <li><strong>Squarespace:</strong> Settings → Domains → your domain → DNS → Add record.</li>
              <li><strong>Wix:</strong> Domains → ⋯ next to your domain → Manage DNS records → TXT → Add record.</li>
              <li><strong>GoDaddy:</strong> My Products → your domain → DNS → Add new record.</li>
              <li><strong>Namecheap:</strong> Domain List → Manage → Advanced DNS → Add new record.</li>
              <li><strong>Cloudflare:</strong> your domain → DNS → Records → Add record. Or, if it's on
                Cloudflare, you can <a href="https://amply.stream/domain" target="_blank" rel="noopener">host
                your whole page at listen.{host}</a> instead.</li>
            </ul>
            <p class="muted">Some hosts want the name as <code>_amply</code>, some as
            <code>_amply.{host}</code>. If one is refused, try the other.</p>
          </details>

          <div class="dns-check">
            <button class="btn ghost sm" disabled={check === "looking"} onClick={look}>
              {check === "looking" ? "Checking…" : "Check it's working"}
            </button>
            <span class={`dns-said ${check === "ok" ? "ok" : ""}`} role="status">
              {check === "ok" && `Linked. Listeners can add you as ${host}.`}
              {check === "missing" && "Not found yet. New records can take up to an hour to appear — publish, then check again later."}
              {check === "elsewhere" && `${host} has an Amply record, but it points somewhere else. Check the value matches exactly.`}
              {check === "error" && "Couldn't check just now. Try again in a minute."}
            </span>
          </div>
          <p class="muted">Publish your changes too, so your page says which domain is yours.</p>
        </>
      )}
    </section>
  );
}

function SettingsTab({ manifest, payees, setPayees, update, art, everPublished, dirty, saving, onPublish, api, onSignOut, liveAddresses = [] }) {
  const artist = manifest.artist || {};
  const links = artist.links || [];

  const setArtist = (next) => update({ ...manifest, artist: { ...artist, ...next } });
  const setLinks = (next) =>
    setArtist({ links: next.length ? next : undefined });

  return (
    <>
      <div class="page-head"><h1>Profile</h1></div>

      <div class="stack">
        <section class="card profile">
          <ImagePick
            cls="banner-art" url={artist.banner} alt=""
            onPick={(f) => art(f, (url) => setArtist({ banner: url }), BANNER_PX)}
          >
            + Banner
          </ImagePick>

          <div class="avatar-wrap">
            <ImagePick
              cls="avatar" url={artist.image} alt=""
              onPick={(f) => art(f, (url) => setArtist({ image: url }))}
            >
              your<br />photo
            </ImagePick>
          </div>

          <div class="profile-fields">
            <Field label="Your name">
              <Text
                value={artist.name} placeholder="The name you release under"
                onInput={(v) => setArtist({ name: v })}
              />
            </Field>
            <Field label="A line about you">
              <textarea
                value={artist.bio || ""} placeholder="Where you're from, what this is. Two sentences is plenty."
                onInput={(e) => setArtist({ bio: e.target.value || undefined })}
              />
            </Field>

            <div class="links">
            <span class="field-label">Links</span>
            {links.map((l, i) => (
              <div class="link-row" key={i}>
                <div class="what">
                  <Text
                    value={l.label} placeholder="What it is"
                    onInput={(v) => setLinks(links.map((x, j) => (j === i ? { ...x, label: v } : x)))}
                  />
                </div>
                <div class="where">
                  <Text
                    value={l.url} placeholder="Paste the address"
                    onInput={(v) => setLinks(links.map((x, j) => (j === i ? { ...x, url: v.trim() } : x)))}
                  />
                </div>
                <button class="icon" aria-label="Remove this link"
                        onClick={() => setLinks(links.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
            <button class="btn ghost" onClick={() => setLinks([...links, { label: "", url: "" }])}>
              + Add a link
            </button>
            </div>

            <Field
              label="Email for GDPR compliance"
              hint={<>
                Where listeners can ask about the little you keep on them. Shown on your{" "}
                <a href="/privacy" target="_blank" rel="noopener">privacy page</a>. Your usual email is fine.{" "}
                <a href="https://amply.stream/why#gdpr" target="_blank" rel="noopener">Read more ↗</a>
              </>}
            >
              <Text
                value={artist.contact} placeholder="you@example.com"
                onInput={(v) => setArtist({ contact: v.trim() || undefined })}
              />
            </Field>

            <label class="checkbox">
              <input
                type="checkbox" checked={!!manifest.content?.explicit}
                onChange={(e) => update({ ...manifest, content: { explicit: e.target.checked } })}
              />
              <span>My music contains explicit content</span>
            </label>
          </div>
        </section>

        <details class="advanced">
          <summary>More <span class="note">your own website address, your terms</span></summary>
          <div class="stack">
        <OwnDomain manifest={manifest} update={update} />

        <section class="card">
          <h2>Your terms <Help at="free" about="your terms">What you allow others to do with your recordings: your
            licence. The recommended one lets anyone listen with any player, free, which is what makes your link
            work, and withholds <strong>rebuilding a service</strong> out of your music: rehosting it, listing it
            in a catalogue, serving it to an audience. Amply isn't a party to it; only you can enforce it.{" "}
            <a href="https://amply.stream/protect" target="_blank" rel="noopener">If someone reposts your music ↗</a></Help></h2>
          <Field label="Licence">
            <select
              value={manifest.licence?.type || "none"}
              onChange={(e) => update({
                ...manifest,
                licence: e.target.value === "none" ? undefined : { type: e.target.value },
              })}
            >
              <option value="amply-personal-1">Listen freely, no redistribution (recommended)</option>
              <option value="custom">My own terms</option>
              <option value="none">Don't state any terms</option>
            </select>
          </Field>
          {manifest.licence?.type === "custom" && (
            <Field label="Where your terms are published">
              <Text
                value={manifest.licence.url} placeholder="https://"
                onInput={(v) => update({ ...manifest, licence: { ...manifest.licence, url: v.trim() } })}
              />
            </Field>
          )}
        </section>
          </div>
        </details>

        <section class="card publish-card">
          <div>
            <h2>
              {!everPublished
                ? "Nothing is on your page yet"
                : dirty ? "You have changes that aren't live" : "Everything here is live"}
            </h2>
            {(dirty || !everPublished) && <p class="muted">Listeners see them once you publish.</p>}
          </div>
          <button class="btn" disabled={!dirty || saving} onClick={onPublish}>
            {saving ? "Publishing…" : "Publish changes"}
          </button>
        </section>

        {onSignOut && (
          <div class="sign-out">
            <button class="btn ghost" onClick={onSignOut}>Sign out</button>
          </div>
        )}
      </div>
    </>
  );
}

// ── earnings ────────────────────────────────────────────────────────────────

/**
 * Ask the chain who has paid.
 *
 * The node cannot: Solana's public RPC refuses Cloudflare Workers outright. A
 * browser it answers, so this happens here, in the artist's own editor, and the
 * answer never has to be stored anywhere — the chain keeps it, and we read it
 * again next time.
 *
 * Kept from the last look so the tab opens with something in it, since the
 * public endpoint is slow and rate-limited.
 */
const KEPT = "amply.payments.v2";

function usePayments(payees, declared) {
  // Whichever chain the artist publishes is the one their listeners pay on, so
  // it is the only one worth reading. A local preference here could quietly
  // disagree with the manifest and show an artist an empty table while they
  // were being paid.
  const network = declared === "devnet" ? "devnet" : "mainnet";

  const addresses = (payees || []).map((p) => p.address).filter(Boolean);
  const key = `${KEPT}.${network}.${addresses.join(",")}`;
  // Each address's payments, kept as read so far: only what's newer is asked
  // for next time, so years of payments stay one quick look.
  const keptOf = (address) => { try { return JSON.parse(localStorage.getItem(`${KEPT}.${network}.${address}`)) || null; } catch { return null; } };
  const keep = (address, v) => { try { localStorage.setItem(`${KEPT}.${network}.${address}`, JSON.stringify(v)); } catch { /* read again next time */ } };

  const combine = () => {
    const { mergePaymentsSync } = combineHelpers;
    return mergePaymentsSync(addresses.map(keptOf));
  };
  const [state, setState] = useState(() => {
    let at = 0;
    try { at = Number(localStorage.getItem(`${key}.at`)) || 0; } catch { /* none kept */ }
    return { ...combine(), at: at || undefined, busy: false };
  });

  async function look() {
    if (!addresses.length) return;
    setState((s) => ({ ...s, busy: true, error: null }));
    try {
      // Every address in the split, because a listener's payment is divided
      // between them: what the listener paid is the sum, not any one share.
      for (const address of addresses) {
        const kept = keptOf(address);
        const fresh = await paymentsTo(address, network, { until: kept?.newest || undefined, payees: addresses });
        keep(address, mergePayments(kept, fresh));
      }
      const at = Date.now();
      try { localStorage.setItem(`${key}.at`, String(at)); } catch { /* fine */ }
      setState({ ...combine(), at, network, busy: false });
    } catch (e) {
      setState((s) => ({ ...s, busy: false, error: e.message }));
    }
  }

  // Once when the tab opens, and only if we have nothing recent: the public
  // endpoint rate-limits, and an artist opening Earnings twice should not be
  // punished for it.
  useEffect(() => {
    if (addresses.length && !(state.at > Date.now() - 5 * 60_000)) look();
  }, [key]);

  return { ...state, network, look: () => look(), addresses };
}

/** The split's payments as one: per wallet summed across every payee, the
 *  total, and what reached the first payee (the artist) on their own. */
const combineHelpers = {
  mergePaymentsSync(kepts) {
    const byWallet = {};
    let total = 0;
    kepts.forEach((k) => {
      if (!k) return;
      total += k.total || 0;
      for (const [w, p] of Object.entries(k.byWallet || {})) {
        const had = byWallet[w] || { micros: 0, other: 0, payments: 0, last: 0 };
        byWallet[w] = {
          micros: had.micros + (p.micros || 0),
          other: had.other + (p.other || 0),
          // One payment reaches every payee: counted once, not per share.
          payments: Math.max(had.payments, p.payments || 0),
          last: Math.max(had.last, p.last || 0),
        };
      }
    });
    return { byWallet, total, mine: kepts[0]?.total || 0 };
  },
};

/**
 * Everyone the artist should see: who listened, by the server's count, and
 * anyone who paid without a play being counted yet (plays are counted when a
 * song ends; a payment can come first). Shown, so money never arrives from
 * someone the editor says isn't there.
 */
export function withPayers(rows, paid) {
  const known = new Set((rows || []).map((r) => r.pubkey));
  const extra = Object.entries(paid?.byWallet || {})
    .filter(([w, p]) => !known.has(w) && w !== "unknown" && ((p.micros || 0) + (p.other || 0)) > 0)
    .map(([w, p]) => ({ pubkey: w, plays: 0, seconds: 0, first_seen: p.last, last_seen: p.last, blocked: 0, paidOnly: true }));
  return [...(rows || []), ...extra];
}

/** Micros of a dollar, as money. */
const fromMicros = (m) => `$${(m / 1_000_000).toFixed(m > 0 && m < 10_000 ? 4 : 2)}`;

/**
 * Is this listener behind on paying, as opposed to simply not yet due?
 *
 * Their app holds back up to one payment's worth — the artist's payment
 * point — before sending. So owing less than that is the artist's own setting
 * at work, not a debt. Half a payment's slack on top absorbs rounding and a
 * price that has since changed. In micros, like everything else about money
 * here.
 */
export function behind(owedMicros, paidMicros, settleAt) {
  const allowance = (Number(settleAt) > 0 ? Number(settleAt) : 1) * 1_000_000;
  return owedMicros - paidMicros > allowance * 1.5;
}

const DAY = 86_400_000;

/**
 * Where one listener stands: what their listening cost, what they've paid, and
 * whether they've really fallen short. The listener table and Home's summary
 * both ask this, so they can never disagree.
 *
 * Behind means owing more than their app is allowed to hold back: up to one
 * payment's worth unpaid is exactly what the artist's own setting asks for,
 * and flagging less would put an honest listener in red a few songs in.
 * Overdue is the other way to fall short: a small amount, kept past the week.
 * A subscriber pays by card, not by the minute: never either while their
 * subscription runs. Nothing is flagged until payments have been read.
 */
export function standing(r, paid, rate, settleAt, now = Date.now()) {
  const got = (paid.byWallet || {})[r.pubkey];
  // What their listening cost, as the server priced it when it was heard: the
  // price then, nothing while it was free. Listening from before the server
  // kept that is estimated at today's price, as it always was.
  const before = Math.max(0, (r.seconds || 0) - (r.owed_seconds || 0));
  const owed = (r.owed_micros || 0) + (rate > 0 ? (before / 60) * rate * 1_000_000 : 0);
  const subscribed = r.subscribed_until && r.subscribed_until > now;
  const counted = !subscribed && !!paid.at;
  const short = counted && behind(owed, got?.micros || 0, settleAt);
  const late = counted && overdue(owed, got?.micros || 0, r.last_seen, now);
  return { r, got, owed, subscribed, short, overdue: late };
}

/**
 * Overdue: owing for listening that finished more than a week ago.
 *
 * The other way to fall short. Someone who plays one song owes less than the
 * artist's amount and is never "behind" — but their app must still send it
 * within a week. The artist can't see when each minute was played, only when
 * the wallet was last heard, so this is certain only once *everything* is that
 * old: last heard over a week ago (and a day's grace, since the app pays when
 * next opened), with money still unpaid.
 *
 * Unpaid means more than rounding: half a cent, or a tenth of what they owe,
 * whichever is larger — the artist's count of seconds and the listener's are
 * made separately, and today's price may not be the one they listened at.
 */
export function overdue(owedMicros, paidMicros, lastSeen, now = Date.now()) {
  const unpaid = owedMicros - paidMicros;
  // Under a cent is never sent on its own (it waits for more), so it's never
  // overdue: the slack starts there.
  const slack = Math.max(LISTEN_MIN_MICROS, owedMicros * 0.1);
  return unpaid > slack && now - Number(lastSeen) > (SETTLE_WITHIN_DAYS + 1) * DAY;
}

/** Who to look at first: overdue, then behind, then everyone else as they came. */
export function rank(a, b) {
  const weight = (s) => (s.overdue ? 2 : s.short ? 1 : 0);
  return weight(b) - weight(a);
}

/**
 * Who has been listening.
 *
 * Only wallets appear here, and only for paid tracks: anyone playing a free
 * track is not counted and cannot be, which is the reason a shared link still
 * works.
 *
 * What is shown is a tally, never a history. The streaming service keeps no
 * record of which track anyone played or when, so there is nothing here to
 * leak and nothing to be subpoenaed.
 */
const LISTENERS_PAGE = 10;

function Listeners({ api, paid, rate, settleAt }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [open, setOpen] = useState(null);                  // the listener whose row is open
  const [shown, setShown] = useState(LISTENERS_PAGE);

  const load = () => api.listeners().then(setRows).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  /**
   * Everything held about one wallet, as a file.
   *
   * For a listener who asks by email rather than through their app: the right
   * of access means sending them what you hold, and this is all of it. The
   * same shape the listener's own app receives from /listen/mine.
   */
  function exportRow(row) {
    const record = {
      controller: location.host,
      wallet: row.pubkey,
      held: {
        plays: row.plays,
        seconds: row.seconds,
        costMicros: row.owed_micros ?? null,
        firstSeen: row.first_seen ? new Date(row.first_seen).toISOString() : null,
        lastSeen: row.last_seen ? new Date(row.last_seen).toISOString() : null,
        servingStopped: !!row.blocked,
      },
      notHeld: "Which tracks were played, and when. This server never records that.",
      keptFor: "A year after the wallet was last heard from, then deleted automatically.",
      exported: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(record, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `listener-${row.pubkey.slice(0, 8)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /** Erase a wallet's record at the artist's hand: a request by email, or data
   *  they no longer want. Takes any bar with it. */
  async function removeRow(row) {
    const barred = row.blocked ? " They're blocked now, and deleting lifts the block too." : "";
    if (!window.confirm(`Delete Listener ${numberOf.get(row.pubkey) ?? ""}'s data? Use this when someone asks you to delete it.${barred} This can't be undone.`)) return;
    setBusy(row.pubkey);
    try {
      await api.removeListener(row.pubkey);
      setRows((all) => all.filter((r) => r.pubkey !== row.pubkey));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function block(row, blocked) {
    if (blocked && !window.confirm("Block this listener? They'll lose your paid tracks within half an hour. Free tracks still play, and you can unblock them any time.")) return;
    setBusy(row.pubkey);
    try {
      await api.setBlocked(row.pubkey, blocked);
      setRows((all) => all.map((r) => (r.pubkey === row.pubkey ? { ...r, blocked: blocked ? 1 : 0 } : r)));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  // Numbered in the order they first came: listeners are anonymous by design,
  // so a number is easier to talk about than a code.
  // Payers whose plays haven't been counted yet are listed too (withPayers).
  const all = rows ? withPayers(rows, paid) : null;
  const numberOf = new Map(all ? [...all].sort((a, b) => (a.first_seen || 0) - (b.first_seen || 0)).map((r, i) => [r.pubkey, i + 1]) : []);

  if (error) return (
    <section class="card"><h2>Your listeners</h2>
      <p class="muted">Couldn't load your listeners just now. <button class="link" onClick={() => { setError(null); load(); }}>Try again</button></p></section>
  );
  if (!rows) return <p class="muted">Looking…</p>;

  if (!all.length) {
    return (
      <section class="card nothing">
        <h2>No listeners yet. <Help at="free" about="listeners">Everyone who plays your paid tracks appears
          here, next to what they've paid you, and you can block anyone who doesn't pay. Tracks you've made free
          play for anyone and aren't counted.</Help></h2>
      </section>
    );
  }

  return (
    <section class="card">
      <h2>Your listeners <span class="note">{all.length}</span>
        <Help at="banning" about="your listeners">Listeners don't sign up with a name, so each one is shown by a
          short code from their payment app. You see how much they listened, never what or when.
          A <strong>Paid</strong> figure in red means they're more than one payment behind. <strong>Overdue</strong>{" "}
          means they owe for listening over a week old, usually just because they haven't opened Amply since.{" "}
          <strong>Block</strong> stops them playing your paid tracks. If someone asks for a copy of their data, use{" "}
          <strong>Export</strong>; if they ask you to delete it, <strong>Delete</strong>. Records are deleted
          automatically a year after someone was last here.</Help></h2>

      <div class="reconcile">
        <span class="muted">
          {!paid.addresses.length
            ? "Set up how you get paid and this will show who has paid."
            : paid.busy
              ? "Checking who has paid…"
              : paid.error
                ? "Couldn't check payments just now. Try again with the arrow."
                : paid.at
                  ? `Payments checked at ${new Date(paid.at).toLocaleTimeString()}.`
                  : "Payments not checked yet."}
        </span>
        <span class="reconcile-do">
          {paid.network === "devnet" && <span class="note">test money</span>}
          <button class={`icon refresh${paid.busy ? " turning" : ""}`} disabled={paid.busy || !paid.addresses.length}
            onClick={paid.look} aria-label="Check payments again" title="Check payments again">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M20 12a8 8 0 1 1-2.34-5.66" /><path d="M20 4v5h-5" />
            </svg>
          </button>
        </span>
      </div>

      {/* A row each: who, plays, paid, and the rest on opening it. Listened
          and last heard are columns where there's room, and inside the row on
          a phone. A page at a time, those falling short first. */}
      <table class="listeners">
        <thead>
          <tr>
            <th>Listener</th><th>Plays</th><th class="wide">Listened</th>
            <th>Paid</th><th class="wide">Last heard</th><th />
          </tr>
        </thead>
        <tbody>
          {all.map((r) => standing(r, paid, rate, settleAt)).sort(rank).slice(0, shown).map(({ r, got, owed, subscribed, short, overdue: late }) => {
            const listened = `${Math.round((r.seconds || 0) / 60)} min`;
            const heard = new Date(r.last_seen).toLocaleDateString();
            const isOpen = open === r.pubkey;
            const toggle = () => setOpen(isOpen ? null : r.pubkey);
            return (
            <Fragment key={r.pubkey}>
            <tr class={`row${r.blocked ? " blocked" : ""}${late ? " late" : ""}${isOpen ? " open" : ""}`} onClick={toggle}>
              <td title={`Their wallet code: ${r.pubkey}`}>
                Listener {numberOf.get(r.pubkey)}
                <span class="code mono muted small">{r.pubkey.slice(0, 4)}…{r.pubkey.slice(-4)}</span>
              </td>
              <td>{r.plays}</td>
              <td class="wide">{listened}</td>
              <td class={short ? "short" : ""} title={got?.payments ? `${got.payments} payments, last ${new Date(got.last).toLocaleDateString()}` : ""}>
                {subscribed
                  ? `subscriber to ${new Date(r.subscribed_until).toLocaleDateString()}`
                  : !paid.at ? "not checked" : got ? fromMicros(got.micros) : "$0.00"}
                {late && (
                  <span class="overdue" title="Owes for listening more than a week old. Their app pays the next time it's opened.">
                    overdue · owes {fromMicros(Math.max(0, owed - (got?.micros || 0)))}
                  </span>
                )}
              </td>
              <td class="wide">{heard}</td>
              <td class="row-open">
                <button class="chevron" aria-expanded={isOpen} aria-label={`More about Listener ${numberOf.get(r.pubkey)}`}
                  onClick={(e) => { e.stopPropagation(); toggle(); }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
                       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
                </button>
              </td>
            </tr>
            {isOpen && (
              <tr class={`row-more${r.blocked ? " blocked" : ""}`}>
                <td colSpan={6}>
                  <dl class="narrow">
                    <dt>Listened</dt><dd>{listened}</dd>
                    <dt>Last heard</dt><dd>{heard}</dd>
                  </dl>
                  <div class="row-do">
                    <button
                      class="link" disabled={busy === r.pubkey}
                      onClick={() => block(r, !r.blocked)}
                    >{r.blocked ? "Unblock" : "Block"}</button>
                    <button class="link quiet" onClick={() => exportRow(r)}
                      title="Download everything held about this listener, to send them if they ask">Export data</button>
                    <button class="link quiet danger" disabled={busy === r.pubkey}
                      onClick={() => removeRow(r)}
                      title="Delete this listener's record, if they ask you to">Delete</button>
                  </div>
                </td>
              </tr>
            )}
            </Fragment>
          );})}
        </tbody>
      </table>
      {rows.length > shown && (
        <button class="btn ghost sm" onClick={() => setShown((n) => n + LISTENERS_PAGE)}>Show more</button>
      )}
    </section>
  );
}

/**
 * Listeners' network fees, paid by this service (node/src/settle.ts). Every
 * Solana payment needs a fee of a fraction of a cent, in SOL. When this
 * service's fee wallet holds a little SOL, it pays that for every listener,
 * so they never need any. It's a wallet of its own, separate from where
 * listeners pay: it holds SOL for fees and nothing else.
 */
/** One tap to Coinbase, buying SOL straight into the fees account. */
function BuySol({ api, label = "Or with Coinbase" }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  if (!api?.feesOnramp) return null;
  async function buy() {
    // Opened during the tap, or phones block it; filled in once signed.
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    setBusy(true); setErr(null);
    try {
      const signedAt = Date.now();
      const { address, signature } = await api.feesOnramp(signedAt);
      const href = coinbaseSolPage(address, 5, signedAt, signature);
      if (tab) tab.location.href = href; else location.href = href;
    } catch (e) {
      tab?.close();
      setErr(e.message);
    } finally { setBusy(false); }
  }
  return (
    <div class="buy-sol">
      <button class="btn ghost sm" disabled={busy} onClick={buy}>{busy ? "Opening Coinbase…" : label}</button>
      {err && <p class="warn" role="alert">{err}</p>}
    </div>
  );
}

/** Payments that $5 of SOL pays the network fee on, roughly: a full bar. */
const FEES_FULL = 6000;

/**
 * The fees account's status, asked of the node (always a fresh look at the
 * network there) once and shared: the banner, Earnings, the setup screen and
 * sending all read this one, and there is one poll, not one each.
 */
const Fees = createContext(null);

/** How often to look again: every 15 s while the setup screen's fees step is
 *  open, every minute while it's off, and not at all once it's on. */
export function feesPollMs(fees, setupOpen) {
  if (fees?.offering) return null;
  if (setupOpen) return 15_000;
  return fees?.offering === false ? 60_000 : null;
}

function useFeesStatus(api) {
  const [fees, setFees] = useState(null);
  const [failed, setFailed] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const asking = useRef(null);
  const askedAt = useRef(0);
  // `ifOlderThan`: a card opening asks only if the last look wasn't just now.
  const refresh = useCallback(({ ifOlderThan = 0 } = {}) => {
    if (!api?.fees) return Promise.resolve(null);
    if (asking.current) return asking.current;
    if (ifOlderThan && Date.now() - askedAt.current < ifOlderThan) return Promise.resolve(null);
    asking.current = api.fees()
      .then((f) => { askedAt.current = Date.now(); setFees(f); setFailed(false); return f; })
      .catch(() => { setFailed(true); return null; })
      .finally(() => { asking.current = null; });
    return asking.current;
  }, [api]);
  useEffect(() => { refresh(); }, [refresh]);
  const every = feesPollMs(fees, setupOpen);
  useEffect(() => {
    if (!every) return;
    const t = setInterval(() => refresh(), every);
    return () => clearInterval(t);
  }, [every, refresh]);
  return useMemo(() => ({ fees, failed, refresh, setSetupOpen }), [fees, failed, refresh]);
}

function FeesCard({ api, network, payees, step = false, bare = false }) {
  const { fees = null, failed = false, refresh } = useContext(Fees) || {};
  const load = () => refresh?.();
  // Opening the card looks again, unless the last look was just now.
  useEffect(() => { refresh?.({ ifOlderThan: 30_000 }); }, [refresh]);

  if (!api?.fees || !network || !payees?.length) return null;
  const head = <h2>Fees account</h2>;
  if (failed && !fees) return (
    <section class="card">{head}
      <p class="muted">Couldn't check this just now. <button class="link" onClick={load}>Try again</button></p></section>
  );
  if (!fees) return <section class="card">{head}<p class="muted">Checking…</p></section>;

  // 10,000 lamports a payment; what's held back keeps the account itself open.
  const payments = fees.lamports == null ? null : Math.max(0, Math.floor((fees.lamports - (fees.offerAbove || 3_000_000)) / 10_000));
  const real = fees.network === "solana";
  const byHand = (
    <details class="fee-how">
      <summary>{real ? "Or send SOL yourself" : "Send test SOL to it"}</summary>
      <p class="muted small">Send SOL (not USDC) on the Solana network to:</p>
      <div class="copy-row">
        <CopyButton text={fees.address} label="Copy" className="btn sm" />
        <code>{fees.address}</code>
      </div>
    </details>
  );
  if (fees.offering) {
    // About what $5 of SOL pays for; the bar is full there, and red near empty.
    const share = payments == null ? 0 : Math.min(1, payments / FEES_FULL);
    return (
      <section class="card fees-on" id="fees">
        <div class={`meter${share < 0.1 ? " full" : ""}`}>
          <span class="label">Fees left{payments != null && <span class="meter-note"> · ~{payments.toLocaleString()} payments</span>}</span>
          <div class="meter-bar" role="meter" aria-label="Fees left" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(share * 100)}>
            <i style={{ width: `${share * 100}%` }} />
          </div>
        </div>
        <details class="fee-how">
          <summary>Top up</summary>
          {real && <a class="btn sm" href={topupUrl(fees.address, { currency: "sol" })} target="_blank" rel="noopener noreferrer">$5 by card</a>}
          {real && <BuySol api={api} />}
          {byHand}
        </details>
      </section>
    );
  }
  return (
    <section class="card" id="fees">
      {!bare && <h2>{step ? "Step 2: fees account" : "Fees account"} <span class="pill-status off">Off</span></h2>}
      <p>Add $5 so fans can pay you. Each $1 covers ~1,000 payments' network fees.</p>
      {real && <>
        <a class="btn" href={topupUrl(fees.address, { currency: "sol" })} target="_blank" rel="noopener noreferrer">Add $5 by card</a>
        <BuySol api={api} />
      </>}
      {byHand}
      <p class="muted small">On within minutes.{real ? "" : ` Test network (${fees.network}).`}{" "}
        <button class="link" onClick={load}>Check now</button></p>
    </section>
  );
}

const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "");

/** What listeners have paid, in dollars, at the top of Earnings. */
function EarningsSummary({ paid, payees }) {
  if (!payees.some((p) => p.address)) {
    return (
      <section class="card earnings-top">
        <h2>Not set up to be paid yet</h2>
        <p class="muted">Choose where your money goes in Settings, under <b>Where your money goes</b>, then
          publish. Until then your music is free to listen to.</p>
      </section>
    );
  }
  return (
    <section class="card earnings-top">
      <span class="label">PAID TO YOU</span>
      <div class="earned">
        {/* Your own share: with a split, the rest went straight to the others. */}
        <b>{paid.at ? `$${((paid.mine || 0) / 1_000_000).toFixed(2)}` : paid.busy ? "…" : "—"}</b>
        {paid.network === "devnet" && <span class="note">test money</span>}
        <button class="link small" onClick={paid.look} disabled={paid.busy} aria-label="Check again" title="Check again">↻</button>
      </div>
      {paid.error && <p class="warn small">Couldn't check just now.</p>}
    </section>
  );
}

/** The payout wallet's address, for the few who need it. */
function PayoutAddress({ payees }) {
  const address = payees.find((p) => p.address)?.address;
  if (!address) return null;
  return (
    <section class="card">
      <p class="payout-where muted small">Payout wallet{" "}
        <code title={address}>{short(address)}</code>{" "}
        <CopyButton text={address} label="Copy" /></p>
    </section>
  );
}

/** What to show when a Face ID step fails: nothing if they cancelled. */
function faceIdProblem(e) {
  if (e?.name === "Cancelled" || e?.name === "NotAllowedError") return null;
  if (e instanceof NoPasskeySecret) return { error: "This device's passkey can't open the wallet. Try again and choose your phone in the window that appears." };
  return { error: e?.message || "That didn't go through, and nothing was sent." };
}

/** The payout wallet's key, made from the passkey for one use and wiped. */
async function withPayoutKey(payees, use) {
  const seed = await restorePasskeySeed();
  try {
    const from = base58(await publicKeyOf(seed));
    if (!payees.some((p) => p.address === from)) {
      throw new Error("That passkey opens a different wallet from the one you're paid into. Try again and choose the passkey you made for Amply payouts.");
    }
    return await use(seed, from);
  } finally {
    seed.fill(0);
  }
}

/**
 * Send `micros` of USDC from the Face ID payout wallet to `dest`, returning
 * the signature. The artist's server drafts the transfer and pays its network
 * fee; this page checks every part of the draft before Face ID signs it (only
 * this amount, only to this address, only from this wallet, nothing else),
 * and the server checks it again before sending.
 */
async function sendFromPayoutWallet({ api, payees, net, dest, micros, step = () => {} }) {
  step("Waiting for Face ID…");
  return withPayoutKey(payees, async (seed, from) => {
    step("Preparing the transfer…");
    const { tx: draft, feePayer } = await api.prepareSend(from, dest, micros);
    const tx = readTransaction(base64.decode(draft) || new Uint8Array(0));
    if (tx.accounts[1] !== from) throw new Error("Your server prepared a transfer from a different wallet, so it wasn't sent.");
    tx.signatures[1] = await signWithSeed(seed, tx.message);
    // Checked here before it leaves this page: exactly this, nothing else.
    const verdict = await checkFeePayment(tx, {
      feePayer, mint: NETWORKS[net].usdc, payees: [{ address: dest, split: 100 }], minMicros: micros, maxMicros: micros,
    });
    if (!verdict.ok || verdict.listener !== from) {
      throw new Error(`Your server prepared a transfer that isn't the one you asked for, so it wasn't sent (${verdict.ok ? "wrong wallet" : verdict.problem}).`);
    }
    step("Sending…");
    return (await api.send(base64.encode(writeTransaction(tx)), from, dest, micros)).signature;
  });
}

/**
 * Sending from a Face ID payout wallet, with no SOL and no other app. The
 * artist's server drafts the transfer and pays its network fee; this page
 * checks every part of the draft before Face ID signs it (only this amount,
 * only to this address, only from this wallet, nothing else), and the server
 * checks it again before sending. The key is made from the passkey for the
 * one signature, and wiped.
 */
function SendToBank({ api, payees, network, routeName }) {
  const net = network === "devnet" ? "devnet" : "mainnet";
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [balance, setBalance] = useState(null);
  const { fees } = useContext(Fees) || {};
  const feesOn = fees ? !!fees.offering : null;
  const [state, setState] = useState(null);   // { busy, text } | { done, usd, signature } | { error }
  const mine = payees.find((p) => p.address)?.address;

  useEffect(() => {
    let alive = true;
    usdcBalance(mine, net).then((b) => alive && setBalance(b)).catch(() => {});
    return () => { alive = false; };
  }, [mine, net]);

  const micros = Math.round(Number(amount) * 100) * 10_000;
  const toOk = !!keyOf(to.trim());
  const tooMuch = balance != null && micros > balance;

  async function go() {
    const dest = to.trim();
    const usd = (micros / 1e6).toFixed(2);
    if (!window.confirm(`Send $${usd} to your ${routeName} (${dest.slice(0, 4)}…${dest.slice(-4)})?\n\n`
      + `Check that address matches the one ${routeName} shows you. A transfer can't be called back.`)) return;
    try {
      const signature = await sendFromPayoutWallet({ api, payees, net, dest, micros, step: (text) => setState({ busy: true, text }) });
      setState({ done: true, usd, signature });
      setAmount("");
      setBalance((b) => (b == null ? b : Math.max(0, b - micros)));
    } catch (e) {
      setState(faceIdProblem(e));
    }
  }

  if (state?.done) {
    return (
      <div class="send-done" role="status">
        <p class="good"><b>Sent ${state.usd}.</b> It should show up in {routeName} within a few minutes.</p>
        <p class="muted small"><a href={`https://solscan.io/tx/${state.signature}${net === "devnet" ? "?cluster=devnet" : ""}`}
          target="_blank" rel="noopener">See proof of payment ↗</a> <span class="muted">(opens a technical page)</span> · <button class="link" onClick={() => setState(null)}>Send more</button></p>
      </div>
    );
  }

  if (feesOn === false) {
    return (
      <div class="send-setup">
        <p>First, add $5 to your fees account. It pays the network fee on sends.</p>
        <button class="btn sm" onClick={() => document.getElementById("fees")?.scrollIntoView({ behavior: "smooth", block: "start" })}>
          Go to fees account</button>
      </div>
    );
  }

  const disabled = state?.busy || !toOk || micros < 10_000 || tooMuch;
  return (
    <div class="send-form">
      <Field label={`Your ${routeName} deposit address`}>
        <Text value={to} class="mono" placeholder="Paste the address from step 1" onInput={(v) => setTo(v)} />
      </Field>
      {to.trim() && !toOk && <p class="warn small">Not a deposit address. Copy it again.</p>}
      <Field label="How much">
        <div class="send-amount">
          <span class="money">$<input type="number" min="0.01" step="0.01" value={amount} placeholder="0.00"
            aria-label="Amount to send, in dollars" onInput={(e) => setAmount(e.target.value)} /></span>
          {balance != null && balance > 0 && (
            <button class="link" onClick={() => setAmount((Math.floor(balance / 10_000) / 100).toFixed(2))}>
              All of it (${(Math.floor(balance / 10_000) / 100).toFixed(2)})</button>
          )}
        </div>
      </Field>
      {tooMuch && <p class="warn small">More than your wallet holds.</p>}
      <button class="btn sm" disabled={disabled} onClick={go}>
        {state?.busy ? state.text : "Send with Face ID"}</button>
      <p class="muted small">Network fee paid by your fees account · arrives in a minute or two</p>
      {state?.error && <p class="warn" role="alert">{state.error}</p>}
    </div>
  );
}

/**
 * Cashing out through Coinbase (Offramp). Face ID signs that the artist owns
 * the wallet; Coinbase's own page takes the amount and where the money goes
 * (bank or Coinbase balance); then Coinbase says where to send the USDC, read
 * through the artist's node, and Face ID sends exactly that. Coinbase holds
 * the request for 30 minutes after "Cash out now".
 */
function CoinbaseCashOut({ api, payees, network }) {
  const net = network === "devnet" ? "devnet" : "mainnet";
  const mine = payees.find((p) => p.address)?.address;
  const [balance, setBalance] = useState(null);
  const [amount, setAmount] = useState("");
  const [state, setState] = useState(null);  // { busy, text } | { signed, link } | { waiting } | { send } | { done } | { error }
  const signed = useRef(null);

  useEffect(() => {
    let alive = true;
    usdcBalance(mine, net).then((b) => alive && setBalance(b)).catch(() => {});
    return () => { alive = false; };
  }, [mine, net]);

  // While Coinbase is being used: ask now and then where it's waiting for the USDC.
  useEffect(() => {
    if (!state?.waiting) return;
    let alive = true, delay = 4000;
    const look = async () => {
      if (!alive) return;
      try {
        const s = signed.current;
        const r = await api.cashoutStatus(s.address, s.signedAt, s.signature);
        if (!alive) return;
        if (r.send) return setState({ send: r.send });
        if (r.last === "success") return setState({ done: true });
      } catch { /* asked again below */ }
      delay = Math.min(delay * 1.5, 20_000);
      setTimeout(look, delay);
    };
    const t = setTimeout(look, delay);
    return () => { alive = false; clearTimeout(t); };
  }, [state?.waiting]);

  const usd = Number(amount);
  const tooMuch = balance != null && Math.round(usd * 1e6) > balance;
  const ok = usd >= 1 && Math.round(usd * 100) === usd * 100 && !tooMuch;

  async function sign() {
    setState({ busy: true, text: "Waiting for Face ID…" });
    try {
      const signedAt = Date.now();
      const s = await withPayoutKey(payees, async (seed, from) => ({
        address: from, signedAt,
        signature: base58(await signWithSeed(seed, new TextEncoder().encode(sellMessage(from, signedAt)))),
      }));
      signed.current = s;
      setState({ signed: true, link: coinbaseCashoutPage(s.address, usd, s.signedAt, s.signature) });
    } catch (e) {
      setState(faceIdProblem(e));
    }
  }

  async function send() {
    const { to, micros } = state.send;
    try {
      const signature = await sendFromPayoutWallet({ api, payees, net, dest: to, micros, step: (text) => setState({ send: state.send, busy: true, text }) });
      setState({ sent: true, usd: (micros / 1e6).toFixed(2), signature });
    } catch (e) {
      setState(faceIdProblem(e) || { send: state.send });
    }
  }

  if (state?.sent || state?.done) {
    return (
      <div class="send-done" role="status">
        <p class="good"><b>{state.sent ? `Sent $${state.usd} to Coinbase.` : "Done."}</b> Coinbase pays it out.</p>
        <button class="link" onClick={() => setState(null)}>Cash out more</button>
      </div>
    );
  }
  if (state?.send) {
    return (
      <div class="send-form">
        <p><b>Coinbase is ready for ${(state.send.micros / 1e6).toFixed(2)}.</b> Send within 30 minutes.</p>
        <button class="btn" disabled={state.busy} onClick={send}>{state.busy ? state.text : "Send with Face ID"}</button>
        {state.error && <p class="warn" role="alert">{state.error}</p>}
      </div>
    );
  }
  if (state?.signed || state?.waiting) {
    return (
      <div class="send-form">
        <a class="btn" href={state.link} target="_blank" rel="noopener noreferrer"
          onClick={() => setState({ waiting: true, link: state.link })}>Open Coinbase</a>
        <p class="muted small">Press <b>Cash out now</b> on Coinbase, then come back.</p>
        {state.waiting && <p class="muted small">Waiting for Coinbase… <button class="link" onClick={() => setState(null)}>Start again</button></p>}
      </div>
    );
  }
  return (
    <div class="send-form">
      <Field label="How much">
        <div class="send-amount">
          <span class="money">$<input type="number" min="1" step="0.01" value={amount} placeholder="0.00"
            aria-label="Amount to cash out, in dollars" onInput={(e) => setAmount(e.target.value)} /></span>
          {balance != null && balance >= 1_000_000 && (
            <button class="link" onClick={() => setAmount((Math.floor(balance / 10_000) / 100).toFixed(2))}>
              All of it (${(Math.floor(balance / 10_000) / 100).toFixed(2)})</button>
          )}
        </div>
      </Field>
      {tooMuch && <p class="warn small">More than your wallet holds.</p>}
      <button class="btn" disabled={!ok || state?.busy} onClick={sign}>{state?.busy ? state.text : "Cash out with Coinbase"}</button>
      <p class="muted small">At least $1 · needs a Coinbase account with your bank added · Face ID twice</p>
      {state?.error && <p class="warn" role="alert">{state.error}</p>}
    </div>
  );
}

/** Moving money out of the payout wallet: Coinbase (most countries) or Cash App (US). */
function CashOut({ api, payees, network, via: chosen, onVia }) {
  const [via, setVia] = useState(chosen === "cashapp" || chosen === "coinbase" ? chosen : null);
  // A wallet made with Face ID cashes out here; one saved by hand (or brought
  // along) is in a wallet app like Phantom.
  const [passkey, setPasskey] = useState(() => {
    try { return localStorage.getItem(PASSKEY_WALLET_KEY) === payees.find((p) => p.address)?.address; } catch { return true; }
  });
  const pick = (k) => { setVia(k); onVia?.(k); };
  const routes = CASH_ROUTES;
  return (
    <section class="card" id="cash-out">
      <h2>Cash out</h2>
      <div class="pay-choices">
        {Object.entries(routes).map(([k, v]) => (
          <button key={k} type="button" class="pay-choice" aria-pressed={via === k} onClick={() => pick(k)}>
            <b>{v.name}</b><span>{v.where}</span><span class="fee">{v.fee}</span></button>
        ))}
      </div>
      {via && !passkey && (
        <p class="muted">In Phantom: <b>USDC</b> → <b>Send</b> → paste your {routes[via].name} address (Solana).</p>
      )}
      {via === "coinbase" && passkey && <CoinbaseCashOut api={api} payees={payees} network={network} />}
      {via === "cashapp" && passkey && (
        <ol class="cash-steps">
          <li>In Cash App: <b>Money</b> → <b>Deposit USDC</b> → <b>Solana</b> → copy.</li>
          <li><SendToBank api={api} payees={payees} network={network} routeName="Cash App" /></li>
        </ol>
      )}
      {via && (
        <button class="quiet-link" onClick={() => setPasskey(!passkey)}>
          {passkey ? "My payout wallet is in the Phantom app" : "I made my payout wallet with Face ID"}</button>
      )}
      <details class="cash-out-passkey">
        <summary>Open your wallet in another app</summary>
        <p class="muted">In Phantom: <b>Add account</b> → <b>Import private key</b> → Solana → paste.</p>
        <ShowWalletKey payees={payees} />
      </details>
    </section>
  );
}

/**
 * The editor's front page: how it's going, at a glance. Listener totals come
 * from the server's ledger (a tally per wallet, never a history), song totals
 * from its per-song counts (nothing about who), and what's been paid from the
 * public payment records, read here in the browser.
 */
/**
 * How much of Cloudflare's free plan is used: a label and a bar, nothing else.
 * The node works the numbers out (quota.ts); full is past nine tenths.
 */
function Meter({ label, used, of }) {
  const share = of > 0 ? Math.min(1, used / of) : 0;
  return (
    <div class={`meter${share >= 0.9 ? " full" : ""}`}>
      <span class="label">{label}</span>
      <div class="meter-bar" role="meter" aria-label={label} aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(share * 100)}>
        <i style={{ width: `${share * 100}%` }} />
      </div>
    </div>
  );
}

function HomeTab({ api, manifest, payees, rate, settleAt, network, live, onGo }) {
  const [rows, setRows] = useState(null);
  const [songs, setSongs] = useState(null);
  const [usage, setUsage] = useState(null);
  const paid = usePayments(payees, network);
  useEffect(() => {
    api.listeners().then(setRows).catch(() => setRows([]));
    (api.stats ? api.stats() : Promise.resolve({ songs: [] }))
      .then((s) => { setSongs(s.songs || []); setUsage(s.usage || null); })
      .catch(() => setSongs([]));
  }, []);

  const titles = new Map((manifest.releases || []).flatMap((r) => (r.tracks || []).map((t) => [t.id, t.title || "Untitled"])));
  const everyone = rows ? withPayers(rows, paid) : null;
  const listeners = everyone?.length ?? null;
  const minutes = rows ? Math.round(rows.reduce((n, r) => n + (r.seconds || 0), 0) / 60) : null;
  // Listeners who have really fallen short, by the same rule as the listener
  // table (standing): past what their app may hold back, or owing past the
  // week. Paying every few songs leaves recent listening unpaid on purpose,
  // so a plain paid-versus-listened figure would warn about nothing.
  const short = rows && rate > 0 && paid.at
    ? everyone.map((r) => standing(r, paid, rate, settleAt)).filter((s) => s.short || s.overdue).length
    : 0;
  const top = (songs || []).filter((s) => titles.has(s.track)).slice(0, 5);
  const most = top[0]?.plays || 1;

  return (
    <>
      <div class="page-head"><h1>Home</h1></div>
      <div class="stack">
        {!live && (
          <section class="card first-steps">
            <h2>Start here</h2>
            <p>Add your music and publish it, then your numbers show up here.</p>
            <button class="btn sm" onClick={() => onGo("music")}>Add your music</button>
          </section>
        )}

        <div class="stat-row">
          <div class="card stat"><span class="label">LISTENERS</span><b>{listeners ?? "…"}</b>
            <span class="muted small">who've played your paid songs</span></div>
          <div class="card stat"><span class="label">MINUTES LISTENED</span><b>{minutes == null ? "…" : minutes.toLocaleString()}</b>
            <span class="muted small">on your paid songs</span></div>
          <div class="card stat"><span class="label">PAID TO YOU</span>
            <b>{paid.at ? `$${((paid.mine || 0) / 1_000_000).toFixed(2)}` : paid.busy ? "…" : "—"}</b>
            <span class="muted small">{paid.error ? "couldn't check just now" : "by listeners, all time"}</span></div>
        </div>

        {usage && (
          <section class="card meters">
            <Meter label="Free streams" used={usage.streams.used} of={usage.streams.of} />
            <Meter label="Free storage" used={usage.storage.used} of={usage.storage.of} />
          </section>
        )}

        {/* Only when it's real: someone past their batch, or owing past the week. */}
        {short > 0 && (
          <section class="card">
            <h2>{short === 1 ? "A listener isn't paying" : `${short} listeners aren't paying`}</h2>
            <button class="link" onClick={() => onGo("earnings")}>See who</button>
          </section>
        )}

        <section class="card">
          <h2>Most played</h2>
          {songs == null ? <p class="muted">Loading…</p>
            : !top.length ? <p class="muted">No plays yet.</p>
            : (
              <ol class="top-songs">
                {top.map((s) => (
                  <li key={s.track}>
                    <span class="name">{titles.get(s.track)}</span>
                    <span class="bar"><i style={`width:${Math.max(4, Math.round((s.plays / most) * 100))}%`} /></span>
                    <span class="muted small">{s.plays.toLocaleString()} play{s.plays === 1 ? "" : "s"} · {Math.round(s.seconds / 60).toLocaleString()} min</span>
                  </li>
                ))}
              </ol>
            )}
        </section>
      </div>
    </>
  );
}

// ── getting paid ────────────────────────────────────────────────────────────

/** Which app the artist cashes out to; only steers which steps are shown. */
const VIA_KEY = "amply.editor.payout-via";
const NOT_PAID_HIDDEN = "amply.editor.not-paid-hidden";
const readVia = () => { try { return localStorage.getItem(VIA_KEY); } catch { return null; } };

/**
 * Before anything is set up. Fans pay into the artist's own wallet, made with
 * Face ID: the same in every country, with no exchange in between and so no
 * exchange's forms about each fan. Coinbase or Cash App is only where the
 * artist moves it later (CashOut). Card subscriptions are the other way in.
 */
function GetPaid({ payees, setPayees, manifest, update, api, perMinuteOnly }) {
  const [cards, setCards] = useState(false);
  const setAddress = (a) => {
    setPayees([{ ...payees[0], address: a }, ...payees.slice(1)]);
    // Kept on the node at once: an unpublished change is otherwise lost on reload.
    if (keyOf(a)) api?.savePayout?.(a).catch(() => {});
  };
  return (
    <section class="card">
      <h2>{perMinuteOnly ? "Also take payments by the minute" : "Get paid"}</h2>
      <p>Fans pay into your own wallet. Cash out to Coinbase or Cash App anytime.</p>
      {!perMinuteOnly && <p class="muted small">Step 1 of 2 · then $5 for network fees</p>}
      <PasskeyWallet onAddress={setAddress} />
      <p class="muted small">Amply: 0% · Solana network fee ~0.1¢ a payment, from your fees account</p>
      <details class="more">
        <summary>Already have a Solana wallet?</summary>
        <Field label="Paste its address">
          <Text value={payees[0]?.address || ""} class="mono" placeholder="Your wallet address" onInput={(v) => setAddress(v.trim())} />
        </Field>
      </details>
      {!perMinuteOnly && <>
        <div class="pay-choices">
          <button type="button" class="pay-choice" aria-pressed={cards} onClick={() => setCards(!cards)}>
            <b>Card subscriptions</b><span>Stripe · fans subscribe by card</span>
            <span class="fee">Fees: ~3.6% + 30¢ a payment (US cards) · no network fee</span>
          </button>
        </div>
        {cards && <Subscriptions manifest={manifest} update={update} api={api} />}
        <p class="muted small">Until then, your music is free.</p>
      </>}
    </section>
  );
}

/** The price and how often it's paid, one line each. */
function Pricing({ wallet, onChange, held = false }) {
  const rate = wallet.ratePerMinute ?? DEFAULT_RATE;
  const batch = batchOf(wallet);
  return (
    <section class="card pricing">
      <h2>Your price <Help at="price" about="your price">Fans pay by the minute while they listen, straight to you.
        Half a cent a minute is a good start: about $9 a month from a fan who listens an hour a day.</Help>
        {held && <span class="note">live after step 2</span>}</h2>
      <div class="price-line">
        <input type="number" class="price-input" min="0" max={RATE_MAX * 100} step="0.01"
          value={Number((rate * 100).toFixed(2))} aria-label="Price per minute, in cents"
          onInput={(e) => {
            const c = Number(e.target.value);
            if (!Number.isFinite(c)) return;
            onChange(withPrice(wallet, Math.round(Math.min(Math.max(c, 0), RATE_MAX * 100) * 100) / 10000));
          }} />
        <span class="unit">¢/min</span>
        <span class="muted">{rate > 0 ? `(~${cents(rate * TYPICAL_SONG_MIN)} per song)` : "(free)"}</span>
      </div>
      {/* Where the suggested price sits on the slider. */}
      <div class="price-mark" aria-hidden="true">
        <span title="Suggested" style={{ left: `calc(${toSlider(DEFAULT_RATE) / SLIDER_STEPS} * (100% - 16px) + 8px)` }}>▼</span>
      </div>
      <input type="range" min="0" max={SLIDER_STEPS} step="1" value={toSlider(rate)} aria-label="Price per minute"
        aria-valuetext={`${cents(rate)} a minute`} onInput={(e) => onChange(withPrice(wallet, fromSlider(Number(e.target.value))))} />
      {rate > 0 && (
        <label class="every">Pays you every{" "}
          <select value={batch} onChange={(e) => onChange({ ...wallet, settleAt: settleFor(Number(e.target.value), rate) })}>
            {BATCHES.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>{" "}{batch === 1 ? "song" : "songs"}{" "}
          <Help at="batching" about="how often">Each time a listener pays, there's a set transaction fee of 0.1¢. You
            can choose to only require payment from listeners after 10 listens, so that you make more money.</Help>
        </label>
      )}
      {rate > 0 && (() => {
        const { payment, share } = payoutFee(batch, rate);
        const pct = share * 100 < 1 ? Number((share * 100).toFixed(1)) : Math.round(share * 100);
        // Said only when the fee is a noticeable part of each payment.
        return share > 0.02 && <p class="small warn">Fee: {pct}% of each {cents(payment)} payment · pick more songs</p>;
      })()}
    </section>
  );
}

/**
 * Setting up to earn: a screen of its own, step by step, like the listener's
 * "Save your ID" (app/src/onboard.jsx). One thing per step and a back button.
 *
 *   1. Your key: the payout wallet, made with Face ID (the phone's keychain
 *      keeps it); or by hand, shown once behind a warning and an "I've saved
 *      it"; or an address they already have.
 *   2. The fees account: $5 of SOL, so fans' payments go through.
 *   3. How to cash out: Coinbase or Cash App, now or later.
 *   4. Done: publish, and fans can pay.
 */
function EarnSetup({ api, network, payees, onAddress, onPublish, onClose, start = "key" }) {
  const [step, setStep] = useState(start);
  const { fees, refresh, setSetupOpen } = useContext(Fees) || {};
  const feesOn = !!fees?.offering;
  const [via, setVia] = useState(readVia());
  const address = payees.find((p) => p.address)?.address || null;
  const order = ["key", "fees", "cashout", "done"];
  const back = () => {
    if (step === "manual" || step === "have") return setStep("key");
    const i = order.indexOf(step);
    if (i <= 0) onClose(); else setStep(order[i - 1]);
  };
  // Money sent to the fees account shows up by itself: the shared status
  // looks more often while this step is open.
  useEffect(() => {
    if (step !== "fees" || !setSetupOpen) return;
    setSetupOpen(true);
    refresh();
    return () => setSetupOpen(false);
  }, [step]);

  const keyed = (a) => { onAddress(a); setStep("fees"); };

  return (
    <div class="setup-flow" role="dialog" aria-modal="true" aria-label="Start earning">
      <button class="setup-back" onClick={back} aria-label="Back">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
      </button>
      <div class="setup-body">
        {step === "key" && <KeyStep onAddress={keyed} onManual={() => setStep("manual")} onHave={() => setStep("have")} />}
        {step === "manual" && <KeyByHand onAddress={keyed} />}
        {step === "have" && <KeyHave onAddress={keyed} />}

        {step === "fees" && (
          <>
            <p class="setup-count">Step 2 of 3</p>
            <h1>Cover the fees <Help about="the fees account">Every time a fan pays you, Solana charges a tiny network
              fee, about 0.1¢. Your fees account pays it, so fans never deal with it. Each $1 covers ~1,000 payments.</Help></h1>
            {feesOn
              ? <p class="good">✓ Your fees account is on.</p>
              : <FeesCard api={api} network={network} payees={payees} bare />}
            <button class="btn" disabled={!feesOn} onClick={() => setStep("cashout")}>Continue</button>
            {!feesOn && <button class="quiet-link" onClick={() => setStep("cashout")}>Later</button>}
          </>
        )}

        {step === "cashout" && (
          <>
            <p class="setup-count">Step 3 of 3</p>
            <h1>How you'll cash out</h1>
            <div class="pay-choices">
              {Object.entries(CASH_ROUTES).map(([k, v]) => (
                <button key={k} type="button" class="pay-choice" aria-pressed={via === k}
                  onClick={() => { setVia(k); try { localStorage.setItem(VIA_KEY, k); } catch { /* asked again */ } }}>
                  <b>{v.name}</b><span>{v.where}</span></button>
              ))}
            </div>
            <button class="btn" disabled={!via} onClick={() => setStep("done")}>Continue</button>
            <button class="quiet-link" onClick={() => setStep("done")}>Later</button>
          </>
        )}

        {step === "done" && (
          <>
            <h1>You're set up</h1>
            <p class="muted">{feesOn ? "Publish, and fans can start paying you." : "Fans can pay you once your fees account is on."}</p>
            <button class="btn" onClick={() => { onPublish?.(); onClose(); }}>Publish</button>
            <button class="quiet-link" onClick={onClose}>Not yet</button>
          </>
        )}
      </div>
    </div>
  );
}

/** Where to cash out to: the same two everywhere in the editor. */
const CASH_ROUTES = {
  coinbase: { name: "Coinbase", where: "Most countries · to your bank or Coinbase", fee: "Coinbase shows any fee before you confirm" },
  cashapp: { name: "Cash App", where: "US · turns into dollars by itself", fee: "Fees: 0% (for now)" },
};

function KeyStep({ onAddress, onManual, onHave }) {
  const [offer, setOffer] = useState(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState(null);
  useEffect(() => { mayOfferPasskey().then(setOffer); }, []);
  async function faceId() {
    setBusy(true); setSaid(null);
    try {
      const seed = await createPasskeySeed({ name: "Amply payouts" });
      const a = await addressOf(seed);
      seed.fill(0);
      try { localStorage.setItem(PASSKEY_WALLET_KEY, a); } catch { /* fine */ }
      onAddress(a);
    } catch (e) {
      if (e instanceof NoPasskeySecret) setSaid("This device can't hold it. Try again and choose your phone, or save it yourself.");
      else if (e.name !== "Cancelled" && e.name !== "NotAllowedError") setSaid(e.message);
    } finally { setBusy(false); }
  }
  return (
    <>
      <p class="setup-count">Step 1 of 3</p>
      <h1>Save your key <Help about="your key">Your key opens the wallet fans pay into. It lives only with you:
        nobody, Amply included, can recover it. Saved with Face ID, your phone's keychain keeps it and brings it to
        your other devices.</Help></h1>
      {offer && <button class="btn" disabled={busy} onClick={faceId}>{busy ? "Waiting for you…" : "Save with Face ID"}</button>}
      <button class={offer ? "btn ghost" : "btn"} disabled={busy} onClick={onManual}>Save it myself</button>
      <button class="quiet-link" onClick={onHave}>I already have a wallet</button>
      {said && <p class="warn" role="alert">{said}</p>}
    </>
  );
}

/** A new key, shown once; kept only once they say it's saved. */
function KeyByHand({ onAddress }) {
  const [made] = useState(() => {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    return { seed };
  });
  const [key, setKey] = useState(null);
  const [address, setAddress] = useState(null);
  const [kept, setKept] = useState(false);
  const [sure, setSure] = useState(false);
  useEffect(() => {
    (async () => {
      const pub = await publicKeyOf(made.seed);
      const secret = new Uint8Array(64);
      secret.set(made.seed); secret.set(pub, 32);
      // The same 64-byte key Phantom and Solflare import.
      setKey(base58(secret));
      setAddress(base58(pub));
      secret.fill(0);
    })();
    return () => made.seed.fill(0);
  }, []);
  return (
    <>
      <p class="setup-count">Step 1 of 3</p>
      <h1>Save your key</h1>
      <p class="warn">If you lose it, it can't be recovered. You'll import it into a wallet app like Phantom to cash out.</p>
      {key && <p class="setup-key mono">{key}</p>}
      {key && <CopyButton text={key} label="Copy" className="btn ghost sm" onCopied={() => setKept(true)} />}
      <label class="setup-check">
        <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
        <span>I've saved it somewhere safe</span>
      </label>
      <button class="btn" disabled={!address || !kept || !sure} onClick={() => onAddress(address)}>Continue</button>
      {!kept && <p class="muted small">Copy it first.</p>}
    </>
  );
}

function KeyHave({ onAddress }) {
  const [a, setA] = useState("");
  const [said, setSaid] = useState(null);
  const [busy, setBusy] = useState(false);
  async function faceId() {
    setBusy(true); setSaid(null);
    try {
      const seed = await restorePasskeySeed();
      const addr = await addressOf(seed);
      seed.fill(0);
      try { localStorage.setItem(PASSKEY_WALLET_KEY, addr); } catch { /* fine */ }
      onAddress(addr);
    } catch (e) {
      if (e.name !== "Cancelled" && e.name !== "NotAllowedError") setSaid(e.message);
    } finally { setBusy(false); }
  }
  return (
    <>
      <p class="setup-count">Step 1 of 3</p>
      <h1>Your wallet</h1>
      <button class="btn" disabled={busy} onClick={faceId}>Use my Face ID wallet</button>
      <input type="text" class="mono" placeholder="Or paste a Solana wallet address" value={a} onInput={(e) => setA(e.target.value.trim())} />
      <button class="btn ghost" disabled={!keyOf(a)} onClick={() => onAddress(a)}>Continue</button>
      {a && !keyOf(a) && <p class="warn small">That isn't a Solana address.</p>}
      {said && <p class="warn" role="alert">{said}</p>}
    </>
  );
}

/** The invitation, where Earnings starts for an artist not yet set up. */
function StartEarning({ onStart, resume = false }) {
  return (
    <section class="card start-earning" id={resume ? "fees" : undefined}>
      <h2>{resume ? "Almost there" : "Start earning"}</h2>
      <p class="muted">{resume ? "Cover the fees, and fans can pay you." : "Fans pay you as they listen, straight to you. About 5 minutes."}</p>
      <button class="btn" onClick={onStart}>{resume ? "Continue" : "Set up"}</button>
    </section>
  );
}

function EarningsTab({ node, api, payees, setPayees, manifest, update, live, rate, network, settleAt, held = false, feesOn = null, onPublish }) {
  const [cashing, setCashing] = useState(false);
  const [setting, setSetting] = useState(null);   // the step the setup screen opens at
  const setAddress = (a) => {
    setPayees([{ ...(payees[0] || {}), address: a, split: payees[0]?.split ?? 100 }, ...payees.slice(1)]);
    // Kept on the node at once: an unpublished change is otherwise lost on reload.
    if (keyOf(a)) api?.savePayout?.(a).catch(() => {});
  };
  const flow = setting && (
    <EarnSetup api={api} network={network} payees={payees} onAddress={setAddress}
      onPublish={onPublish} onClose={() => setSetting(null)} start={setting} />
  );
  const paid = usePayments(payees, network);
  const [via, setViaState] = useState(readVia);
  const setVia = (v) => { setViaState(v); try { localStorage.setItem(VIA_KEY, v); } catch { /* fine */ } };
  const wallet = (manifest.payment || []).find((p) => p.type === "solana-usdc")
    || { type: "solana-usdc", ratePerMinute: DEFAULT_RATE, settleAt: settleFor(DEFAULT_BATCH, DEFAULT_RATE) };
  const setWallet = (next) => {
    const rest = (manifest.payment || []).filter((p) => p.type !== "solana-usdc");
    update({ ...manifest, payment: [next, ...rest] });
  };
  const hasWallet = payees.some((p) => p.address);
  const subscribing = (manifest.payment || []).some((p) => p.type === "stripe-subscription");
  const liveAddresses = readPayees(live || { payment: [] }).map((p) => p.address).filter(Boolean);
  const payoutLive = hasWallet && liveAddresses.includes(payees.find((p) => p.address).address);
  // Cashing out needs a published wallet and a fees account that pays the
  // network fee: before both, there's nothing to cash out, so no button.
  const canCashOut = payoutLive && !held && feesOn === true;
  const head = (
    <div class="page-head">
      <h1>Earnings</h1>
      {canCashOut && <button class={`btn sm${cashing ? " ghost" : ""}`} onClick={() => setCashing(!cashing)}>{cashing ? "Close" : "Cash out"}</button>}
    </div>
  );
  const feesOff = hasWallet && (held || feesOn === false);

  if (!hasWallet && !subscribing) {
    return (<>{head}<div class="stack">
      <StartEarning onStart={() => setSetting("key")} />
      <details class="advanced">
        <summary>More <span class="note">card subscriptions</span></summary>
        <div class="stack"><Subscriptions manifest={manifest} update={update} api={api} /></div>
      </details>
    </div>{flow}</>);
  }

  return (
    <>
      {head}
      <div class="stack">
        {/* Only until it's published: after that the card below shows the wallet. */}
        {/* Setup not finished (no fees account yet): one card that carries on. */}
        {hasWallet && held && <StartEarning resume onStart={() => setSetting("fees")} />}
        {hasWallet && !held && !liveAddresses.includes(payees.find((p) => p.address).address) && (
          <PayoutReady address={payees.find((p) => p.address).address} live={false} held={held} />
        )}
        {canCashOut && cashing && <CashOut api={api} payees={payees} network={network} via={via} onVia={setVia} />}
        {feesOff && !held && <FeesCard api={api} network={network} payees={payees} />}
        {hasWallet && <BackupReminder payees={payees} />}
        {hasWallet && <EarningsSummary paid={paid} payees={payees} />}
        {hasWallet && <Pricing wallet={wallet} onChange={setWallet} held={held} />}
        {subscribing && <Subscriptions manifest={manifest} update={update} api={api} />}
        <Listeners api={api} paid={paid} rate={rate} settleAt={settleAt} />
        {hasWallet && !feesOff && <FeesCard api={api} network={network} payees={payees} />}
        {!hasWallet && <StartEarning onStart={() => setSetting("key")} />}
        <details class="advanced">
          <summary>More <span class="note">{[!subscribing && "card subscriptions", hasWallet && "split with bandmates", hasWallet && "test mode"].filter(Boolean).join(", ")}</span></summary>
          <div class="stack">
            {payoutLive && <PayoutAddress payees={payees} />}
            {!subscribing && <Subscriptions manifest={manifest} update={update} api={api} />}
            {hasWallet && <Splits payees={payees} rate={wallet.ratePerMinute ?? 0} onChange={setPayees} />}
            {hasWallet && (
              <section class="card">
                <TestMoney wallet={wallet} onChange={setWallet} />
              </section>
            )}
          </div>
        </details>
      </div>
      {flow}
    </>
  );
}

// ── the player ──────────────────────────────────────────────────────────────

/**
 * The preview player: which track, and whether it's playing. The same object
 * until one of those changes. Where it is in the song is PlayerBar's alone,
 * so the time ticking doesn't redraw the editor four times a second.
 */
export function usePlayer() {
  const audio = useRef(null);
  const [current, setCurrent] = useState(null);
  const [playing, setPlaying] = useState(false);
  const now = useRef(null);
  now.current = current;

  useEffect(() => {
    const a = new Audio();
    a.preload = "none";
    audio.current = a;
    a.addEventListener("ended", () => setPlaying(false));
    a.addEventListener("pause", () => setPlaying(false));
    a.addEventListener("play", () => setPlaying(true));
    return () => { a.pause(); a.src = ""; };
  }, []);

  const controls = useMemo(() => {
    const stop = () => {
      audio.current?.pause();
      setCurrent(null);
    };
    const toggle = (track) => {
      const a = audio.current;
      if (!a || !track.url) return;
      if (now.current?.id === track.id) {
        if (a.paused) a.play().catch(() => {}); else a.pause();
        return;
      }
      a.src = track.url;
      setCurrent(track);
      a.play().catch(() => {});
    };
    return { toggle, stop, stopIf: (id) => { if (now.current?.id === id) stop(); } };
  }, []);

  return useMemo(() => ({ current: current?.id ?? null, track: current, playing, audio, ...controls }), [current, playing, controls]);
}

function PlayerBar({ player }) {
  const [at, setAt] = useState(0);
  const [of, setOf] = useState(0);
  // Listens to the audio element itself, for as long as a track is up.
  const a = player.audio?.current;
  useEffect(() => {
    if (!a || !player.track) return;
    const tick = () => { setAt(a.currentTime || 0); setOf(a.duration || 0); };
    const ended = () => setAt(0);
    tick();
    a.addEventListener("timeupdate", tick);
    a.addEventListener("loadedmetadata", tick);
    a.addEventListener("ended", ended);
    return () => {
      a.removeEventListener("timeupdate", tick);
      a.removeEventListener("loadedmetadata", tick);
      a.removeEventListener("ended", ended);
    };
  }, [a, player.track]);
  if (!player.track) return null;
  const pct = of ? (at / of) * 100 : 0;
  return (
    <div class="player">
      <div class="player-track"><i style={`width:${pct}%`} /></div>
      <div class="player-in">
        <button
          class={`play${player.playing ? " on" : ""}`}
          onClick={() => player.toggle(player.track)}
          aria-label={player.playing ? "Pause" : "Play"}
        >
          <PlayIcon playing={player.playing} />
        </button>
        <div class="what">
          <b>{player.track.title || "Untitled"}</b>
          <span>doesn't count as a listen</span>
        </div>
        <span class="time">{mmss(at)} / {mmss(of || player.track.duration)}</span>
        <button class="close" onClick={player.stop} aria-label="Close the player">×</button>
      </div>
    </div>
  );
}

// ── the workspace ───────────────────────────────────────────────────────────

/** Pull the payees out of a manifest into the one shape the editor edits. */
function readPayees(manifest) {
  const w = (manifest.payment || []).find((p) => p.type === "solana-usdc");
  if (w?.recipients?.length) {
    return w.recipients.map((r) => ({ name: r.name || "", address: r.address || "", split: r.split }));
  }
  return [{ name: manifest.artist?.name || "", address: w?.address || "", split: 100 }];
}

/** And back again. One payee writes `address`, several write `recipients`;
 *  the spec allows exactly one of the two. */
function writePayees(wallet, payees) {
  const clean = payees.filter((p) => p.address);
  // `paused` is the server's to set, on the copy it serves; never published.
  const { address, recipients, paused: _server, ...rest } = wallet;
  // Nobody has given an address yet. A wallet with an empty one is not a valid
  // payment method, so publish no metered payment at all rather than a broken
  // one, and let the page say the music is free.
  if (clean.length === 0) return null;
  // Free is not a rate of zero, it is no metered payment at all. The spec
  // requires a rate above zero, so a zero here would make the whole manifest
  // invalid rather than make the music free.
  if (!(Number(wallet.ratePerMinute) > 0)) return null;
  if (clean.length === 1) {
    return { ...rest, address: clean[0].address };
  }
  return {
    ...rest,
    recipients: clean.map((p) => ({
      ...(p.name ? { name: p.name } : {}),
      address: p.address,
      split: Number(p.split) || 0,
    })),
  };
}

/**
 * How many things differ between what's live and what's on screen.
 *
 * Counting edits as they happen counts keystrokes, so renaming yourself reads
 * as four changes because you typed four letters. Comparing against the
 * published manifest instead counts *fields*, which is what the number claims
 * to mean, and it drops back to zero by itself when you undo something.
 *
 * Arrays compare by position, and a length difference is one change per item
 * added or removed, so a new release is one change rather than one per field
 * inside it.
 */
export function countChanges(live, now) {
  let n = 0;
  const walk = (a, b) => {
    if (a === b) return;
    const both = a && b && typeof a === "object" && typeof b === "object";
    if (!both || Array.isArray(a) !== Array.isArray(b)) { n++; return; }
    if (Array.isArray(a)) {
      n += Math.abs(a.length - b.length);
      for (let i = 0; i < Math.min(a.length, b.length); i++) walk(a[i], b[i]);
      return;
    }
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (k === "updated") continue;   // stamped at publish, never an edit
      walk(a[k], b[k]);
    }
  };
  walk(live, now);
  return n;
}

/** The manifest as it would be published: the edited one, with the payee list
 *  folded back into its payment entry, and without releases that have no
 *  tracks yet. Those are drafts. The spec requires at least one track per
 *  release, so publishing an empty one would make the live manifest invalid. */
export function buildManifest(manifest, payees, { perMinute = true } = {}) {
  const rest = (manifest.payment || []).filter((p) => p.type !== "solana-usdc");
  // An artist who fills in an address but never touches the price slider has no
  // wallet in the manifest yet. Their address still has to be published, so
  // fall back to the same defaults the settings tab shows them.
  const wallet = (manifest.payment || []).find((p) => p.type === "solana-usdc")
    || { type: "solana-usdc", ratePerMinute: DEFAULT_RATE, settleAt: settleFor(DEFAULT_BATCH, DEFAULT_RATE) };
  // Fans can only pay once the fees account pays their network fee: until
  // then, a price would be unpayable, so none is published.
  const paid = perMinute ? writePayees(wallet, payees) : null;
  return {
    ...manifest, amply: 1, updated: new Date().toISOString(),
    payment: paid ? [paid, ...rest] : rest,
    releases: (manifest.releases || []).filter((r) => r.tracks?.length),
  };
}

/**
 * Turn a spec error into something an artist can act on.
 *
 * The rules are the spec's (see spec/manifest-rules.mjs), and they report in
 * the spec's terms: `releases[0].tracks[2].title: required`. The artist needs
 * to know which song, and what to do. Anything not recognised here still shows,
 * in the spec's words, rather than being hidden.
 */
export function explain(error, manifest) {
  const [path, detail = ""] = error.split(/: (.*)/s);
  const rel = path.match(/^releases\[(\d+)\]/);
  const r = rel ? manifest.releases?.[Number(rel[1])] : null;
  const rname = r?.title ? `“${r.title}”` : `release ${rel ? Number(rel[1]) + 1 : ""}`.trim();
  const trk = path.match(/tracks\[(\d+)\]/);
  const t = trk && r ? r.tracks?.[Number(trk[1])] : null;
  const tname = t?.title ? `“${t.title}”` : `track ${trk ? Number(trk[1]) + 1 : ""}`.trim();

  if (/^releases\[\d+\]\.title$/.test(path)) return `A release needs a name. Give ${rname} a title.`;
  if (/tracks\[\d+\]\.title$/.test(path)) return `Every track needs a name. ${tname} on ${rname} has none.`;
  if (/tracks\[\d+\]\.duration$/.test(path)) return `The length of ${tname} on ${rname} could not be read. Try Replace audio with the same file.`;
  if (/tracks\[\d+\]\.sale\.price$/.test(path)) return `${tname} on ${rname} needs a price from $0.50 to $1000 to sell, or choose Stop selling.`;
  if (/^releases\[\d+\]\.sale\.price$/.test(path)) return `The price of ${rname} needs to be from $0.50 to $1000, or empty if it isn't for sale.`;
  if (/^artist\.name$/.test(path)) return "Add the name you release under, in Profile.";
  if (/^artist\.links\[(\d+)\]\.url$/.test(path)) {
    const n = Number(path.match(/links\[(\d+)\]/)[1]) + 1;
    return `Link ${n} in Profile needs a full address, starting with https://`;
  }
  if (/^artist\.links\[(\d+)\]\.label$/.test(path)) {
    const n = Number(path.match(/links\[(\d+)\]/)[1]) + 1;
    return `Link ${n} in Profile needs a label, like Bandcamp or Instagram.`;
  }
  if (/address$/.test(path)) return "A payment address in Earnings doesn't look right. It should be a Solana address: 32 to 44 letters and numbers.";
  if (/recipients$/.test(path) && /total/.test(detail)) return `The shares in Earnings ${detail.replace(/^splits must total 100%, got /, "add up to ").replace(/$/, ", not 100%")}.`;
  if (/^licence\.url$/.test(path)) return "Your own terms need the address where they are published, in Profile.";
  return `Something isn't valid yet: ${error}`;
}

/**
 * Notice when this software is behind, and say so.
 *
 * Nobody at Amply can update an artist's streaming service — that is the point
 * of the design, and the cost of it is that improvements and fixes sit there
 * unapplied unless somebody notices. Nobody reads a changelog. So the editor
 * asks, once, when it opens.
 *
 * It fails quietly. Being unable to reach amply.stream is not the artist's
 * problem to solve, and a broken banner about updates would be worse than no
 * banner about updates.
 */
export function useUpdate(version) {
  const [latest, setLatest] = useState(null);

  useEffect(() => {
    if (!version) return;
    let gone = false;
    fetch("https://amply.stream/node-version.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => { if (!gone && body?.version) setLatest(body.version); })
      .catch(() => { /* quietly */ });
    return () => { gone = true; };
  }, [version]);

  return latest && latest !== version ? latest : null;
}

/** Compare two version strings as numbers, so 3.10 is after 3.9. */
export function isNewer(latest, mine) {
  if (!latest || !mine) return false;
  const a = String(latest).split(".").map(Number);
  const b = String(mine).split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * Opened with the key from before signup (node/src/preview-key.ts): the page
 * is in a temporary account that Cloudflare deletes after an hour, and this
 * editor stops opening then too. One step at a time: keep it (claim the
 * account on Cloudflare), and once that's done, protect the editor (put it
 * behind Cloudflare's sign-in, at amply.stream). The node says when the claim
 * has happened; asked again every so often, and on coming back to this tab
 * from Cloudflare's.
 */
function Temporary({ api, initial }) {
  const [t, setT] = useState(initial);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const ask = () => api.whoami().then((w) => w?.temporary && setT(w.temporary)).catch(() => {});
    const tick = setInterval(() => { setNow(Date.now()); if (!t.claimed) ask(); }, 30_000);
    const back = () => { if (document.visibilityState === "visible") { setNow(Date.now()); ask(); } };
    document.addEventListener("visibilitychange", back);
    return () => { clearInterval(tick); document.removeEventListener("visibilitychange", back); };
  }, [t.claimed]);
  const left = Math.max(0, Math.ceil((Date.parse(t.until) - now) / 60_000));

  if (t.claimed) {
    return (
      <div class="banner temp" role="status">
        <span>It's yours. Now protect your editor{left > 0 ? <>: <b>{left} min</b> until it locks.</> : "."}</span>
        <a class="btn sm" href="https://amply.stream/start#lock" target="_blank" rel="noopener">Protect it ↗</a>
      </div>
    );
  }
  // Cloudflare's sign-up forgets the claim it came from, so the account comes
  // first and the claim after. And if the claim went through but hasn't shown
  // here yet, the protect step checks it with the artist's own login anyway.
  return (
    <div class="banner temp" role="status">
      <span>{left > 0 ? <>Temporary page: <b>{left} min</b> left.</> : "Time's up."}</span>
      {t.claim && left > 0 && (
        <span class="temp-steps">
          <a class="link" href="https://dash.cloudflare.com/sign-up" target="_blank" rel="noopener">Create a Cloudflare account ↗</a>
          <span>and then</span>
          <a class="btn sm" href={t.claim} target="_blank" rel="noopener noreferrer">Keep it ↗</a>
        </span>
      )}
      {left > 0 && (
        <span class="temp-more">
          <a class="link" href="https://amply.stream/start#lock" target="_blank" rel="noopener">Already kept it?</a>
        </span>
      )}
    </div>
  );
}

export function Editor({ api, node, initial, published = true, initialTab = "home", version = null, onSignOut, temporary = null, pendingPayout = null, editorBehind = false }) {
  const [manifest, setManifest] = useState(initial);
  const [payees, setPayees] = useState(() => {
    const p = readPayees(initial);
    return !p.some((x) => x.address) && pendingPayout ? [{ ...p[0], address: pendingPayout }, ...p.slice(1)] : p;
  });
  // What the page is actually serving. null on a node that has never published.
  const [live, setLive] = useState(() => (published ? initial : null));
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState(initialTab);
  const [menu, setMenu] = useState(false);
  const [updateHidden, setUpdateHidden] = useState(false);
  // The website (spec/site.mjs): the draft being edited, and what's published.
  // undefined while loading; null when there's no website yet.
  const [site, setSite] = useState(undefined);
  const [liveSite, setLiveSite] = useState(undefined);
  useEffect(() => {
    (api.readSite ? api.readSite() : Promise.resolve(null))
      .then((s) => { setSite(s); setLiveSite(s); })
      .catch(() => { setSite(null); setLiveSite(null); });
  }, []);
  const siteDirty = site !== undefined && JSON.stringify(site) !== JSON.stringify(liveSite);
  const go = (id) => { setTab(id); setMenu(false); window.scrollTo?.(0, 0); };
  useEffect(() => {
    if (!menu) return;
    const close = (e) => { if (e.key === "Escape") setMenu(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [menu]);
  const [msg, setMsg] = useState(null);
  const [jobs, setJobs] = useState([]);
  const jobsApi = useMemo(() => ({
    start(title) {
      const id = Math.random().toString(36).slice(2);
      setJobs((all) => [...all, { id, title, text: "Starting…", pct: null }]);
      return {
        step: (text, pct = null) => setJobs((all) => all.map((j) => (j.id === id ? { ...j, text, pct } : j))),
        done: () => setJobs((all) => all.filter((j) => j.id !== id)),
      };
    },
  }), []);
  // Good news goes by itself; problems stay until dismissed.
  useEffect(() => {
    if (msg?.kind !== "ok") return;
    const t = setTimeout(() => setMsg(null), msg.action ? 10_000 : 5_000);
    return () => clearTimeout(t);
  }, [msg]);
  const player = usePlayer();
  const newer = useUpdate(version);

  // The fees account must be on before a per-minute price is first published.
  // Once it's live it stays, so publishing a song never makes music free.
  // Asked once, shared with every card that shows it, and looked at again
  // every minute while it's off: money sent to it shows up here by itself.
  const feesStatus = useFeesStatus(api);
  const feesOn = feesStatus.fees ? !!feesStatus.fees.offering : null;
  // The artist said they understand: kept in this browser, and not shown again.
  const [notPaidHidden, setNotPaidHidden] = useState(() => { try { return localStorage.getItem(NOT_PAID_HIDDEN) === "1"; } catch { return false; } });
  const hideNotPaid = () => { setNotPaidHidden(true); try { localStorage.setItem(NOT_PAID_HIDDEN, "1"); } catch { /* hidden for now */ } };
  const wasLive = !!(live?.payment || []).find((p) => p.type === "solana-usdc");
  const perMinute = wasLive || feesOn === true || !api?.fees;
  const next = useMemo(() => buildManifest(manifest, payees, { perMinute }), [manifest, payees, perMinute]);
  // From what will be published, not the draft: a price only charges anyone
  // once there is an address to pay, and that lives with the payees.
  const charging = useMemo(() => charges(next), [next]);
  const livePayment = ((live || manifest).payment || []).find((p) => p.type === "solana-usdc");
  const manifestChanges = useMemo(() => (live ? countChanges(live, next) : 0), [live, next]);
  const changes = manifestChanges + (siteDirty ? 1 : 0);
  const dirty = live === null || changes > 0;

  const notify = useCallback((kind, text, action = null) => setMsg({ kind, text, action }), []);
  const update = useCallback((m) => setManifest(m), []);

  // Browsers only honour this after the page has been interacted with, which is
  // exactly when there is unsaved work worth protecting: changes not yet
  // published, or a song still uploading (leaving would cut it off half-sent).
  const working = jobs.length > 0;
  useEffect(() => {
    if (!dirty && !working) return;
    const warn = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, working]);

  const upload = useCallback((key, file, onProgress) => api.putObject(key, file, onProgress), [api]);

  /**
   * Put an image on the node and hand its public URL back to the caller —
   * made the right size first (images.js), so listeners download a few
   * hundred KB rather than a phone photo's megabytes.
   */
  const art = useCallback(async (original, done, longest = COVER_PX) => {
    const job = jobsApi.start("Adding a picture");
    job.step("Resizing image…");
    let file;
    try { file = await shrink(original, longest); } catch { file = original; }
    if (file.size > MAX_ART) {
      job.done();
      notify("error", `That picture is larger than ${Math.round(MAX_ART / 1048576)}MB. A smaller one will load faster for everyone anyway.`);
      return;
    }
    try {
      const key = `art/${safeKey(file.name)}`;
      await api.putObject(key, file, (f) => job.step("Uploading image…", f));
      job.done();
      done(`${node.url}/${key}`);
      // Said, and undoable: the original can go up in its place, at the same
      // address, so nothing already on the page needs to change.
      if (file !== original) {
        notify("ok", `Resized for faster loading · ${bytes(original.size)} → ${bytes(file.size)}`, {
          label: "Use original",
          run: async () => {
            try { await api.putObject(key, original); notify("ok", "Using the original picture."); }
            catch (e) { notify("error", `Could not upload the original: ${e.message}`); }
          },
        });
      }
    } catch (e) {
      job.done();
      notify("error", `Could not upload that picture: ${e.message}`);
    }
  }, [api, node.url, jobsApi]);

  async function publish() {
    let out = buildManifest(manifest, payees, { perMinute });

    // Songs and albums for sale: card links from the artist's Stripe, made
    // (or kept, when the price hasn't changed) by their streaming service.
    // Without Stripe they sell for USDC, if there's a wallet; without either,
    // there's no way to pay, and nothing is published until there is.
    const items = saleItems(out);
    const stripe = api?.stripeStatus ? await api.stripeStatus().catch(() => null) : null;
    let links = {};
    if (stripe?.connected && (items.length || stripe.sales?.length)) {
      setSaving(true);
      try {
        const r = await api.stripeSales("", items);
        links = Object.fromEntries((r.sales || []).map((s) => [s.item, s.url]));
      } catch (e) {
        setSaving(false);
        notify("error", `Nothing was published. Setting up your sales in Stripe didn't work: ${e.message}`);
        return;
      }
      setSaving(false);
    }
    out = withSaleLinks(out, links);
    const wallet = (out.payment || []).some((p) => p.type === "solana-usdc");
    if (items.length && !wallet && !Object.keys(links).length) {
      setTab("earnings");
      notify("error", "Nothing was published. To sell songs and albums, set up how you get paid, in Earnings.");
      return;
    }

    // The same rules a listening app will apply. If they reject it, nothing is
    // sent: a manifest that fails them is a page no client will read.
    const { errors } = validate(out);
    if (errors.length) {
      const first = errors[0];
      if (/^payment/.test(first)) setTab("earnings");
      else if (/^(artist|licence)/.test(first)) setTab("settings");
      else setTab("music");
      const more = errors.length > 1 ? ` (and ${errors.length - 1} more thing${errors.length > 2 ? "s" : ""} to fix)` : "";
      notify("error", `Nothing was published. ${explain(first, out)}${more}`);
      return;
    }

    setSaving(true);
    try {
      if (manifestChanges > 0 || live === null) await api.writeManifest(out);
      // The website goes up with it, as the server cleaned it.
      if (siteDirty && api.writeSite) {
        const r = await api.writeSite(site);
        setSite(r.site); setLiveSite(r.site);
      }
      // The editor keeps its drafts (releases with no tracks yet); only what
      // was published becomes the new baseline.
      setLive(out);
      notify("ok", "Published. Your page will show the change within a few minutes.");
    } catch (e) {
      notify("error", e.message);
    } finally {
      setSaving(false);
    }
  }

  // For the earnings checklist: music that is actually on the page, not drafted.
  const musicIsLive = !!live && (live.releases || []).some((r) => r.tracks?.length);
  const tabs = [["home", "Home"], ["website", "Website"], ["music", "Music"], ["earnings", "Earnings"], ["settings", "Profile"]];
  const links = (
    <>
      {/* The artist's page, not the manifest: it previews as a card with their
          name and picture when pasted into a message, and its button opens
          the app. The app accepts it as it is. */}
      <CopyButton text={`${node.url}/`} label="Copy your link" />
      <a class="quiet-link" href={node.url} target="_blank" rel="noopener">Your page ↗</a>
    </>
  );

  return (
    <Jobs.Provider value={jobsApi}>
    <Fees.Provider value={feesStatus}>
      <header class="top">
        <div class="top-in">
          <span class="top-mark">
            <span class="mark">
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="7.93" y="1.2" width="1.01" height="17.99" rx="0.51" />
                <rect x="7.93" y="18.18" width="1.01" height="1.01" />
                <rect x="10.44" y="2.42" width="1.01" height="9.22" rx="0.51" />
                <rect x="12.59" y="4.12" width="1.08" height="6.7" rx="0.54" />
                <rect x="15.71" y="0.35" width="0.89" height="12.06" rx="0.45" />
                <rect x="17.82" y="2.4" width="1.13" height="8.45" rx="0.56" />
                <rect x="20.94" y="1.18" width="1.03" height="10.57" rx="0.52" />
                <rect x="22.96" y="4.91" width="1.03" height="13.72" rx="0.52" />
                <rect x="22.96" y="17.6" width="1.03" height="1.03" />
                <circle cx="4.47" cy="19.19" r="4.47" />
                <circle cx="19.49" cy="18.63" r="4.5" />
              </svg>
              amply
            </span>
            <span class="where">your workspace</span>
          </span>

          <div class="top-right">
            {/* Two wordings each, and the stylesheet shows one. A phone has
                room for "2 not live" and "Publish", not the full sentences. */}
            <span class={`state${dirty ? "" : " clean"}`}>
              <span class="dot" aria-hidden="true" />
              <span class="long">
                {live === null
                  ? "Nothing published yet"
                  : dirty
                    ? `${changes} change${changes === 1 ? "" : "s"} not live yet`
                    : "Everything is live"}
              </span>
              <span class="short">
                {live === null ? "Not live" : dirty ? "Unpublished" : "Live"}
              </span>
            </span>
            <button class="btn sm publish" disabled={!dirty || saving} onClick={publish}>
              <span class="long">{saving ? "Publishing…" : "Publish changes"}</span>
              <span class="short">{saving ? "…" : "Publish"}</span>
            </button>
            <button class="menu-btn" aria-expanded={menu} aria-controls="menu-pop" aria-label={menu ? "Close menu" : "Menu"}
              onClick={() => setMenu((m) => !m)}>
              {menu
                ? <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                : <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>}
            </button>
          </div>
        </div>

        <nav class="tabs-in" aria-label="Sections">
          <div class="tablist" role="tablist">
            {tabs.map(([id, label]) => (
              <button
                key={id} class="tab" role="tab" aria-selected={tab === id}
                onClick={() => go(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <div class="tabs-right">{links}</div>
        </nav>

        {/* On a phone: the sections and links in a pop-out menu instead. */}
        {menu && (
          <div class="menu-pop" id="menu-pop">
            <nav aria-label="Sections">
              {tabs.map(([id, label]) => (
                <button key={id} class={`menu-item${tab === id ? " on" : ""}`} aria-current={tab === id ? "page" : undefined}
                  onClick={() => go(id)}>{label}</button>
              ))}
            </nav>
            <div class="menu-links">{links}</div>
          </div>
        )}
      </header>

      <main class="page">
        {/* On a phone the header has no room for these. */}
        <div class="page-links">{links}</div>
        {temporary && <Temporary api={api} initial={temporary} />}
        <div class="toasts">
          {jobs.map((j) => <JobCard key={j.id} job={j} />)}
          <Banner kind={msg?.kind} action={msg?.action} onDismiss={() => setMsg(null)}>{msg?.text}</Banner>
          {/* The service updated, but this editor didn't come with it: only a
              rebuild puts the matching one in place. */}
          {editorBehind && (
            <div class="banner update" role="status">
              <span>Your editor is out of date.</span>
              <a class="link" href="https://amply.stream/repair" target="_blank" rel="noopener">Rebuild</a>
            </div>
          )}
          {/* Fans can't pay until the fees account pays their network fee, so
              until then they listen free. Said everywhere, until it's fixed. */}
          {feesOn === false && (wasLive || payees.some((p) => p.address)) && !notPaidHidden && (
            <div class="banner error not-paid" role="alert">
              <span><b>You're not getting paid.</b> Songs are free until you set up your transaction fees to let listeners pay you.</span>
              <button class="link" onClick={() => { setTab("earnings"); setTimeout(() => document.getElementById("fees")?.scrollIntoView({ behavior: "smooth" }), 50); }}>Add $5</button>
              <button class="link dismiss" onClick={hideNotPaid}>I understand. Don't show this again.</button>
            </div>
          )}
          {!editorBehind && isNewer(newer, version) && !updateHidden && (
            <div class="banner update" role="status">
              <span>A newer version of Amply is ready ({newer}).</span>
              <a class="link" href="https://amply.stream/repair" target="_blank" rel="noopener">Update</a>
              <button class="link" onClick={() => setUpdateHidden(true)}>later</button>
            </div>
          )}
        </div>

        {menu && <button class="menu-scrim" aria-label="Close menu" onClick={() => setMenu(false)} />}

        {tab === "home" && (
          <HomeTab api={api} manifest={live || manifest} payees={payees} live={musicIsLive}
            rate={livePayment?.ratePerMinute ?? 0} settleAt={livePayment?.settleAt ?? 1}
            network={livePayment?.network || "solana"} onGo={go} />
        )}

        {tab === "website" && (
          <SiteEditor site={site} setSite={setSite} manifest={next} nodeUrl={node.url} art={art} notify={notify} />
        )}

        {tab === "music" && (
          <MusicTab
            manifest={manifest} node={node} update={update}
            upload={upload} art={art} notify={notify} player={player}
            sizeOf={api.sizeOf} charging={charging} readAudio={api.readAudio} deleteObject={api.deleteObject}
            live={musicIsLive} onSettings={() => setTab("earnings")}
            paid={payees.some((p) => p.address) || (next.payment || []).some((p) => p.type === "stripe-subscription")}
          />
        )}
        {tab === "settings" && (
          <SettingsTab
            manifest={manifest} payees={payees} setPayees={setPayees}
            update={update} art={art} everPublished={live !== null} api={api}
            dirty={dirty} saving={saving} onPublish={publish} onSignOut={onSignOut}
            liveAddresses={readPayees(live || { payment: [] }).map((p) => p.address).filter(Boolean)}
          />
        )}
        {tab === "earnings" && (
          <EarningsTab
            node={node} api={api} payees={payees} setPayees={setPayees}
            manifest={manifest} update={update} live={live}
            held={!perMinute} feesOn={feesOn} onPublish={publish}
            // What listeners are actually charged is what is published, not
            // what is in the editor: a price changed and not yet published
            // must not make a listener look like they are underpaying.
            rate={livePayment?.ratePerMinute ?? 0}
            network={livePayment?.network || "solana"}
            settleAt={livePayment?.settleAt ?? 1}
          />
        )}
      </main>

      <PlayerBar player={player} />
    </Fees.Provider>
    </Jobs.Provider>
  );
}

/** Read duration from the file itself, the manifest requires it, and a player
 *  must never download audio just to learn how long a track is. */
export function readDuration(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const done = (fn, v) => { URL.revokeObjectURL(url); fn(v); };
    audio.addEventListener("loadedmetadata", () => {
      const d = Math.round(audio.duration);
      if (!Number.isFinite(d) || d <= 0) done(reject, new Error("Its length could not be read."));
      else done(resolve, d);
    });
    audio.addEventListener("error", () => done(reject, new Error("It could not be read as audio.")));
    audio.src = url;
  });
}

/** A file's size as a person would say it. */
const bytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Safe object keys: the node rejects anything else before it reaches storage. */
export function safeKey(name) {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "") : "bin";
  const base = (dot > 0 ? name.slice(0, dot) : name)
    .toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "track";
  return `${base}-${Date.now().toString(36)}.${ext}`;
}

export { Banner };
