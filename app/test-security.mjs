/**
 * What an artist's listing, or an artist's server, must not be able to do to
 * a listener's app. Every artist is a stranger to the app: anyone can run a
 * streaming service and share its link.
 *
 * Run via `npm --prefix app run test`.
 */
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

const { artStyle, styleUrl } = await import("./src/looks.js");
const { isStripePage } = await import("./src/identify.js");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

// ── pictures, as styles ─────────────────────────────────────────────────────
const plain = artStyle("https://x.example/cover.jpg", "s");
ok("a cover's address goes into its style", plain.includes('url("https://x.example/cover.jpg")'));
const sneaky = artStyle('https://x.example/a.jpg\n");position:fixed;inset:0;z-index:99;background:url(https://evil.example/fake-prompt.png)', "s");
ok("a line break can't end the address and add styling of its own", !/position\s*:\s*fixed/.test(sneaky.replace(/url\("[^"]*"\)/, "")) && (sneaky.match(/url\(/g) || []).length === 1, sneaky);
ok("  nor can a quote", !artStyle('https://x.example/a".jpg', "s").includes('a".jpg'));
ok("  nor a bracket", !/url\("[^"]*\)[^"]*"\)/.test(artStyle("https://x.example/a).jpg", "s")));
ok("an http picture isn't used", !artStyle("http://x.example/a.jpg", "s").includes("url("));
ok("  nor javascript:", !artStyle("javascript:alert(1)", "s").includes("url("));
ok("a picture made on this phone (data:) is", styleUrl("data:image/jpeg;base64,AAAA")?.startsWith("data:image/jpeg"));
ok("no picture: the gradient", !artStyle(null, "s").includes("url(") && artStyle(null, "s").includes("gradient"));

// ── where an artist's server may send a listener ───────────────────────────
ok("Stripe's billing page is Stripe's", isStripePage("https://billing.stripe.com/p/session/test_abc"));
ok("  and a checkout", isStripePage("https://checkout.stripe.com/c/pay/cs_test_x"));
ok("a look-alike isn't", !isStripePage("https://billing-stripe.com/p") && !isStripePage("https://stripe.com.evil.example/p") && !isStripePage("https://evilstripe.com/p"));
ok("  nor javascript:", !isStripePage("javascript:alert(1)"));
ok("  nor plain http", !isStripePage("http://billing.stripe.com/p"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
