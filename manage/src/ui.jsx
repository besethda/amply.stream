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
import { useState, useEffect, useCallback, useRef, useMemo } from "preact/hooks";
import { validate } from "../../spec/manifest-rules.mjs";
import { charges, SETTLE_WITHIN_DAYS } from "../../spec/pricing.mjs";
import { bareDomain, recordFor, lookup, confirms } from "../../spec/domain.mjs";
import { makeWaves, wavesKey } from "./waves.js";
import { coverColors } from "./colors.js";
import { shrink, COVER_PX, BANNER_PX } from "./images.js";

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
function CopyButton({ text, label, className = "quiet-link" }) {
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
        } catch {
          // Clipboard access can be refused. Select it instead of failing silently.
          window.prompt("Copy this link:", text);
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

function Track({
  track, first, last, playing, onPlay, onChange, onMove, onRemove, onReplace,
  heavy, warnOpen, onWarn, charging,
}) {
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
          <button class="icon stack2" disabled={first} onClick={() => onMove(-1)} aria-label="Move up">▲</button>
          <button class="icon stack2" disabled={last} onClick={() => onMove(1)} aria-label="Move down">▼</button>
        </div>
        <button
          class={`play${playing ? " on" : ""}`} onClick={onPlay} disabled={!track.url}
          aria-label={playing ? `Pause ${track.title}` : `Play ${track.title}`}
        >
          {playing ? "❚❚" : "▶"}
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
              class="warn-toggle" aria-expanded={warnOpen} onClick={onWarn}
              aria-label={`${track.title || "This track"} is too large to stream properly. ${warnOpen ? "Hide" : "Show"} why.`}
              title="Too large to stream properly"
            >!</button>
          )}
        </span>
        <button class={`track-edit-btn${open ? " on" : ""}`} aria-expanded={open}
          aria-label={`${open ? "Close" : "Edit"} ${name}`} onClick={() => setOpen((o) => !o)}>
          <span class="edit-word">{open ? "Done" : "Edit"}</span>
          <span class="edit-icon" aria-hidden="true">{open ? "✓" : "✎"}</span>
        </button>
        <input
          ref={ref} type="file" accept={AUDIO_ACCEPT} hidden
          onChange={(e) => { const f = e.target.files[0]; e.target.value = ""; if (f) onReplace(f); }}
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
          <button class="btn ghost danger" onClick={onRemove}>Remove</button>
        </div>
      )}
    </div>
  );
}

function Release({
  release, node, manifest, art, player,
  onChange, onRemove, upload, notify, sizeOf, charging,
}) {
  const [problems, setProblems] = useState([]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(0);
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
  const setTracks = (t) => onChange({ ...release, tracks: t });

  /**
   * Upload a song, and beside it its waves file (spec/waves.mjs), worked out
   * here from the file in hand while the song uploads. The song is what
   * matters: if the waves can't be made or sent, it goes up without them.
   */
  async function uploadSong(file, duration) {
    const key = `audio/${safeKey(file.name)}`;
    const [, waves] = await Promise.all([
      upload(key, file),
      makeWaves(file, duration).then(async (bytes) => {
        const at = wavesKey(key);
        await upload(at, new Blob([bytes], { type: "application/octet-stream" }));
        return `${node.url}/${at}`;
      }).catch(() => null),
    ]);
    noteSize(`${node.url}/${key}`, file.size);
    return { url: `${node.url}/${key}`, ...(waves ? { waves } : {}) };
  }

  /** Put one audio file on the node and hand back a manifest track. */
  async function ingest(file, taken) {
    if (file.size > MAX_UPLOAD) {
      throw new Error(`It is larger than ${Math.round(MAX_UPLOAD / 1048576)}MB, which is the most your streaming service accepts in one go.`);
    }
    const duration = await readDuration(file);
    const song = await uploadSong(file, duration);
    const title = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
    const id = makeId(title, taken);
    taken.add(id);
    return { id, title, duration, ...song };
  }

  async function addFiles(files) {
    const taken = collectIds(manifest);
    const added = [];
    const failed = [];
    setBusy(files.length);
    for (const file of Array.from(files)) {
      try {
        added.push(await ingest(file, taken));
      } catch (e) {
        failed.push({ key: `${file.name}-${Date.now()}`, file, message: e.message });
      } finally {
        setBusy((n) => n - 1);
      }
    }
    if (added.length) setTracks([...tracks, ...added]);
    if (failed.length) setProblems((p) => [...p, ...failed]);
  }

  async function retry(problem) {
    setProblems((p) => p.filter((x) => x !== problem));
    await addFiles([problem.file]);
  }

  async function replaceAudio(i, file) {
    try {
      setBusy((n) => n + 1);
      const duration = await readDuration(file);
      const song = await uploadSong(file, duration);
      // The id never changes: listeners' saved state keys off it, and this is
      // the same song with a better master, not a new one. The old waves
      // belong to the old audio, so they go even if new ones couldn't be made.
      setTracks(tracks.map((t, j) => {
        if (j !== i) return t;
        const { waves, ...rest } = t;
        return { ...rest, duration, ...song };
      }));
      notify("ok", `Replaced the audio on “${tracks[i].title}”.`);
    } catch (e) {
      notify("error", `Could not replace that audio: ${e.message}`);
    } finally {
      setBusy((n) => n - 1);
    }
  }

  const moveTrack = (i, delta) => {
    const t = [...tracks];
    const j = i + delta;
    if (j < 0 || j >= t.length) return;
    [t[i], t[j]] = [t[j], t[i]];
    setTracks(t);
  };

  return (
    <section class="card release">
      <div class="release-head">
        <ImagePick
          cls="release-art" url={release.art} alt={`${release.title} cover`}
          onPick={(f) => art(f, async (url) => {
            // Its colours (spec/colors.mjs), for listening apps to tint
            // themselves with. A new cover's replace the old one's.
            const { colors: _old, ...rest } = release;
            const colors = await coverColors(f);
            onChange({ ...rest, art: url, ...(colors ? { colors } : {}) });
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
            onInput={(v) => onChange({ ...release, title: v })}
          />
          <span class="count">
            {busy > 0
              ? `uploading ${busy} file${busy === 1 ? "" : "s"}…`
              : `${tracks.length} track${tracks.length === 1 ? "" : "s"} ready`}
          </span>
        </div>

        <div class="release-side">
          <label class="side-field">
            <span class="label">Released</span>
            <input
              type="date" value={release.date || ""}
              onInput={(e) => onChange({ ...release, date: e.target.value || undefined })}
            />
          </label>
          <label class="side-field">
            <span class="label">Price <Help about="the album's price">What the whole album costs to buy and keep. Leave it empty if it isn't for sale.</Help></span>
            <span class="release-price">
              <span>$</span>
              <input type="number" min="0.5" max="1000" step="0.01" placeholder="—"
                value={release.sale?.price ?? ""} aria-label="Price to buy this album, in dollars"
                onInput={(e) => {
                  const price = salePrice(e.target.value);
                  const { sale: _was, ...rest } = release;
                  onChange(price ? { ...rest, sale: { ...(release.sale || {}), price } } : rest);
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
              onPlay={() => player.toggle(t)}
              onMove={(d) => moveTrack(i, d)}
              onReplace={(f) => replaceAudio(i, f)}
              onChange={(next) => setTracks(tracks.map((x, j) => (j === i ? next : x)))}
              onRemove={() => { player.stopIf(t.id); setTracks(tracks.filter((_, j) => j !== i)); }}
              heavy={!!sizeAdvice(sizes[t.url], t.duration)}
              warnOpen={warnOpen === t.id}
              onWarn={() => setWarnOpen((open) => (open === t.id ? null : t.id))}
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
              <button class="play" disabled aria-hidden="true">▶</button>
              <span class="track-title" style="opacity:.55">{p.file.name}</span>
              <span class="track-dur">–</span>
            </div>
            <div class="track-problem">
              <div class="what">
                <strong>This one didn't finish uploading</strong>
                <p>{p.message} Nothing else was affected, the file is still on your computer.</p>
              </div>
              <button class="btn sm dark" onClick={() => retry(p)}>Try again</button>
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
        <button class="link" onClick={onRemove}>Delete this release</button>
      </div>
    </section>
  );
}

function MusicTab({ manifest, node, update, upload, art, notify, player, sizeOf, charging }) {
  const trackCount = (manifest.releases || []).reduce((n, r) => n + (r.tracks?.length || 0), 0);

  const addRelease = () => {
    const taken = collectIds(manifest);
    update({
      ...manifest,
      releases: [...(manifest.releases || []), { id: makeId("release", taken), title: "", tracks: [] }],
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
        {(manifest.releases || []).map((r, i) => (
          <Release
            key={r.id} release={r} node={node} manifest={manifest} charging={charging}
            upload={upload} art={art} notify={notify} player={player} sizeOf={sizeOf}
            onChange={(next) =>
              update({ ...manifest, releases: manifest.releases.map((x, j) => (j === i ? next : x)) })}
            onRemove={() =>
              update({ ...manifest, releases: manifest.releases.filter((_, j) => j !== i) })}
          />
        ))}

        {!manifest.releases?.length && (
          <section class="card nothing">
            <h2>Nothing here yet. <Help about="releases">A release is an album, an EP or a single. Make one, add your audio, and publish.</Help></h2>
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

function Price({ wallet, onChange, hasAddress, subscribing }) {
  const rate = wallet.ratePerMinute ?? 0.01;
  const song = rate * TYPICAL_SONG_MIN;
  return (
    <section class="card">
      <h2>Your price <Help at="price" about="your price">Listeners pay by the minute, so a long piece is worth more than a short one.</Help></h2>
      {!hasAddress && (wallet.ratePerMinute ?? 0.01) > 0 && (
        <p class="price-pending">
          Your price isn't on your page yet, because there's nowhere for the money to go. Add a
          payment address under Who gets paid and it will publish with it. Until then your music
          is free to listen to.
        </p>
      )}

      <div class="price-grid">
        <div class="price-set">
          <div class="price-now">
            {/* Typeable, for anyone who wants an exact figure rather than a
                feel. Held in cents because that is the unit on screen. */}
            <input
              type="number" class="price-input"
              min="0" max={RATE_MAX * 100} step="0.01"
              value={Number((rate * 100).toFixed(2))}
              aria-label="Price per minute, in cents"
              onInput={(e) => {
                const c = Number(e.target.value);
                if (!Number.isFinite(c)) return;
                const clamped = Math.min(Math.max(c, 0), RATE_MAX * 100);
                // Cents to dollars, at the same hundredth-of-a-cent
                // resolution the slider works in.
                onChange(withPrice(wallet, Math.round(clamped * 100) / 10000));
              }}
            />
            <span class="unit">¢</span>
            <span>a minute</span>
          </div>
          <input
            type="range" min="0" max={SLIDER_STEPS} step="1" value={toSlider(rate)}
            aria-label="Price per minute"
            aria-valuetext={`${cents(rate)} a minute`}
            onInput={(e) => onChange(withPrice(wallet, fromSlider(Number(e.target.value))))}
          />
          <div class="scale"><span>free</span><span>{cents(RATE_MAX)}</span></div>
        </div>

        <div class="price-says">
          <b>
            {rate === 0
              ? (subscribing ? "Not charged by the minute." : "Free to listen to.")
              : `About ${cents(song)} for a ${TYPICAL_SONG_MIN}-minute song.`}
          </b>
          <p>
            {rate === 0
              ? (subscribing
                  ? "Listeners pay by subscription only. Set a price here to offer both."
                  : "Nobody is charged. You can change this at any time.")
              : `Ten songs comes to about ${cents(song * 10)}.`}
          </p>
        </div>
      </div>
    </section>
  );
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
        <p class="muted">Only selling songs and albums?{" "}
          <button class="link" disabled={busy} onClick={salesOnly}>Connect for music only</button></p>
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
      <h2>Subscriptions <span class="note">optional</span>
        <Help at="subscriptions" about="subscriptions">Fans pay by card, through your own Stripe account, for a year
          or for six or three months of everything you charge for. Subscribers aren't charged by the minute and
          need no crypto wallet. Offer it instead of your per-minute price (set that to free) or alongside it.
          Stripe pays you directly and takes its usual fee; Amply takes nothing.{" "}
          <a href="https://amply.stream/stripe" target="_blank" rel="noopener">Step-by-step guide ↗</a></Help></h2>

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

function Payout({ wallet, onChange, subscribing }) {
  const rate = wallet.ratePerMinute ?? 0.01;
  const batch = batchOf(wallet);
  const amount = settleFor(batch, rate);
  return (
    <section class="card">
      <h2>How often listeners pay <Help at="batching" about="how often listeners pay">Each payment goes straight
        from the listener to you, and Amply never touches it. Their app pays as they listen without asking each
        time, so this is about the cost of sending money, not interruptions. Anything smaller is paid within a
        week, the next time they open Amply.</Help></h2>
      <div class="choices">
        {BATCHES.map((b) => (
          <button
            key={b} class="choice" aria-pressed={batch === b}
            onClick={() => onChange({ ...wallet, settleAt: settleFor(b, rate) })}
          >
            {b === 1 ? "Every song" : `Every ${b} songs`}
          </button>
        ))}
      </div>
      <p class="payout-says">
        {rate === 0
          ? (subscribing ? "You don't charge by the minute, so there's nothing here to pay in batches." : "Your music is free, so listeners never pay.")
          : batch === 1
            ? `You are paid after each song, about ${cents(amount)} each time.`
            : `You are paid about ${cents(amount)} every ${batch} songs.`}
      </p>

      <TestMoney wallet={wallet} onChange={onChange} />
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
        <span>Pay me in play money, for testing</span>
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

function Splits({ payees, rate, onChange }) {
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
      <h2>Who gets paid <span class="note">split every payment</span>
        <Help at="wallet" about="who gets paid">Each payment is divided the moment it's made and sent straight to
          these Solana addresses; it never passes through Amply. No address yet? <strong>Phantom</strong> is free
          and takes a couple of minutes. Use your own wallet, not an exchange's deposit address.</Help></h2>

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
              <Field label="Where their share goes">
                <Text
                  value={p.address} class="mono" placeholder="their payment address"
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
          + Add someone
        </button>
        {payees.length > 1 && (
          <button class="btn ghost" onClick={evenly}>Split evenly</button>
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
      <h2>Your own domain <span class="note">recommended</span>
        <Help about="linking your domain">Listeners can add you by typing your domain, and see it next to
          your name, which is how they know it's really you. Your website doesn't change.</Help></h2>

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

function SettingsTab({ manifest, payees, setPayees, update, art, everPublished, dirty, saving, onPublish, api, onSignOut }) {
  const artist = manifest.artist || {};
  const wallet = (manifest.payment || []).find((p) => p.type === "solana-usdc")
    || { type: "solana-usdc", ratePerMinute: 0.01, settleAt: settleFor(DEFAULT_BATCH, 0.01) };
  const links = artist.links || [];

  const setArtist = (next) => update({ ...manifest, artist: { ...artist, ...next } });
  const setWallet = (next) => {
    const rest = (manifest.payment || []).filter((p) => p.type !== "solana-usdc");
    update({ ...manifest, payment: [next, ...rest] });
  };
  const setLinks = (next) =>
    setArtist({ links: next.length ? next : undefined });

  return (
    <>
      <div class="page-head"><h1>Settings</h1></div>

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

            <Field
              label="Contact for listeners' data"
              hint={<>
                An email address or a web page, shown on your{" "}
                <a href="/privacy" target="_blank" rel="noopener">privacy page</a>. If you charge, you
                hold a record of who listens, and they must be able to reach you about it.{" "}
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

        <OwnDomain manifest={manifest} update={update} />

        <Price wallet={wallet} onChange={setWallet} hasAddress={payees.some((p) => p.address)}
          subscribing={(manifest.payment || []).some((p) => p.type === "stripe-subscription")} />
        <Subscriptions manifest={manifest} update={update} api={api} />
        <Payout wallet={wallet} onChange={setWallet}
          subscribing={(manifest.payment || []).some((p) => p.type === "stripe-subscription")} />
        <Splits payees={payees} rate={wallet.ratePerMinute ?? 0} onChange={setPayees} />

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

        <section class="card publish-card">
          <div>
            <h2>
              {!everPublished
                ? "Nothing is on your page yet"
                : dirty ? "You have changes that aren't live" : "Everything here is live"}
            </h2>
            <p class="muted">Changes stay here until you publish.</p>
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
const KEPT = "amply.payments.v1";

function usePayments(payees, declared) {
  // Whichever chain the artist publishes is the one their listeners pay on, so
  // it is the only one worth reading. A local preference here could quietly
  // disagree with the manifest and show an artist an empty table while they
  // were being paid.
  const network = declared === "devnet" ? "devnet" : "mainnet";

  const addresses = (payees || []).map((p) => p.address).filter(Boolean);
  const key = `${KEPT}.${addresses.join(",")}`;

  const [state, setState] = useState(() => {
    try { return { ...JSON.parse(localStorage.getItem(key)), busy: false }; }
    catch { return { busy: false }; }
  });

  async function look(net = network) {
    if (!addresses.length) return;
    setState((s) => ({ ...s, busy: true, error: null }));
    try {
      const { paymentsTo } = await import("./chain.js");
      const byWallet = {};
      let total = 0;
      // Every address in the split, because a listener's payment is divided
      // between them: what the listener paid is the sum, not any one share.
      for (const address of addresses) {
        const one = await paymentsTo(address, net);
        total += one.total;
        for (const [wallet, sum] of Object.entries(one.byWallet)) {
          const had = byWallet[wallet] || { micros: 0, payments: 0, last: 0 };
          byWallet[wallet] = {
            micros: had.micros + sum.micros,
            payments: Math.max(had.payments, sum.payments),
            last: Math.max(had.last, sum.last),
          };
        }
      }
      const next = { byWallet, total, at: Date.now(), network: net };
      try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* fine */ }
      setState({ ...next, busy: false });
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

/** Micros of a dollar, as money. */
const fromMicros = (m) => `$${(m / 1_000_000).toFixed(m < 1_000_000 ? 4 : 2)}`;

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
  const slack = Math.max(5_000, owedMicros * 0.1);
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
function Listeners({ api, payees, rate, network, settleAt }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = () => api.listeners().then(setRows).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const paid = usePayments(payees, network);

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
    const barred = row.blocked ? " It is barred now, and deleting lifts the bar too." : "";
    if (!window.confirm(`Delete everything held about ${row.pubkey.slice(0, 6)}…${row.pubkey.slice(-4)}?${barred} This can't be undone.`)) return;
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

  if (error) return <Banner kind="error">{error}</Banner>;
  if (!rows) return <p class="muted">Looking…</p>;

  if (!rows.length) {
    return (
      <section class="card nothing">
        <h2>No listeners yet. <Help at="free" about="listeners">Every wallet that plays your paid tracks appears
          here, next to what it has paid you, and you can stop serving anyone who hasn't. Tracks you've made free
          play for anyone and are never counted.</Help></h2>
      </section>
    );
  }

  return (
    <section class="card">
      <h2>Your listeners <span class="note">{rows.length}</span>
        <Help at="banning" about="your listeners">One line per wallet: how much they listened, never what or when.
          <strong> Paid</strong> is read from the chain in this browser; a figure in red owes more than one payment's
          worth. <strong>Overdue</strong> means listening more than a week old is unpaid, often just because they
          haven't opened Amply since. <strong>Stop serving</strong> takes your paid tracks away within half an hour.
          If someone asks what you hold about them, or to delete it, use <strong>Export</strong> or
          <strong> Delete</strong>. Records go a year after a wallet was last heard from.</Help></h2>

      <div class="reconcile">
        <span class="muted">
          {!paid.addresses.length
            ? "Add a payment address in Settings and this will show who has paid."
            : paid.busy
              ? "Reading payments from the chain…"
              : paid.error
                ? paid.error
                : paid.at
                  ? `Payments read ${new Date(paid.at).toLocaleTimeString()}. ${fromMicros(paid.total || 0)} in total.`
                  : "Payments not read yet."}
        </span>
        <span class="reconcile-do">
          {paid.network === "devnet" && <span class="note">play money</span>}
          <button class={`icon refresh${paid.busy ? " turning" : ""}`} disabled={paid.busy || !paid.addresses.length}
            onClick={paid.look} aria-label="Read payments again" title="Read payments again">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M20 12a8 8 0 1 1-2.34-5.66" /><path d="M20 4v5h-5" />
            </svg>
          </button>
        </span>
      </div>

      <table class="listeners">
        <thead>
          <tr>
            <th>Wallet</th><th>Plays</th><th>Listened</th>
            <th>Paid</th>
            <th>Last heard</th><th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const got = (paid.byWallet || {})[r.pubkey];
            // What the time they listened would have cost at today's rate.
            // Approximate on purpose: the price may have changed since, and
            // free tracks are never counted here at all.
            const owed = rate > 0 ? ((r.seconds || 0) / 60) * rate * 1_000_000 : 0;
            // Behind means owing more than their app is allowed to hold back:
            // up to one payment's worth unpaid is exactly what the artist's
            // own setting asks for, and flagging less would put an honest
            // listener in red a few songs in. Overdue is the other way to fall
            // short: a small amount, kept past the week.
            // A subscriber pays by card, not by the minute: never either while
            // their subscription runs.
            const subscribed = r.subscribed_until && r.subscribed_until > Date.now();
            const counted = !subscribed && paid.at;
            const short = counted && behind(owed, got?.micros || 0, settleAt);
            const late = counted && overdue(owed, got?.micros || 0, r.last_seen);
            return { r, got, owed, subscribed, short, overdue: late };
          }).sort(rank).map(({ r, got, owed, subscribed, short, overdue: late }) => {
            return (
            <tr key={r.pubkey} class={`${r.blocked ? "blocked" : ""}${late ? " late" : ""}`}>
              <td class="mono" data-k="Wallet" title={r.pubkey}>{r.pubkey.slice(0, 6)}…{r.pubkey.slice(-4)}</td>
              <td data-k="Plays">{r.plays}</td>
              <td data-k="Listened">{Math.round((r.seconds || 0) / 60)} min</td>
              <td data-k="Paid" class={short ? "short" : ""} title={got?.payments ? `${got.payments} payments, last ${new Date(got.last).toLocaleDateString()}` : ""}>
                {subscribed
                  ? `subscriber to ${new Date(r.subscribed_until).toLocaleDateString()}`
                  : !paid.at ? "—" : got ? fromMicros(got.micros) : "nothing"}
                {late && (
                  <span class="overdue" title="Owes for listening more than a week old. Their app pays the next time it's opened.">
                    overdue · owes {fromMicros(Math.max(0, owed - (got?.micros || 0)))}
                  </span>
                )}
              </td>
              <td data-k="Last heard">{new Date(r.last_seen).toLocaleDateString()}</td>
              <td class="row-do">
                <button
                  class="link" disabled={busy === r.pubkey}
                  onClick={() => block(r, !r.blocked)}
                >{r.blocked ? "Serve again" : "Stop serving"}</button>
                <button class="link quiet" onClick={() => exportRow(r)}
                  title="Everything held about this wallet, as a file you can send them">Export</button>
                <button class="link quiet danger" disabled={busy === r.pubkey}
                  onClick={() => removeRow(r)}
                  title="Delete this wallet's record entirely">Delete</button>
              </td>
            </tr>
          );})}
        </tbody>
      </table>
    </section>
  );
}

function EarningsTab({ node, published, api, payees, rate, network, settleAt }) {
  return (
    <>
      <div class="page-head">
        <h1>Earnings</h1>
      </div>

      <div class="stack">
      <Listeners api={api} payees={payees} rate={rate} network={network} settleAt={settleAt} />

      <section class="card nothing">
        <h2>Getting started</h2>

        <ol class="steps">
          <li>
            <span class="n">1</span>
            <span class="t">Your music is up and published</span>
            <span class="s">{published ? "done" : "not yet"}</span>
          </li>
          <li>
            <span class="n">2</span>
            <span class="t">Send your link to people who already listen</span>
            <span class="s">up to you</span>
          </li>
        </ol>

        <div class="copy-row">
          <CopyButton text={node.url} label="Copy your link" className="btn sm" />
          <code>{node.url.replace(/^https:\/\//, "")}</code>
        </div>

      </section>
      </div>
    </>
  );
}

// ── the player ──────────────────────────────────────────────────────────────

function usePlayer() {
  const audio = useRef(null);
  const [current, setCurrent] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const [of, setOf] = useState(0);

  useEffect(() => {
    const a = new Audio();
    a.preload = "none";
    audio.current = a;
    const tick = () => { setAt(a.currentTime); setOf(a.duration || 0); };
    a.addEventListener("timeupdate", tick);
    a.addEventListener("loadedmetadata", tick);
    a.addEventListener("ended", () => { setPlaying(false); setAt(0); });
    a.addEventListener("pause", () => setPlaying(false));
    a.addEventListener("play", () => setPlaying(true));
    return () => { a.pause(); a.src = ""; };
  }, []);

  const toggle = (track) => {
    const a = audio.current;
    if (!a || !track.url) return;
    if (current?.id === track.id) {
      if (a.paused) a.play().catch(() => {}); else a.pause();
      return;
    }
    a.src = track.url;
    setCurrent(track);
    setAt(0);
    a.play().catch(() => {});
  };

  const stop = () => {
    audio.current?.pause();
    setCurrent(null);
  };

  return {
    current: current?.id ?? null, track: current, playing, at, of,
    toggle, stop,
    stopIf: (id) => { if (current?.id === id) stop(); },
  };
}

function PlayerBar({ player }) {
  if (!player.track) return null;
  const pct = player.of ? (player.at / player.of) * 100 : 0;
  return (
    <div class="player">
      <div class="player-track"><i style={`width:${pct}%`} /></div>
      <div class="player-in">
        <button
          class={`play${player.playing ? " on" : ""}`}
          onClick={() => player.toggle(player.track)}
          aria-label={player.playing ? "Pause" : "Play"}
        >
          {player.playing ? "❚❚" : "▶"}
        </button>
        <div class="what">
          <b>{player.track.title || "Untitled"}</b>
          <span>only you can hear this, it is not a listen anyone paid for</span>
        </div>
        <span class="time">{mmss(player.at)} / {mmss(player.of || player.track.duration)}</span>
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
  const { address, recipients, ...rest } = wallet;
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
export function buildManifest(manifest, payees) {
  const rest = (manifest.payment || []).filter((p) => p.type !== "solana-usdc");
  // An artist who fills in an address but never touches the price slider has no
  // wallet in the manifest yet. Their address still has to be published, so
  // fall back to the same defaults the settings tab shows them.
  const wallet = (manifest.payment || []).find((p) => p.type === "solana-usdc")
    || { type: "solana-usdc", ratePerMinute: 0.01, settleAt: settleFor(DEFAULT_BATCH, 0.01) };
  const paid = writePayees(wallet, payees);
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
  if (/^artist\.name$/.test(path)) return "Add the name you release under, in Settings.";
  if (/^artist\.links\[(\d+)\]\.url$/.test(path)) {
    const n = Number(path.match(/links\[(\d+)\]/)[1]) + 1;
    return `Link ${n} in Settings needs a full address, starting with https://`;
  }
  if (/^artist\.links\[(\d+)\]\.label$/.test(path)) {
    const n = Number(path.match(/links\[(\d+)\]/)[1]) + 1;
    return `Link ${n} in Settings needs a label, like Bandcamp or Instagram.`;
  }
  if (/address$/.test(path)) return "A payment address in Settings doesn't look right. It should be a Solana address: 32 to 44 letters and numbers.";
  if (/recipients$/.test(path) && /total/.test(detail)) return `The shares in Settings ${detail.replace(/^splits must total 100%, got /, "add up to ").replace(/$/, ", not 100%")}.`;
  if (/^licence\.url$/.test(path)) return "Your own terms need the address where they are published, in Settings.";
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

export function Editor({ api, node, initial, published = true, initialTab = "music", version = null, onSignOut }) {
  const [manifest, setManifest] = useState(initial);
  const [payees, setPayees] = useState(() => readPayees(initial));
  // What the page is actually serving. null on a node that has never published.
  const [live, setLive] = useState(() => (published ? initial : null));
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState(initialTab);
  const [msg, setMsg] = useState(null);
  const player = usePlayer();
  const newer = useUpdate(version);

  const next = useMemo(() => buildManifest(manifest, payees), [manifest, payees]);
  // From what will be published, not the draft: a price only charges anyone
  // once there is an address to pay, and that lives with the payees.
  const charging = useMemo(() => charges(next), [next]);
  const livePayment = ((live || manifest).payment || []).find((p) => p.type === "solana-usdc");
  const changes = useMemo(() => (live ? countChanges(live, next) : 0), [live, next]);
  const dirty = live === null || changes > 0;

  const notify = (kind, text, action = null) => setMsg({ kind, text, action });
  const update = useCallback((m) => setManifest(m), []);

  // Browsers only honour this after the page has been interacted with, which is
  // exactly when there is unsaved work worth protecting.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const upload = (key, file) => api.putObject(key, file);

  /**
   * Put an image on the node and hand its public URL back to the caller —
   * made the right size first (images.js), so listeners download a few
   * hundred KB rather than a phone photo's megabytes.
   */
  const art = useCallback(async (original, done, longest = COVER_PX) => {
    const file = await shrink(original, longest);
    if (file.size > MAX_ART) {
      notify("error", `That picture is larger than ${Math.round(MAX_ART / 1048576)}MB. A smaller one will load faster for everyone anyway.`);
      return;
    }
    try {
      const key = `art/${safeKey(file.name)}`;
      await api.putObject(key, file);
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
      notify("error", `Could not upload that picture: ${e.message}`);
    }
  }, [api, node.url]);

  async function publish() {
    let out = buildManifest(manifest, payees);

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
      setTab("settings");
      notify("error", "Nothing was published. To sell songs and albums, connect Stripe (for cards) or add a payment address (for USDC), in Settings.");
      return;
    }

    // The same rules a listening app will apply. If they reject it, nothing is
    // sent: a manifest that fails them is a page no client will read.
    const { errors } = validate(out);
    if (errors.length) {
      const first = errors[0];
      if (/^(artist|payment|licence)/.test(first)) setTab("settings");
      else setTab("music");
      const more = errors.length > 1 ? ` (and ${errors.length - 1} more thing${errors.length > 2 ? "s" : ""} to fix)` : "";
      notify("error", `Nothing was published. ${explain(first, out)}${more}`);
      return;
    }

    setSaving(true);
    try {
      await api.writeManifest(out);
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
  const tabs = [["music", "Music"], ["settings", "Settings"], ["earnings", "Earnings"]];
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
    <>
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
                {live === null ? "Not live" : dirty ? `${changes} not live` : "Live"}
              </span>
            </span>
            <button class="btn sm publish" disabled={!dirty || saving} onClick={publish}>
              <span class="long">{saving ? "Publishing…" : "Publish changes"}</span>
              <span class="short">{saving ? "…" : "Publish"}</span>
            </button>
          </div>
        </div>

        <nav class="tabs-in" aria-label="Sections">
          <div class="tablist" role="tablist">
            {tabs.map(([id, label]) => (
              <button
                key={id} class="tab" role="tab" aria-selected={tab === id}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <div class="tabs-right">{links}</div>
        </nav>
      </header>

      <main class="page">
        {/* On a phone the header has no room for these. */}
        <div class="page-links">{links}</div>
        <Banner kind={msg?.kind} action={msg?.action} onDismiss={() => setMsg(null)}>{msg?.text}</Banner>

        {isNewer(newer, version) && (
          <div class="banner update" role="status">
            <span>
              There's a newer version of Amply ({newer}; you have {version}). Updates aren't
              automatic, because nobody at Amply can reach your streaming service.
            </span>
            <a class="link" href="https://amply.stream/repair" target="_blank" rel="noopener">
              Update mine
            </a>
          </div>
        )}

        {tab === "music" && (
          <MusicTab
            manifest={manifest} node={node} update={update}
            upload={upload} art={art} notify={notify} player={player}
            sizeOf={api.sizeOf} charging={charging}
          />
        )}
        {tab === "settings" && (
          <SettingsTab
            manifest={manifest} payees={payees} setPayees={setPayees}
            update={update} art={art} everPublished={live !== null} api={api}
            dirty={dirty} saving={saving} onPublish={publish} onSignOut={onSignOut}
          />
        )}
        {tab === "earnings" && (
          <EarningsTab
            node={node} published={musicIsLive} api={api} payees={payees}
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
    </>
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
