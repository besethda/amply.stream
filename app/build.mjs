/**
 * Build the listening app into site/app/, so it is served from amply.stream
 * alongside everything else and can be installed to a home screen.
 *
 * The Android build wraps this same output rather than reimplementing it: one
 * app, two ways of getting it. See docs/clients.md.
 */
import { readFile, writeFile, mkdir, copyFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const out = here("../site/app/");

await mkdir(out, { recursive: true });

for (const file of ["index.html", "app.css", "sw.js", "app.webmanifest"]) {
  await copyFile(here(`./${file}`), out + file);
}

// Split output: the entry point plus whatever chunks esbuild decided on. The
// payment libraries are much the largest, and are fetched only when a listener
// sets up a wallet, so they must be separate files rather than one bundle.
// Chunk names carry a content hash, so yesterday's chunks would otherwise sit
// in site/ for ever and be deployed alongside today's.
for (const name of await readdir(out)) {
  if (/\.js$/.test(name) && name !== "sw.js") await rm(out + name);
}

const built = here("../.build/app/");
const names = (await readdir(built)).sort();
const files = await Promise.all(names.map((name) => readFile(built + name, "utf8")));

// Which build this is: a fingerprint of everything in it, stamped into the
// app and published beside it. A home-screen app is mostly resumed rather
// than reloaded, so the app compares the two to know a newer one is out.
const hash = createHash("sha256");
for (const f of [...files, ...(await Promise.all(["index.html", "app.css"].map((f) => readFile(here(`./${f}`), "utf8"))))]) hash.update(f);
const build = hash.digest("hex").slice(0, 12);
await writeFile(out + "version.json", JSON.stringify({ build }) + "\n");

for (const [i, name] of names.entries()) {
  const served = name === "main.js" ? "app.js" : name;
  // The entry point is served as app.js, so its own imports must follow.
  const js = served === "app.js" ? `globalThis.AMPLY_BUILD=${JSON.stringify(build)};\n${files[i]}` : files[i];
  await writeFile(out + served, js);
  console.log(`site/app/${served}  ${(js.length / 1024).toFixed(1)} kB`);
}
console.log(`build ${build}`);
