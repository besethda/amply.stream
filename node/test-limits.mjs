/**
 * The limits that keep anyone from running an artist's service into the
 * ground (src/limits.ts): Cloudflare's counter when it's there, a count in
 * memory when it isn't, and which requests fall under which.
 *
 * Run via `npm run test:limits`.
 */
import { allow, ruleFor, RULES } from "./src/limits.ts";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

// ── with Cloudflare's counter ───────────────────────────────────────────────
const asked = [];
const env = { LIMIT_LISTEN: { limit: async ({ key }) => { asked.push(key); return { success: asked.length <= 2 }; } } };
ok("Cloudflare's counter decides when it's there", await allow(env, RULES.listen, "a") && await allow(env, RULES.listen, "a") && !(await allow(env, RULES.listen, "a")));
ok("  asked with the caller's key", asked.every((k) => k === "a"));
const broken = { LIMIT_LISTEN: { limit: async () => { throw new Error("down"); } } };
ok("  a counter that fails doesn't take the service down with it", await allow(broken, RULES.listen, "b"));

// ── without it: counted in memory ───────────────────────────────────────────
const t0 = 1_000_000;
let n = 0;
for (let i = 0; i < RULES.listen.limit + 5; i++) if (await allow({}, RULES.listen, "c", t0)) n++;
ok(`without the binding, still ${RULES.listen.limit} a minute`, n === RULES.listen.limit, String(n));
ok("  another caller has their own count", await allow({}, RULES.listen, "d", t0));
ok("  and a minute later, it starts again", await allow({}, RULES.listen, "c", t0 + 61_000));
let w = 0;
for (let i = 0; i < 10; i++) if (await allow({}, RULES.wallet, "wallet-x", t0)) w++;
ok(`a wallet reports at most ${RULES.wallet.limit} plays a minute`, w === RULES.wallet.limit, String(w));

// ── what falls under what ───────────────────────────────────────────────────
ok("listener requests that cost: the strict count", ruleFor("POST", "/listen/played") === RULES.listen && ruleFor("POST", "/listen/buy/wallet") === RULES.listen && ruleFor("POST", "/listen/download") === RULES.listen);
ok("  a challenge costs nothing: the loose one", ruleFor("POST", "/listen/challenge") === RULES.media);
ok("audio, pictures and pages: the loose count", ruleFor("GET", "/audio/a.mp3") === RULES.media && ruleFor("GET", "/") === RULES.media && ruleFor("GET", "/manifest.json") === RULES.media);
ok("the artist's editor isn't counted (it's behind their sign-in)", ruleFor("PUT", "/manage/manifest") === null && ruleFor("GET", "/manage") === null);
ok("  nor Stripe's signed notices", ruleFor("POST", "/stripe/webhook") === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
