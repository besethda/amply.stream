/**
 * Build the design harness: the editor with fake data, as one openable file.
 *
 * Writes outside the repo on purpose. This is a thing to look at while working
 * on the interface, not an artifact anyone ships, and a stale copy sitting in
 * site/ is exactly the failure BUILD.md is about.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

const js = await readFile(here("../.build/preview.js"), "utf8");
const base = await readFile(here("../site/style.css"), "utf8");
const editor = await readFile(here("../site/editor.css"), "utf8");

const out = process.env.AMPLY_PREVIEW_OUT || join(tmpdir(), "amply-preview", "editor.html");
await mkdir(join(out, ".."), { recursive: true });

await writeFile(out, `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your music (preview)</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;700;800&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
${base}
${editor}
</style>
</head>
<body>
<div class="wrap" id="app"></div>
<script type="module">
${js}
</script>
</body>
</html>
`);

console.log(out);
