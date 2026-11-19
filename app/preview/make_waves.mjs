// Generate a .waves file next to every .m4a in fixtures/ (uses spec/waves.mjs).
import { spawnSync } from "node:child_process";
import { readdirSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startWaves, feedWaves, finishWaves, WAVES_RATE } from "../../spec/waves.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fx = join(here, "fixtures");
for (const host of readdirSync(fx)) {
  const dir = join(fx, host, "audio");
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".m4a"))) {
    const out = join(dir, f.replace(/\.m4a$/, ".waves"));
    const r = spawnSync("ffmpeg", ["-v", "error", "-i", join(dir, f), "-ac", "1", "-ar", String(WAVES_RATE), "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
    const pcm = new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.length - (r.stdout.length % 4)));
    const a = startWaves(WAVES_RATE, pcm.length / WAVES_RATE);
    feedWaves(a, pcm);
    writeFileSync(out, finishWaves(a));
  }
}
console.error("waves done");
