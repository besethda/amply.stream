/**
 * Adding an artist: type their link or website, or scan their QR code, and see
 * who they are before following.
 *
 * The camera is used only while scanning, only on the phone, and nothing it
 * sees leaves the device: frames are decoded here and thrown away.
 */
import { useState, useEffect, useRef } from "preact/hooks";
import { Icon } from "./icons.jsx";
import { artStyle } from "./looks.js";
import { priceShort, nameOf } from "./screens.jsx";
import { readCode } from "./collection.js";
import { importFiles, usage, asTrack, albums } from "./local.js";

/** The cover a song shows: its own, or its album's. */
const songArt = (songs, t) => albums(songs).find((a) => a.id === t.releaseId)?.tracks.find((x) => x.id === t.id)?.art || null;

const MB = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`);

/**
 * Songs from this phone's files — iCloud Drive included — copied into the app
 * so they play beside everything else, marked "local". They stay on this
 * phone: never uploaded, paid for or shared.
 */
function FromFiles({ onImported, songs, onEdit }) {
  const input = useRef(null);
  const [progress, setProgress] = useState(null);     // { done, of }
  const [results, setResults] = useState([]);
  const [room, setRoom] = useState(null);
  const measure = () => usage().then(setRoom).catch(() => {});
  useEffect(() => { measure(); }, []);

  async function chosen(e) {
    const files = [...(e.target.files || [])];
    e.target.value = "";
    if (!files.length) return;
    setResults([]);
    setProgress({ done: 0, of: files.length });
    const out = [];
    await importFiles(files, (r) => {
      out.push(r);
      setResults([...out]);
      setProgress({ done: out.length, of: files.length });
    });
    setProgress(null);
    onImported();
    measure();
  }

  return (
    <>
      <button class="scan-cta" onClick={() => input.current?.click()} disabled={!!progress}>
        <Icon.folder size={22} /><span>Add from Files</span>
      </button>
      <input ref={input} type="file" multiple hidden onChange={chosen}
        accept="audio/*,.mp3,.m4a,.aac,.flac,.wav,.aif,.aiff,.ogg,.opus" />
      {progress && (
        <p class="note-line mono-dim"><span class="bars" aria-hidden="true"><i /><i /><i /></span> {progress.done} / {progress.of}</p>
      )}
      {results.length > 0 && (
        <div class="list">
          {results.map((r, i) => {
            if (!r.ok) return (
              <div class="row-item" key={i}>
                <span class="art s44 dashed"><Icon.warn size={16} /></span>
                <span class="t"><b>{r.file.name}</b><span class="warn-ink">{r.message}</span></span>
              </div>
            );
            // As it is now, so an edit made from here shows here.
            const now = songs.find((s) => s.id === r.song.id);
            const t = asTrack(now || r.song);
            return (
              <button class="row-item" key={i} onClick={() => onEdit(t)} aria-label={`Edit ${t.title}`}>
                <span class="art s44" style={artStyle(t.art || songArt(songs, t), t.releaseTitle)} />
                <span class="t"><b>{t.title}</b><span class="dim">{[t.artistName, now?.album || r.song.album].filter(Boolean).join(" · ")}</span></span>
                <span class="icon-btn dim"><Icon.edit size={17} /></span>
              </button>
            );
          })}
        </div>
      )}
      {room?.count > 0 && (
        <p class="mono-dim local-room">{room.count} local · {MB(room.used)}{room.quota ? ` of ${MB(room.quota)}` : ""}</p>
      )}
    </>
  );
}

function Scanner({ onCode, onClose }) {
  const video = useRef(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let stream, stop = false, timer;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        if (stop) return;
        const v = video.current;
        v.srcObject = stream;
        await v.play();
        // The phone's own reader where there is one (Chrome on Android);
        // otherwise a small decoder, fetched only now.
        const native = "BarcodeDetector" in window
          ? new window.BarcodeDetector({ formats: ["qr_code"] }) : null;
        const jsQR = native ? null : (await import("jsqr")).default;
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        const look = async () => {
          if (stop) return;
          try {
            let text = null;
            if (native) {
              const found = await native.detect(v);
              text = found[0]?.rawValue || null;
            } else if (v.videoWidth) {
              const w = Math.min(640, v.videoWidth), h = Math.round((w / v.videoWidth) * v.videoHeight);
              canvas.width = w; canvas.height = h;
              ctx.drawImage(v, 0, 0, w, h);
              text = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" })?.data || null;
            }
            if (text && readCode(text)) { stop = true; onCode(text); return; }
          } catch { /* a frame that couldn't be read */ }
          timer = setTimeout(look, 220);
        };
        look();
      } catch (e) {
        setError(e?.name === "NotAllowedError" ? "Camera not allowed" : "No camera available");
      }
    })();
    return () => { stop = true; clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, []);

  return (
    <div class="scanner" role="dialog" aria-label="Scan a QR code">
      <video ref={video} playsInline muted />
      <span class="scan-frame" aria-hidden="true" />
      <button class="float-btn" onClick={onClose} aria-label="Close"><Icon.close size={18} /></button>
      <p class="scan-hint">{error || "Point at the artist's QR code"}</p>
    </div>
  );
}

/**
 * The Add screen. `find` fetches and checks an artist without following them;
 * `follow` adds them. `onLink` opens any other link: a playlist, a gift, a
 * song or an album.
 */
export function AddScreen({ onBack, find, follow, onLink, entries, onImported = () => {}, songs = [], onEdit = () => {} }) {
  const [value, setValue] = useState("");
  const [state, setState] = useState("idle");      // idle | loading | preview | error
  const [found, setFound] = useState(null);
  const [error, setError] = useState(null);
  const [scanning, setScanning] = useState(false);

  async function look(input) {
    const code = readCode(input);
    // A playlist, a gift, a song, an album: opened as such.
    if (code && code.kind !== "artist") { onLink(code); return; }
    setState("loading"); setError(null);
    try {
      const f = await find(code?.value || input);
      setFound(f); setState("preview");
    } catch (e) {
      setError(e.message); setState("error");
    }
  }

  const already = found && entries.some((e) => e.url === found.url && e.followed !== false);
  const preview = found && { url: found.url, manifest: found.manifest, domain: found.domain };

  return (
    <div class="screen">
      <div class="head">
        <button class="circle-btn" onClick={onBack} aria-label="Back"><Icon.back size={17} /></button>
        <h1 class="h-sub">Add</h1>
      </div>
      <div class="pad stack">
        <form class="input-row" onSubmit={(e) => { e.preventDefault(); if (value.trim()) look(value.trim()); }}>
          <Icon.globe size={18} />
          <input type="text" inputMode="url" autocapitalize="off" autocorrect="off" spellcheck={false} autoFocus
            value={value} placeholder="Link or website" aria-label="An artist's link or website"
            onInput={(e) => setValue(e.target.value)} />
          {value.trim()
            ? <button class="icon-btn" aria-label="Look up"><Icon.send size={18} /></button>
            : <button type="button" class="icon-btn dim" onClick={() => setScanning(true)} aria-label="Scan a QR code"><Icon.qr size={19} /></button>}
        </form>

        {state === "idle" && navigator.clipboard?.readText && (
          <button class="scan-cta" onClick={async () => {
            let text = "";
            try { text = (await navigator.clipboard.readText()).trim(); } catch { /* not allowed */ }
            if (!text) return setError("Nothing to paste. Copy a link first.") || setState("error");
            setValue(text); look(text);
          }}>
            <Icon.link size={22} /><span>Paste a link</span>
          </button>
        )}
        {state === "idle" && (
          <button class="scan-cta" onClick={() => setScanning(true)}>
            <Icon.qr size={22} /><span>Scan a QR code</span>
          </button>
        )}
        {state === "idle" && <FromFiles onImported={onImported} songs={songs} onEdit={onEdit} />}

        {state === "loading" && (
          <p class="note-line mono-dim"><span class="bars" aria-hidden="true"><i /><i /><i /></span> Asking their service…</p>
        )}

        {state === "error" && (
          <div class="trust warn stack-tight">
            <Icon.warn size={14} />
            <span>{error}</span>
          </div>
        )}

        {state === "preview" && preview && (
          <div class="preview">
            <span class="preview-banner" style={artStyle(preview.manifest.artist?.banner, nameOf(preview))} />
            <div class="preview-body">
              <span class="art round s60 ring2" style={artStyle(preview.manifest.artist?.image, nameOf(preview))} />
              <b>{nameOf(preview)}</b>
              {preview.domain
                ? <span class="mono good-ink"><Icon.check size={12} /> {preview.domain}</span>
                : <span class="mono warn-ink"><Icon.warn size={12} /> No website — only if the artist sent you this</span>}
              <span class="chip solid fit">{priceShort(preview)}</span>
              <button class="btn-primary wide" onClick={() => follow(found)} disabled={already}>
                {already ? "Following" : "Follow"}
              </button>
            </div>
          </div>
        )}
      </div>

      {scanning && <Scanner onClose={() => setScanning(false)}
        onCode={(text) => { setScanning(false); setValue(text); look(text); }} />}
    </div>
  );
}
