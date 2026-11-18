/**
 * Build the streaming service into site/node-worker.js, the file setup and
 * repair upload into an artist's account (npm run build:site).
 *
 * A script rather than one esbuild command for one reason: lame.ts takes the
 * editor's MP3 encoder in as text, which esbuild copies as it is, so it is
 * minified here first. The listener-facing code is no different either way.
 */
import * as esbuild from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

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
  loader: { ".png": "binary" },
  outfile: here("../site/node-worker.js"),
  plugins: [minifyEncoder],
  logLevel: "warning",
});
