/**
 * Albums and playlists as pages, and the small sheets for songs: what to do
 * with one, and which playlist to add it to.
 */
import { useState, useRef } from "preact/hooks";
import { useReorder } from "./gestures.js";
import { Icon } from "./icons.jsx";
import { artStyle } from "./looks.js";
import { TrackRow, nameOf, priceShort } from "./screens.jsx";
import { playlists } from "./collection.js";
import { cover, albumKey } from "./local.js";
import { trackNumber } from "./tags.js";

/**
 * One album or playlist.
 *
 * `rows` are [{ track, entry }] — songs that could be found. `missing` counts
 * those that couldn't (the artist's page is unreachable, or the song is gone).
 * `kind` is "album", "playlist" (the listener's own) or "shared" (opened from
 * a link, not saved yet). A shared playlist lists its artists with Follow
 * buttons, because opening it followed none of them.
 */
export function Collection({
  kind, title, meta, art, rows, missing = 0, current, playing, onBack, onPlay, onShuffle,
  onShare, onSave, onMore, onMenu, onRemove, artists = [], onFollow, liked = null, onLikeAll, buy = null, onReorder = null, onCover = null,
}) {
  const [editing, setEditing] = useState(false);
  // Press and hold a song, then drag it into place (a playlist, a local album).
  const list = useRef(null);
  useReorder(list, { onMove: onReorder, on: !!onReorder });
  const tracks = rows.map((r) => r.track);
  const picture = art ?? rows[0]?.track?.art ?? null;

  return (
    <div class="screen coll">
      <div class="head">
        <button class="circle-btn" onClick={onBack} aria-label="Back"><Icon.back size={17} /></button>
        {kind === "playlist" && (
          <span class="head-actions">
            <button class={`circle-btn${editing ? " on" : ""}`} onClick={() => setEditing(!editing)} aria-label={editing ? "Done" : "Edit"} aria-pressed={editing}>
              {editing ? <Icon.check size={16} /> : <Icon.edit size={16} />}
            </button>
            <button class="circle-btn" onClick={onMenu} aria-label="Playlist options"><Icon.more size={17} /></button>
          </span>
        )}
      </div>
      <div class="coll-top pad">
        {onCover ? (
          <label class="coll-cover" aria-label="Change the picture">
            <span class="art coll-art" style={artStyle(picture, title)} />
            <span class="coll-cover-edit"><Icon.edit size={15} /></span>
            <input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onCover(f); }} />
          </label>
        ) : <span class="art coll-art" style={artStyle(picture, title)} />}
        <h1>{title}</h1>
        {meta && <span class="mono-dim">{meta}</span>}
        <div class="row center">
          <button class="btn-primary" onClick={() => onPlay(tracks, 0)} disabled={!tracks.length}><Icon.play size={14} /> Play</button>
          <button class="circle-btn big" onClick={() => onShuffle(tracks)} disabled={!tracks.length} aria-label="Shuffle"><Icon.shuffle size={17} /></button>
          {buy && (buy.owned
            ? <button class="circle-btn big on" onClick={buy.onSave} aria-label="Save a copy to Files"><Icon.folder size={17} /></button>
            : <button class="pill buy-pill" onClick={buy.onClick} aria-label={`Buy album, ${buy.label}`}>{buy.label}</button>)}
          {onLikeAll && (
            <button class={`circle-btn big${liked ? " on" : ""}`} onClick={onLikeAll} disabled={!tracks.length}
              aria-label={liked ? "Unlike album" : "Like album"} aria-pressed={!!liked}>
              {liked ? <Icon.heartOn size={17} /> : <Icon.heart size={17} />}
            </button>
          )}
          {onShare && <button class="circle-btn big" onClick={onShare} aria-label="Share"><Icon.share size={17} /></button>}
          {onSave && <button class="circle-btn big" onClick={onSave} aria-label="Save playlist"><Icon.plus size={17} /></button>}
        </div>
      </div>

      {kind === "shared" && artists.length > 0 && (
        <div class="pad">
          <div class="panel">
            <b>Artists in this playlist</b>
            {artists.map(({ url, entry, followed }) => (
              <div class="mini-artist" key={url}>
                <span class="art round s38" style={artStyle(entry?.manifest?.artist?.image, entry ? nameOf(entry) : url)} />
                <span class="t">
                  <b>{entry ? nameOf(entry) : "…"}</b>
                  <span class={`mono ${entry?.domain ? "good-ink" : "warn-ink"}`}>
                    {entry ? `${entry.domain ? "✓ " + entry.domain : "! no website"} · ${priceShort(entry)}` : "loading"}
                  </span>
                </span>
                {entry && (followed
                  ? <button class="pill" onClick={() => onFollow(url, false)}>Following</button>
                  : <button class="btn-primary sm" onClick={() => onFollow(url, true)}>Follow</button>)}
              </div>
            ))}
          </div>
        </div>
      )}

      <div class="list coll-list" ref={list}>
        {rows.map(({ track, entry }, i) => (
          <TrackRow key={`${track.from}#${track.id}#${i}`} track={track} entry={entry} n={kind === "album" ? i + 1 : null}
            showArtist={kind !== "album"} current={current} playing={playing}
            onPlay={() => onPlay(tracks, i)} reorder={!!onReorder}
            onMore={editing ? null : () => onMore(track, kind === "playlist" ? i : null)}
            edit={editing ? { remove: () => onRemove(i) } : null} />
        ))}
        {!rows.length && <p class="dim pad">{kind === "playlist" ? "Empty. Add songs with ⋯ on any song." : "Nothing here."}</p>}
        {missing > 0 && <p class="mono-dim pad">{missing} unavailable</p>}
      </div>
    </div>
  );
}

/** What to do with one song. */
export function trackMenu(track, { liked, inPlaylist, onPlayNext, onQueue, onLike, onAdd, onArtist, onRemove, onEdit, onDelete, onShare, buys = [] }) {
  const Item = ({ icon, label, onClick, tone }) => (
    <button class={`menu-item ${tone || ""}`} onClick={onClick}>{icon}<span>{label}</span></button>
  );
  return {
    art: track.art || null, seed: track.releaseTitle || track.title,
    title: track.title,
    body: track.artistName,
    secondaryLabel: "Close",
    children: (
      <div class="menu">
        <Item icon={<Icon.playNext size={19} />} label="Play next" onClick={onPlayNext} />
        <Item icon={<Icon.queue size={19} />} label="Add to queue" onClick={onQueue} />
        <Item icon={liked ? <Icon.heartOn size={19} /> : <Icon.heart size={19} />} label={liked ? "Unlike" : "Like"} onClick={onLike} tone={liked ? "on" : ""} />
        <Item icon={<Icon.plus size={19} />} label="Add to playlist" onClick={onAdd} />
        {!track.local && onShare && <Item icon={<Icon.share size={19} />} label="Share" onClick={onShare} />}
        {buys.map((b) => <Item key={b.label} icon={<Icon.card size={19} />} label={b.label} onClick={b.onClick} />)}
        {track.local
          ? <Item icon={<Icon.library size={19} />} label="Go to album" onClick={onArtist} />
          : <Item icon={<Icon.artist size={19} />} label="Go to artist" onClick={onArtist} />}
        {track.local && <Item icon={<Icon.edit size={19} />} label="Edit details" onClick={onEdit} />}
        {inPlaylist && <Item icon={<Icon.trash size={19} />} label="Remove from playlist" onClick={onRemove} tone="warn-ink" />}
        {track.local && !inPlaylist && <Item icon={<Icon.trash size={19} />} label="Remove from phone" onClick={onDelete} tone="warn-ink" />}
      </div>
    ),
  };
}

/** Pick a playlist for a song, or start a new one with it. */
export function AddToPlaylist({ onPick, onCreate }) {
  const [name, setName] = useState("");
  const all = playlists();
  return (
    <div class="stack">
      <form class="input-row" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onCreate(name.trim()); }}>
        <Icon.plus size={17} />
        <input type="text" value={name} placeholder="New playlist" aria-label="New playlist name" onInput={(e) => setName(e.target.value)} />
        {name.trim() && <button class="btn-primary sm">Create</button>}
      </form>
      <div class="menu">
        {all.map((p) => (
          <button class="menu-item" key={p.id} onClick={() => onPick(p.id)}>
            <span class="art s38" style={artStyle(p.art || null, p.name)} />
            <span>{p.name}</span>
            <span class="mono-dim">{p.tracks.length}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Rename or delete one of the listener's playlists. */
export function PlaylistOptions({ playlist, onRename, onDelete, onRemoveArt }) {
  const [name, setName] = useState(playlist.name);
  return (
    <div class="stack">
      <form class="input-row" onSubmit={(e) => { e.preventDefault(); onRename(name.trim()); }}>
        <Icon.edit size={16} />
        <input type="text" value={name} aria-label="Playlist name" onInput={(e) => setName(e.target.value)} />
        {name.trim() && name.trim() !== playlist.name && <button class="btn-primary sm">Save</button>}
      </form>
      {playlist.art && <button class="menu-item" onClick={onRemoveArt}><Icon.close size={19} /><span>Remove picture</span></button>}
      <button class="menu-item warn-ink" onClick={onDelete}><Icon.trash size={19} /><span>Delete playlist</span></button>
    </div>
  );
}

/**
 * A local song's details, as the listener wants them: title, artist, album,
 * number, cover. Albums already on the phone are offered as the album is
 * typed; picking one files the song beside the rest, under the same artist.
 */
export function EditDetails({ song, albums = [], onSave }) {
  const [v, setV] = useState({ title: song.title || "", artist: song.artist || "", album: song.album || "", track: song.track ? String(song.track) : "" });
  const [look, setLook] = useState({ art: song.art || null, colors: song.colors || null });
  const [busy, setBusy] = useState(false);
  const set = (k, value) => setV((was) => ({ ...was, [k]: value }));
  const field = (k, label, extra = {}) => (
    <label class="field">
      <span class="label">{label}</span>
      <input class="input" type="text" value={v[k]} aria-label={label} onInput={(e) => set(k, e.target.value)} {...extra} />
    </label>
  );

  const real = albums.filter((a) => !a.single);
  const current = v.album.trim() ? real.find((a) => a.id === albumKey({ artist: v.artist.trim(), album: v.album.trim() })) : null;
  const typed = v.album.trim().toLowerCase();
  const offered = real.filter((a) => a !== current
    && (!typed || a.title.toLowerCase().includes(typed) || a.artist.toLowerCase().includes(typed))).slice(0, 12);
  const others = (current?.tracks || []).filter((t) => t.id !== song.id);
  const free = () => { let n = 1; while (others.some((t) => t.track === n)) n++; return n; };
  const n = trackNumber(v.track);
  const taken = n && others.find((t) => t.track === n);

  function choose(a) {
    const inIt = a.tracks.filter((t) => t.id !== song.id);
    let next = 1; while (inIt.some((t) => t.track === next)) next++;
    const clash = n && inIt.some((t) => t.track === n);
    setV((was) => ({ ...was, album: a.title, artist: a.artist, track: !n || clash ? String(next) : was.track }));
  }
  async function pick(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try { setLook(await cover(file)); } catch { /* not a picture this phone reads */ }
  }
  const shown = look.art || current?.art || null;
  return (
    <form class="stack edit-local" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      await onSave({ title: v.title.trim(), artist: v.artist.trim(), album: v.album.trim(), track: trackNumber(v.track), ...look });
      setBusy(false);
    }}>
      <label class="edit-cover" aria-label="Change cover">
        <span class="art s76" style={artStyle(shown, v.album || v.title)} />
        <Icon.edit size={15} />
        <input type="file" accept="image/*" hidden onChange={pick} />
      </label>
      {look.art && look.art !== song.art && v.album.trim() && <p class="mono-dim edit-note">Cover for the whole album</p>}
      {field("title", "Title")}
      {field("artist", "Artist")}
      <div class="edit-row">
        {field("album", "Album", { autocomplete: "off" })}
        <label class="field">
          <span class="label">No.</span>
          <input class={`input${taken ? " clash" : ""}`} type="text" inputMode="numeric" pattern="[0-9]*" maxLength={3} value={v.track} aria-label="Track number"
            onInput={(e) => { const d = e.target.value.replace(/\D/g, "").replace(/^0+/, "").slice(0, 3); e.target.value = d; set("track", d); }} />
        </label>
      </div>
      {offered.length > 0 && (
        <div class="album-pick" role="list" aria-label="Albums on this phone">
          {offered.map((a) => (
            <button type="button" role="listitem" key={a.id} onClick={() => choose(a)}>
              <span class="art s38" style={artStyle(a.art, a.title)} />
              <span class="t"><b>{a.title}</b><span>{a.artist}</span></span>
            </button>
          ))}
        </div>
      )}
      {taken && (
        <button type="button" class="edit-warn warn-ink" onClick={() => set("track", String(free()))}>
          <Icon.warn size={13} /> {n} is {taken.title} · use {free()}
        </button>
      )}
      <button class="btn-primary wide" disabled={busy || !v.title.trim()}>Save</button>
    </form>
  );
}
