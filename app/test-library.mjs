/**
 * Whether an artist's service still answers: what the app remembers after
 * each check, when their songs are hidden, and when it says they seem gone.
 *
 * Run via `npm --prefix app run test`.
 */
const { noteReach, reachable, seemsGone, GONE_AFTER_MS, CHECK_EVERY_MS } = await import("./src/library.js");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

const day = 86400_000;
const t0 = 1_800_000_000_000;
const artist = { url: "https://a.example.workers.dev/manifest.json", manifest: { releases: [] }, followed: true };

ok("an artist never checked counts as reachable", reachable(artist));

const up = noteReach(artist, true, t0);
ok("an answer records when it was seen", up.lastSeen === t0 && reachable(up));

const down = noteReach(up, false, t0 + day);
ok("no answer marks it unreachable from that moment", down.unreachableSince === t0 + day && !reachable(down));
ok("  keeping its last copy and when it was last seen", down.manifest === artist.manifest && down.lastSeen === t0);

const still = noteReach(down, false, t0 + 5 * day);
ok("more failures keep the time it first stopped answering", still.unreachableSince === t0 + day);
ok("  it doesn't seem gone after a few days", !seemsGone(still, t0 + 5 * day));
ok("  but it does after a month without an answer", seemsGone(still, t0 + day + GONE_AFTER_MS));

const back = noteReach(still, true, t0 + 6 * day);
ok("an answer brings it straight back", reachable(back) && back.unreachableSince === undefined && back.lastSeen === t0 + 6 * day);
ok("  and keeps everything else about it", back.url === artist.url && back.followed === true);

ok("artists are checked several times a day", CHECK_EVERY_MS <= 12 * 3600_000 && CHECK_EVERY_MS >= 3600_000);
ok("nothing is called gone before a month", GONE_AFTER_MS >= 30 * day);
ok("a missing entry is never reachable", !reachable(null) && !reachable(undefined));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
