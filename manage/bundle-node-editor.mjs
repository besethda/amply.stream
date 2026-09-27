/**
 * Produce the single self-contained editor that gets uploaded into an artist's
 * own R2 bucket and served from their node.
 *
 * One file, no external requests: the node serves it from storage, behind
 * Cloudflare Access, and it must work even if amply.stream is gone. Linking to
 * anything of ours would quietly undo exactly the property this whole design
 * exists to provide.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// fileURLToPath, not url.pathname: this repo lives under a path with a space in
// it, and pathname hands back the percent-encoded form.
const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

const js = await readFile(here("../.build/node-manage.js"), "utf8");
const base = await readFile(here("../site/style.css"), "utf8");
const editor = await readFile(here("../site/editor.css"), "utf8");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your music</title>
<meta name="robots" content="noindex">
<meta name="theme-color" content="#ffffff">
<link rel="manifest" href="/studio.webmanifest">
<link rel="apple-touch-icon" href="/studio/icon-180.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Your music">
<style>
${base}
${editor}
</style>
</head>
<body>
<div class="wrap" id="app">
  <p class="lead">Loading…</p>
  <noscript><p>This page needs JavaScript to edit your music.</p></noscript>
</div>
<script type="module">
${js}
</script>
</body>
</html>
`;

await writeFile(here("../site/node-manage.html"), html);
console.log(`node-manage.html  ${(html.length / 1024).toFixed(1)} kB (self-contained)`);
