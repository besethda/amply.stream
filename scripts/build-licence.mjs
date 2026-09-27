/**
 * Publish the licence texts on amply.stream, from the Markdown in spec/.
 *
 * The licence is the whole answer to "what stops someone rebuilding Spotify out
 * of artists' nodes", so its text has to be readable at a stable address, by
 * anyone, for as long as a manifest points at it. That address is
 * amply.stream/licence/<id>, not a repository link: repositories get renamed
 * and made private, and every artist's page links here.
 *
 * spec/licence/*.md stays the single source. This renders it; nothing is
 * edited by hand in site/licence/.
 *
 * The converter handles exactly what the licence files use: headings,
 * paragraphs, bold, inline code, links, ordered lists, a rule and a fenced
 * block. Anything else fails the build rather than rendering wrongly, because a
 * silently mangled licence is worse than none.
 */
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function inline(text) {
  // Code first, so nothing inside backticks is treated as markup.
  const parts = text.split(/(`[^`]+`)/);
  return parts.map((p) => {
    if (p.startsWith("`") && p.endsWith("`")) return `<code>${esc(p.slice(1, -1))}</code>`;
    let h = esc(p);
    h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    h = h.replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
    if (/\[[^\]]+\]\([^)]*\)/.test(h)) {
      throw new Error(`relative or non-https link in licence text: ${p.trim()}`);
    }
    return h;
  }).join("");
}

function render(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let para = [];
  let list = null;           // array of item strings
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<ol>${list.map((i) => `<li>${inline(i)}</li>`).join("")}</ol>`);
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("```")) {
      flushPara(); flushList();
      const body = [];
      while (++i < lines.length && !lines[i].startsWith("```")) body.push(lines[i]);
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^#{1,3} /.test(line)) {
      flushPara(); flushList();
      const level = line.match(/^#+/)[0].length;
      out.push(`<h${level}>${inline(line.slice(level + 1))}</h${level}>`);
      continue;
    }
    if (/^---+\s*$/.test(line)) { flushPara(); flushList(); out.push("<hr>"); continue; }
    if (/^\d+\. /.test(line)) {
      flushPara();
      list = list || [];
      list.push(line.replace(/^\d+\. /, ""));
      continue;
    }
    if (line.trim() === "") { flushPara(); flushList(); continue; }
    if (list && /^\s+\S/.test(line)) { list[list.length - 1] += " " + line.trim(); continue; }
    if (/^\s*[-*] /.test(line) || /^>/.test(line) || /^\|/.test(line)) {
      throw new Error(`unsupported Markdown in licence text: ${line}`);
    }
    flushList();
    para.push(line.trim());
  }
  flushPara(); flushList();
  return out.join("\n");
}

const srcDir = here("../spec/licence/");
const outDir = here("../site/licence/");
await mkdir(outDir, { recursive: true });

for (const file of (await readdir(srcDir)).filter((f) => f.endsWith(".md"))) {
  const id = file.replace(/\.md$/, "");
  const md = await readFile(srcDir + file, "utf8");
  const title = md.match(/^# (.+)$/m)?.[1] ?? id;
  const body = render(md);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - Amply</title>
<meta name="description" content="The standard terms an artist can grant for their own recordings: listen freely with any player, no redistribution.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500&display=swap">
<link rel="icon" href="/amply.svg" type="image/svg+xml">
<link rel="stylesheet" href="/style.css">
<style>
  .licence { padding-top: clamp(40px, 5vw, 72px); }
  .licence h1 { font-size: clamp(34px, 4.6vw, 56px); line-height: 1.02; margin-bottom: 26px; }
  .licence h2 { font-size: clamp(22px, 2.2vw, 28px); letter-spacing: -0.025em; margin: 44px 0 14px; }
  .licence p, .licence li { font-size: 18px; max-width: 40em; }
  .licence ol { padding-left: 1.3em; margin: 0 0 18px; color: var(--ink2); }
  .licence li { margin-bottom: 10px; }
  .licence hr { border: 0; border-top: 1px solid var(--line); margin: 36px 0; }
  .licence code { font-family: var(--mono); font-size: 0.88em; background: var(--bg2); padding: 1px 6px; border-radius: 6px; }
  .licence pre { background: var(--bg2); border: 1px solid var(--line); border-radius: var(--r); padding: 18px; overflow-x: auto; }
  .licence pre code { background: none; padding: 0; font-size: 15px; }
  .source { font-family: var(--mono); font-size: 14px; color: var(--ink3); margin-top: 44px; }
</style>
</head>
<body>
<div class="topbar">
  <div class="topbar-in">
    <a class="mark" href="/"><img src="/amply.svg" alt="" width="26" height="26">amply</a>
    <div class="topbar-actions"><a class="btn sm" href="/start">Set up my streaming service</a></div>
  </div>
</div>
<main>
<section class="licence">
<div class="col narrow">
${body}
<p class="source">amply.stream/licence/${id}. This address is permanent: manifests refer to it.</p>
</div>
</section>
</main>
<footer><div class="footer-in"><span>amply</span><div class="footer-links">
<a href="/">Home</a><a href="/protect">Protecting your music</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a>
</div></div></footer>
</body>
</html>
`;
  await writeFile(`${outDir}${id}.html`, html);
  console.log(`licence/${id}.html  ${(html.length / 1024).toFixed(1)} kB`);
}
