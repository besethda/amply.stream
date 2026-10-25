/**
 * The browser's proof-of-work against Node's own SHA-256.
 *
 * Setup solves Cloudflare's challenge in the artist's browser with a
 * hand-written SHA-256 (site/js/pow.js), because WebCrypto is too slow for a
 * few million chained hashes. A single wrong bit means Cloudflare refuses the
 * account, so this checks it hash for hash against the real thing, the way
 * Wrangler computes it.
 *
 *   node scripts/test-pow.mjs
 */
import { createHash, randomBytes } from "node:crypto";
import { solve, supported, POW_MAX_ITERATIONS } from "../site/js/pow.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

/** Wrangler's solver, verbatim in substance (wrangler 4.134.0). */
function wrangler(seed, k, g) {
  const checkpoints = [createHash("sha256").update(seed).digest()];
  let h = checkpoints[0];
  for (let j = 0; j < k; j++) {
    for (let i = 0; i < g; i++) h = createHash("sha256").update(h).digest();
    checkpoints.push(h);
  }
  return Buffer.concat(checkpoints).toString("base64");
}

for (const [k, g] of [[1, 1], [3, 5], [7, 4097], [2, 10000]]) {
  const seed = randomBytes(32);
  const got = await solve({ seed: seed.toString("base64url"), k, g });
  ok(`k=${k}, g=${g}: the same checkpoints as Wrangler`, got === wrangler(seed, k, g));
}

{
  const seed = randomBytes(32).toString("base64url");
  let reports = 0;
  await solve({ seed, k: 4, g: 2000 }, { onProgress: () => reports++, sliceMs: 0 });
  ok("progress is reported while it works", reports >= 1);
}

ok("a challenge Wrangler would take is supported", supported({ seed: randomBytes(32).toString("base64url"), k: 100, g: 1000 }));
ok("one too hard is not", !supported({ seed: randomBytes(32).toString("base64url"), k: POW_MAX_ITERATIONS, g: 2 }));
ok("nor a seed that isn't 32 bytes", !supported({ seed: randomBytes(16).toString("base64url"), k: 1, g: 1 }));
ok("nor a fractional difficulty", !supported({ seed: randomBytes(32).toString("base64url"), k: 1.5, g: 1 }));
ok("nor a missing one", !supported({}));

{
  const seed = randomBytes(32).toString("base64url");
  const t = performance.now();
  await solve({ seed, k: 500, g: 2000 });
  const ms = Math.round(performance.now() - t);
  console.log(`      a million hashes took ${ms} ms`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
