/**
 * Check the live site's policy against the live site's pages.
 *
 * The setup pages carry an inline script, allowed by a hash of its
 * contents. If a deploy ever ships a page without its matching hash the page
 * simply stops working, with nothing in the terminal to say so — the failure
 * appears in an artist's browser console, mid-setup. So it is checked against
 * what is actually being served, after deploying.
 *
 *     npm run verify:live
 */
import { createHash } from "node:crypto";
let bad = 0;
for (const page of ["start", "repair", "domain"]) {
  const res = await fetch(`https://amply.stream/${page}`);
  const html = await res.text();
  const csp = res.headers.get("content-security-policy") || "";
  const inline = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
    .map(([, b]) => b).filter((b) => b.trim());
  if (!inline.length) { console.log(`FAIL  /${page}: no inline script found`); bad++; }
  for (const body of inline) {
    const h = `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`;
    const ok = csp.includes(h);
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "FAIL"}  /${page}: the served script is allowed by the served policy`);
    if (!ok) console.log(`        need ${h}\n        got  ${csp.match(/'sha256-[^']+'/g)}`);
  }
}
console.log(bad ? "\nMISMATCH — setup would break" : "\nthe policy matches what is served");
process.exit(bad ? 1 : 0);
