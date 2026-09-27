/**
 * A resized picture keeps its photographer's credit and copyright, and
 * nothing else from inside the original.
 *
 * Run via `npm --prefix manage run test`.
 */
import { readRights, withRights } from "./src/images.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

// The smallest thing shaped like a JPEG: start, a stand-in for the picture, end.
const bare = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]);

ok("a JPEG with no credit has none", readRights(bare) === null);
ok("something that isn't a JPEG has none", readRights(new Uint8Array([0x89, 0x50, 0x4e, 0x47])) === null);

const both = withRights(bare, { artist: "Jane Photographer", copyright: "© 2026 Jane Photographer. All rights reserved." });
const back = readRights(both);
ok("credit and copyright written in are read back", back?.artist === "Jane Photographer" && back?.copyright === "© 2026 Jane Photographer. All rights reserved.", JSON.stringify(back));
ok("  still a JPEG, the picture after it untouched", both[0] === 0xff && both[1] === 0xd8 && both.subarray(both.length - bare.length + 2).every((b, i) => b === bare[2 + i]));

const short = readRights(withRights(bare, { artist: "Ann" }));
ok("a short credit (four bytes or less) survives too", short?.artist === "Ann" && !("copyright" in short), JSON.stringify(short));

// Only those two: a GPS pointer in the original isn't carried.
const text = new TextDecoder("latin1").decode(both);
ok("nothing else goes in (no location, no camera)", !/GPS|iPhone/.test(text) && both.length < bare.length + 120, `${both.length} bytes`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
