/**
 * The artist's website: what the server will keep, and what it will show.
 * Everything in a site is artist-supplied, so the tests try to smuggle in
 * markup, scripts and odd links, and check none of it survives.
 *
 *   node spec/test-site.mjs
 */
import { cleanSite, starterSite, renderSite, newSection, newItem, SECTION_TYPES } from "./site.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

const manifest = {
  artist: { name: "Hollow Coast", bio: "From the sea.", image: "https://a.example/me.jpg", banner: "https://a.example/b.jpg",
    links: [{ label: "Instagram", url: "https://instagram.com/x" }] },
  releases: [],
};

// ── a starter site from what the artist has ────────────────────────────────
{
  const s = starterSite(manifest);
  ok("a starter site uses the artist's name and banner", s.hero.title === "Hollow Coast" && s.hero.image === "https://a.example/b.jpg");
  ok("  their bio and photo in About", s.sections.find((x) => x.type === "about")?.text === "From the sea.");
  ok("  and their links", s.sections.find((x) => x.type === "links")?.items[0].url === "https://instagram.com/x");
  ok("  and the music", s.sections.some((x) => x.type === "music"));
}

// ── what cleaning keeps and drops ──────────────────────────────────────────
{
  const dirty = cleanSite({
    look: { theme: "neon", font: "comic", accent: "red;}body{display:none" },
    hero: { title: "x".repeat(500), image: "javascript:alert(1)" },
    sections: [
      { type: "about", text: "hi", image: "http://insecure.example/a.jpg" },
      { type: "script" },
      { type: "links", items: [{ label: "Bad", url: "javascript:alert(1)" }, { label: "Data", url: "data:text/html,<b>" }, { label: "Good", url: "https://ok.example" }] },
      { type: "shows", items: [{ date: "tomorrow", city: "Malmö" }] },
      ...Array.from({ length: 30 }, () => ({ type: "news" })),
    ],
  });
  ok("an unknown theme, font or colour falls back", dirty.look.theme === "light" && dirty.look.font === "sans" && dirty.look.accent === "#f6711e");
  ok("long text is cut to size", dirty.hero.title.length <= 120);
  ok("a javascript: picture is dropped", dirty.hero.image === "");
  ok("an http (not https) picture is dropped", dirty.sections[0].image === "");
  ok("an unknown section type is dropped", !dirty.sections.some((x) => x.type === "script"));
  const links = dirty.sections.find((x) => x.type === "links").items;
  ok("javascript: and data: links are dropped, https kept", links[0].url === "" && links[1].url === "" && links[2].url === "https://ok.example/");
  ok("a date that isn't a date is dropped", dirty.sections.find((x) => x.type === "shows").items[0].date === "");
  ok("at most 16 sections", dirty.sections.length <= 16);
  ok("section ids are unique", new Set(dirty.sections.map((x) => x.id)).size === dirty.sections.length);
  ok("nothing at all becomes an empty, valid site", cleanSite(null).sections.length === 0 && cleanSite("x").look.theme === "light");
}

// ── what visitors see ──────────────────────────────────────────────────────
{
  const evil = '<script>alert(1)</script><img src=x onerror=alert(1)>"\'';
  const site = cleanSite({
    hero: { title: evil, tagline: evil },
    sections: [
      { id: "about", type: "about", title: evil, text: `${evil}\n\nSecond paragraph` },
      { id: "secret", type: "news", title: "Drafts", hidden: true, items: [{ title: "Not yet" }] },
      { id: "merch", type: "merch", items: [{ name: evil, price: "$5", url: "https://shop.example" }] },
    ],
  });
  const { body, css } = renderSite(site, manifest, { listenUrl: "https://amply.stream/app/?add=x" });
  ok("no script tag gets through", !/<script/i.test(body));
  ok("no event handler gets through", !/<img[^>]*onerror/i.test(body));
  ok("text is shown, escaped", body.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  ok("paragraphs come from blank lines", (body.match(/<p>Second paragraph<\/p>/g) || []).length === 1);
  ok("a hidden section isn't shown to visitors", !body.includes("Not yet") && !body.includes('id="secret"'));
  ok("visitors' markup has no editing hooks", !body.includes("data-edit") && !body.includes("data-kind"));
  ok("empty fields show nothing to visitors", !body.includes('class="ph'));
  ok("the listen button links to the app", body.includes('href="https://amply.stream/app/?add=x"'));
  ok("the accent colour can't break out of the stylesheet", !/display:none/.test(css));
}

// ── what the editor sees ───────────────────────────────────────────────────
{
  const site = cleanSite({ sections: [{ id: "n", type: "news", items: [{ title: "" }] }, { id: "h", type: "about", hidden: true }] });
  const { body } = renderSite(site, manifest, { edit: true });
  ok("in the editor, fields carry their path", body.includes('data-edit="sections.0.items.0.title"') && body.includes('data-kind="text"'));
  ok("  sections carry their index", body.includes('data-section="0"') && body.includes('data-section="hero"'));
  ok("  empty fields show a placeholder", body.includes('class="ph"'));
  ok("  hidden sections still show, marked", body.includes("is-hidden"));
}

// ── making new things ──────────────────────────────────────────────────────
{
  ok("every section type can be made, and survives cleaning", Object.keys(SECTION_TYPES).every((t) => cleanSite({ sections: [newSection(t)] }).sections[0]?.type === t));
  ok("a new section gets a free id", newSection("news", ["news-1"]).id === "news-2");
  ok("new items survive cleaning", ["news", "shows", "merch", "links"].every((t) =>
    cleanSite({ sections: [{ type: t, items: [newItem(t)] }] }).sections[0].items.length === 1));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
