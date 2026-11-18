/**
 * Build the streaming service into site/node-worker.js, the file setup and
 * repair upload into an artist's account (npm run build:site).
 *
 * A script rather than one esbuild command for two reasons. lame.ts takes the
 * editor's MP3 encoder in as text, which esbuild copies as it is, so it is
 * minified here first. And the Worker is minified, which renames VERSION, so
 * the first line says the version in the form setup reads it in
 * (versionOfWorker in site/js/provision.js: `VERSION = "x"`), including the
 * copies of setup already open in someone's browser.
 */
import * as esbuild from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

const version = (await readFile(here("src/constants.ts"), "utf8")).match(/export const VERSION = "([^"]+)"/)?.[1];
if (!version) throw new Error("node/src/constants.ts no longer declares VERSION where expected");

const minifyEncoder = {
  name: "minify-encoder",
  setup(build) {
    build.onLoad({ filter: /lamejs[\\/]dist[\\/]lamejs\.js$/ }, async (args) => {
      if (args.with?.type !== "text") return undefined;
      const { code } = await esbuild.transform(await readFile(args.path, "utf8"), { minify: true, format: "esm", target: "es2020" });
      return { contents: code, loader: "text" };
    });
  },
};

await esbuild.build({
  entryPoints: [here("src/index.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  banner: { js: `// Amply streaming service. VERSION = "${version}"` },
  loader: { ".png": "binary" },
  outfile: here("../site/node-worker.js"),
  plugins: [minifyEncoder],
  logLevel: "warning",
});
