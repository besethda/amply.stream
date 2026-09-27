/**
 * Likes, playlists, and playlist links.
 *
 * Run via `npm --prefix app run test`.
 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const c = await import("./src/collection.js");
const lib = await import("./src/library.js");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

const A = "https://a.workers.dev/manifest.json";
const B = "https://b.workers.dev/manifest.json";
const s1 = { from: A, id: "t1", title: "One" }, s2 = { from: B, id: "t2" }, s3 = { from: A, id: "t3" };

// likes
c.toggleLike(s1);
ok("a liked song is liked", c.isLiked(s1));
ok("  and only that one", !c.isLiked(s3));
ok("likes keep a pointer, not the song", JSON.stringify(c.likes()[0]) === JSON.stringify({ from: A, id: "t1" }));
c.toggleLike(s1);
ok("liking again unlikes", !c.isLiked(s1));

// playlists
const p = c.createPlaylist("Late drive");
c.addToPlaylist(p.id, s1); c.addToPlaylist(p.id, s2); c.addToPlaylist(p.id, s3);
let got = c.playlists().find((x) => x.id === p.id);
ok("songs are added in order", got.tracks.map((t) => t.id).join() === "t1,t2,t3");
c.movePlaylistTrack(p.id, 2, 1);
got = c.playlists().find((x) => x.id === p.id);
ok("moving a song up", got.tracks.map((t) => t.id).join() === "t1,t3,t2");
c.removeFromPlaylist(p.id, 0);
got = c.playlists().find((x) => x.id === p.id);
ok("removing one", got.tracks.map((t) => t.id).join() === "t3,t2");
c.renamePlaylist(p.id, "Night drive");
ok("renaming", c.playlists().find((x) => x.id === p.id).name === "Night drive");
ok("an artist in a playlist is referenced", c.referenced(B));
ok("  one in nothing isn't", !c.referenced("https://z.workers.dev/manifest.json"));

// sharing round trip
const code = c.shareCode("Late drive", [s1, s2, s3]);
const back = c.readShare(code);
ok("a shared link reads back", back && back.name === "Late drive" && back.tracks.length === 3);
ok("  with each artist written once", back.artists.length === 2);
ok("  and each song where it lives", back.tracks[1].from === B && back.tracks[1].id === "t2");
ok("the link is URL-safe", /^[A-Za-z0-9_-]+$/.test(code));
ok("a code that isn't ours is refused", c.readShare("bm9wZQ") === null && c.readShare("%%%") === null);
const evil = btoa(JSON.stringify({ v: 1, n: "x", a: ["javascript:alert(1)"], t: [[0, "a"]] })).replace(/=+$/, "");
ok("an artist address that isn't https is refused", c.readShare(evil) === null);
const oob = btoa(JSON.stringify({ v: 1, n: "x", a: [A], t: [[5, "a"], [0, "b"]] })).replace(/=+$/, "");
ok("a song pointing at no artist is dropped", c.readShare(oob).tracks.length === 1);
c.deletePlaylist(p.id);
ok("deleting a playlist", !c.playlists().some((x) => x.id === p.id));

// following vs knowing
let entries = lib.addArtist([], A, { artist: { name: "A" } });
entries = lib.addKnown(entries, B, { artist: { name: "B" } });
ok("a followed artist is followed", lib.isFollowed(entries.find((e) => e.url === A)));
ok("an artist from a shared playlist isn't", !lib.isFollowed(entries.find((e) => e.url === B)));
ok("  and doesn't show among followed", lib.followedOnly(entries).length === 1);
entries = lib.setFollowed(entries, B, true);
ok("following them later", lib.followedOnly(entries).length === 2);
ok("knowing an artist already followed changes nothing", lib.addKnown(entries, A, {}).length === 2);
ok("old entries, from before following existed, count as followed", lib.isFollowed({ url: A }));

// scanned codes
ok("an Amply add link names the artist", c.readCode("https://amply.stream/app/?add=https%3A%2F%2Fa.workers.dev%2Fmanifest.json").value === "https://a.workers.dev/manifest.json");
ok("a playlist link opens the playlist", c.readCode("https://amply.stream/app/?playlist=abc").kind === "playlist");
ok("an artist's website works", c.readCode("hollowcoast.com").kind === "artist");
{
  const M = "https://a.workers.dev/manifest.json", e = encodeURIComponent(M);
  const song = c.readCode(`https://amply.stream/app/?song=${e}&id=t2`);
  ok("an app song link: the artist and the song", song.kind === "song" && song.value === M && song.id === "t2");
  const album = c.readCode(`https://amply.stream/app/?album=${e}&id=tides`);
  ok("an app album link: the artist and the album", album.kind === "album" && album.value === M && album.id === "tides");
  const page = c.readCode("https://a.workers.dev/?song=t2");
  ok("an artist's page naming a song is that song, from that artist", page.kind === "song" && page.value === M && page.id === "t2");
  ok("  and naming an album, that album", c.readCode("https://a.workers.dev/?album=tides").kind === "album");
  const gift = c.readCode(`https://amply.stream/app/?gift=${e}&code=Gift1234567890abcdef`);
  ok("a gift link: the artist and the code", gift.kind === "gift" && gift.value === M && gift.code === "Gift1234567890abcdef");
  ok("a song id that isn't one is just the artist", c.readCode("https://a.workers.dev/?song=<script>").kind === "artist");
  ok("an http page naming a song isn't trusted as one", c.readCode("http://a.example/?song=t2")?.kind !== "song");
  ok("the links to share: the artist's page, naming the song", c.songLink(M, "t2") === "https://a.workers.dev/?song=t2");
  ok("  and the album", c.albumLink(M, "tides") === "https://a.workers.dev/?album=tides");
  ok("  which read back as what they name", c.readCode(c.songLink(M, "t2")).id === "t2" && c.readCode(c.albumLink(M, "tides")).kind === "album");
}
ok("  and their https address", c.readCode("https://a.workers.dev").kind === "artist");
ok("a code that isn't an artist is ignored", c.readCode("hello there") === null && c.readCode("javascript:alert(1)") === null && c.readCode("http://x.com") === null);

{
  const p = c.createPlaylist("Order", [{ from: "x", id: "1" }, { from: "x", id: "2" }, { from: "x", id: "3" }, { from: "x", id: "4" }]);
  const ids = () => c.playlists().find((q) => q.id === p.id).tracks.map((t) => t.id).join("");
  c.movePlaylistTrack(p.id, 3, 0);
  ok("a playlist song dragged to the top", ids() === "4123", ids());
  c.movePlaylistTrack(p.id, 0, 3);
  ok("  and back to the end", ids() === "1234", ids());
  c.movePlaylistTrack(p.id, 1, 7);
  ok("  a place that isn't there changes nothing", ids() === "1234", ids());
}

{
  const p = c.createPlaylist("Pictured", []);
  ok("a playlist's picture is kept", c.setPlaylistArt(p.id, "data:image/jpeg;base64,AAA") && c.playlists().find((q) => q.id === p.id).art === "data:image/jpeg;base64,AAA");
  c.setPlaylistArt(p.id, null);
  ok("  and taken away", !("art" in c.playlists().find((q) => q.id === p.id)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
