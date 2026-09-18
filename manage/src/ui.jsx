/**
 * The editor's interface.
 *
 * It runs in exactly one place: on the artist's own node, behind Cloudflare
 * Access. There is no hosted copy — Amply is not involved in an artist editing
 * their own music, and a second way of doing it would quietly undo that.
 *
 * Talks to an injected `api` adapter rather than fetching directly, so the
 * interface stays testable without a live node.
 */
import { useState, useEffect, useCallback, useRef } from "preact/hooks";

export const MAX_UPLOAD = 90 * 1024 * 1024;

const uid = () => Math.random().toString(36).slice(2, 10);

/** Cloudflare-safe, stable, and never reused — ids are permanent once published. */
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
  `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

// ── small pieces ────────────────────────────────────────────────────────────

const Field = ({ label, hint, children }) => (
  <label class="field">
    <span class="field-label">{label}</span>
    {children}
    {hint && <span class="field-hint">{hint}</span>}
  </label>
);

const Text = ({ value, onInput, ...rest }) => (
  <input type="text" value={value ?? ""} onInput={(e) => onInput(e.target.value)} {...rest} />
);

function Banner({ kind, children, onDismiss }) {
  if (!children) return null;
  return (
    <div class={`banner ${kind}`} role={kind === "error" ? "alert" : "status"}>
      <span>{children}</span>
      {onDismiss && <button class="link" onClick={onDismiss}>dismiss</button>}
    </div>
  );
}

// ── track row ───────────────────────────────────────────────────────────────

function Track({ track, onChange, onRemove, onMove, first, last }) {
  return (
    <li class="track">
      <div class="track-order">
        <button class="icon" disabled={first} onClick={() => onMove(-1)} title="Move up">↑</button>
        <button class="icon" disabled={last} onClick={() => onMove(1)} title="Move down">↓</button>
      </div>
      <div class="track-main">
        <Text value={track.title} onInput={(v) => onChange({ ...track, title: v })}
              placeholder="Track title" class="track-title" />
        <div class="track-meta">
          <span>{mmss(track.duration)}</span>
          <span class="mono">{track.id}</span>
          {track.explicit && <span class="tag">explicit</span>}
        </div>
      </div>
      <div class="track-actions">
        <label class="checkbox">
          <input type="checkbox" checked={!!track.explicit}
                 onChange={(e) => onChange({ ...track, explicit: e.target.checked || undefined })} />
          <span>Explicit</span>
        </label>
        <button class="link danger" onClick={onRemove}>Remove</button>
      </div>
    </li>
  );
}

// ── release ─────────────────────────────────────────────────────────────────

function Release({ release, node, manifest, onChange, onRemove, upload, notify }) {
  const [busy, setBusy] = useState(null);
  const fileRef = useRef(null);

  const setTracks = (tracks) => onChange({ ...release, tracks });

  async function addFiles(files) {
    const taken = collectIds(manifest);
    const added = [];
    for (const file of Array.from(files)) {
      if (file.size > MAX_UPLOAD) {
        notify("error", `${file.name} is too large (max ${Math.round(MAX_UPLOAD / 1048576)}MB).`);
        continue;
      }
      try {
        setBusy(file.name);
        const duration = await readDuration(file);
        const key = `audio/${safeKey(file.name)}`;
        await upload(key, file);
        const title = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
        const id = makeId(title, taken);
        taken.add(id);
        added.push({ id, title, duration, url: `${node.url}/${key}` });
      } catch (e) {
        notify("error", `${file.name}: ${e.message}`);
      } finally {
        setBusy(null);
      }
    }
    if (added.length) setTracks([...(release.tracks || []), ...added]);
  }

  const moveTrack = (i, delta) => {
    const t = [...release.tracks];
    const j = i + delta;
    if (j < 0 || j >= t.length) return;
    [t[i], t[j]] = [t[j], t[i]];
    setTracks(t);
  };

  return (
    <section class="release">
      <header class="release-head">
        <Text value={release.title} onInput={(v) => onChange({ ...release, title: v })}
              placeholder="Release title" class="release-title" />
        <button class="link danger" onClick={onRemove}>Delete release</button>
      </header>

      <div class="row">
        <Field label="Release date">
          <input type="date" value={release.date || ""}
                 onInput={(e) => onChange({ ...release, date: e.target.value || undefined })} />
        </Field>
        <Field label="Identifier" hint="Fixed once published — listeners' saved state keys off it.">
          <input type="text" value={release.id} disabled class="mono" />
        </Field>
      </div>

      <ul class="tracks">
        {(release.tracks || []).map((t, i) => (
          <Track key={t.id} track={t} first={i === 0} last={i === release.tracks.length - 1}
                 onMove={(d) => moveTrack(i, d)}
                 onChange={(next) => setTracks(release.tracks.map((x, j) => (j === i ? next : x)))}
                 onRemove={() => setTracks(release.tracks.filter((_, j) => j !== i))} />
        ))}
        {!release.tracks?.length && <li class="empty">No tracks yet.</li>}
      </ul>

      <input ref={fileRef} type="file" accept="audio/*" multiple hidden
             onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
      <button class="btn ghost" disabled={!!busy} onClick={() => fileRef.current.click()}>
        {busy ? `Uploading ${busy}…` : "Add tracks"}
      </button>
    </section>
  );
}

// ── payment ─────────────────────────────────────────────────────────────────

function Payment({ payment, onChange }) {
  const wallet = payment.find((p) => p.type === "solana-usdc") || null;
  const links = payment.filter((p) => p.type === "link");

  const rebuild = (w, l) => onChange([...(w ? [w] : []), ...l]);

  return (
    <section class="card">
      <h2>Getting paid</h2>
      <p class="muted">
        Money goes straight from a listener to you. Amply is not in the transaction and
        cannot see, hold or take a share of it.
      </p>

      <h3>Pay per listen</h3>
      {wallet ? (
        <>
          <Field label="Solana wallet address">
            <Text value={wallet.address} class="mono"
                  onInput={(v) => rebuild({ ...wallet, address: v.trim() }, links)} />
          </Field>
          <div class="row">
            <Field label="Price per minute (USD)" hint="A 3½ minute track earns about this ×3.5.">
              <input type="number" min="0.001" max="1" step="0.001" value={wallet.ratePerMinute}
                     onInput={(e) => rebuild({ ...wallet, ratePerMinute: Number(e.target.value) }, links)} />
            </Field>
            <Field label="Pay out at (USD)" hint="Smaller amounts roll over rather than sending.">
              <input type="number" min="0.05" max="100" step="0.05" value={wallet.settleAt ?? 1}
                     onInput={(e) => rebuild({ ...wallet, settleAt: Number(e.target.value) }, links)} />
            </Field>
          </div>
          <button class="link danger" onClick={() => rebuild(null, links)}>Remove wallet</button>
        </>
      ) : (
        <button class="btn ghost" onClick={() =>
          rebuild({ type: "solana-usdc", address: "", ratePerMinute: 0.01, settleAt: 1 }, links)}>
          Add a wallet
        </button>
      )}

      <h3>Or a support link</h3>
      <p class="muted">Ko-fi, Bandcamp, a membership page — anything you already use.</p>
      {links.map((l, i) => (
        <div class="row" key={i}>
          <Field label="Label">
            <Text value={l.label} onInput={(v) =>
              rebuild(wallet, links.map((x, j) => (j === i ? { ...x, label: v } : x)))} />
          </Field>
          <Field label="Address">
            <Text value={l.url} placeholder="https://" onInput={(v) =>
              rebuild(wallet, links.map((x, j) => (j === i ? { ...x, url: v.trim() } : x)))} />
          </Field>
          <button class="link danger" onClick={() =>
            rebuild(wallet, links.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      <button class="btn ghost" onClick={() =>
        rebuild(wallet, [...links, { type: "link", label: "", url: "" }])}>Add a link</button>
    </section>
  );
}

// ── editor ──────────────────────────────────────────────────────────────────

export function Editor({ api, node, initial, onSignOut }) {
  const [manifest, setManifest] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  const notify = (kind, text) => setMsg({ kind, text });
  const update = useCallback((next) => { setManifest(next); setDirty(true); }, []);

  // Browsers only honour this after the page has been interacted with, which is
  // exactly when there is unsaved work worth protecting.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const upload = (key, file) => api.putObject(key, file);

  async function publish() {
    setSaving(true);
    try {
      const out = { ...manifest, amply: 1, updated: new Date().toISOString() };
      await api.writeManifest(out);
      setManifest(out);
      setDirty(false);
      notify("ok", "Published. Your page is live.");
    } catch (e) {
      notify("error", e.message);
    } finally {
      setSaving(false);
    }
  }

  const addRelease = () => {
    const taken = collectIds(manifest);
    update({
      ...manifest,
      releases: [...(manifest.releases || []),
        { id: makeId("release", taken), title: "", tracks: [] }],
    });
  };

  const trackCount = (manifest.releases || []).reduce((n, r) => n + (r.tracks?.length || 0), 0);

  return (
    <>
      <header class="bar">
        <div>
          <strong>{manifest.artist?.name || node.slug}</strong>
          <a class="node-url" href={node.url} target="_blank" rel="noopener">{node.url}</a>
        </div>
        <div class="bar-actions">
          {dirty && <span class="muted">unsaved changes</span>}
          <button class="btn" disabled={!dirty || saving} onClick={publish}>
            {saving ? "Publishing…" : "Publish"}
          </button>
          <button class="link" onClick={onSignOut}>Sign out</button>
        </div>
      </header>

      <Banner kind={msg?.kind} onDismiss={() => setMsg(null)}>{msg?.text}</Banner>

      <section class="card">
        <h2>About you</h2>
        <Field label="Name">
          <Text value={manifest.artist?.name}
                onInput={(v) => update({ ...manifest, artist: { ...manifest.artist, name: v } })} />
        </Field>
        <Field label="Bio" hint="Plain text.">
          <textarea rows="3" value={manifest.artist?.bio || ""}
                    onInput={(e) => update({ ...manifest,
                      artist: { ...manifest.artist, bio: e.target.value || undefined } })} />
        </Field>
        <label class="checkbox">
          <input type="checkbox" checked={!!manifest.content?.explicit}
                 onChange={(e) => update({ ...manifest, content: { explicit: e.target.checked } })} />
          <span>My music contains explicit content</span>
        </label>
      </section>

      <Payment payment={manifest.payment || []}
               onChange={(p) => update({ ...manifest, payment: p })} />

      <section class="card">
        <h2>Music <span class="muted">{trackCount} {trackCount === 1 ? "track" : "tracks"}</span></h2>
        {(manifest.releases || []).map((r, i) => (
          <Release key={r.id} release={r} node={node} manifest={manifest} upload={upload} notify={notify}
                   onChange={(next) => update({ ...manifest,
                     releases: manifest.releases.map((x, j) => (j === i ? next : x)) })}
                   onRemove={() => update({ ...manifest,
                     releases: manifest.releases.filter((_, j) => j !== i) })} />
        ))}
        {!manifest.releases?.length && <p class="muted">Nothing here yet. Add a release to start.</p>}
        <button class="btn ghost" onClick={addRelease}>Add a release</button>
      </section>

      <footer class="foot">
        <p class="muted">
          Everything here lives on your own Cloudflare account. Amply keeps no copy and has
          no access once you close this tab.
        </p>
      </footer>
    </>
  );
}


/** Read duration from the file itself — the manifest requires it, and a player
 *  must never download audio just to learn how long a track is. */
export function readDuration(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const done = (fn, v) => { URL.revokeObjectURL(url); fn(v); };
    audio.addEventListener("loadedmetadata", () => {
      const d = Math.round(audio.duration);
      if (!Number.isFinite(d) || d <= 0) done(reject, new Error("Could not read the length of that file."));
      else done(resolve, d);
    });
    audio.addEventListener("error", () => done(reject, new Error("That file could not be read as audio.")));
    audio.src = url;
  });
}

/** Safe object keys: the node rejects anything else before it reaches storage. */
export function safeKey(name) {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "") : "bin";
  const base = (dot > 0 ? name.slice(0, dot) : name)
    .toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "track";
  return `${base}-${Date.now().toString(36)}.${ext}`;
}

export { Banner };
