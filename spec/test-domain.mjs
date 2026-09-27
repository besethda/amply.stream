/**
 * Reading an artist's domain record.
 *
 * This is what stands between a listener and an impersonator, so every case
 * here is either something DNS really does (long records split in pieces) or
 * something a faker would try.
 *
 *   node spec/test-domain.mjs
 */
import { bareDomain, manifestFromAnswer, lookup, confirms, recordFor } from "./domain.mjs";

let pass = 0, fail = 0;
const is = (name, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  good ? pass++ : fail++;
  console.log(`${good ? "ok  " : "FAIL"}  ${name}${good ? "" : ` — expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`}`);
};

const NODE = "https://someone.sub.workers.dev/manifest.json";
const txt = (...strings) => ({ Answer: [{ type: 16, data: strings.map((x) => `"${x}"`).join(" ") }] });

// ── what counts as a domain ─────────────────────────────────────────────────

is("a plain domain", bareDomain("taylorswift.com"), "taylorswift.com");
is("typed with https and a slash", bareDomain("https://TaylorSwift.com/"), "taylorswift.com");
is("a subdomain is a domain too", bareDomain("listen.taylorswift.com"), "listen.taylorswift.com");
is("a link with a path is a link, not a domain", bareDomain("taylorswift.com/music"), null);
is("a workers.dev address is a service, not a domain", bareDomain("x.sub.workers.dev"), null);
is("nonsense is nothing", bareDomain("not a domain"), null);
is("a single word is nothing", bareDomain("localhost"), null);

// ── reading the record ──────────────────────────────────────────────────────

is("the record's value is the manifest", manifestFromAnswer(txt(recordFor(NODE))), NODE);
is("a long record split in two is read as one",
  manifestFromAnswer(txt("amply=https://someone.sub.work", "ers.dev/manifest.json")), NODE);
is("other TXT records on the name are ignored",
  manifestFromAnswer({ Answer: [
    { type: 16, data: '"google-site-verification=abc"' },
    { type: 16, data: `"${recordFor(NODE)}"` },
  ] }), NODE);
is("a plain http address is refused", manifestFromAnswer(txt("amply=http://evil.example/manifest.json")), null);
is("a record without the prefix is not ours", manifestFromAnswer(txt(NODE)), null);
is("no answer is no record", manifestFromAnswer({ Status: 3 }), null);
is("something that isn't a URL is nothing", manifestFromAnswer(txt("amply=javascript:alert(1)")), null);

// ── asking the resolvers ────────────────────────────────────────────────────

const reply = (body, ok = true) => async () => ({ ok, json: async () => body });

is("found through the first resolver", await lookup("taylorswift.com", reply(txt(recordFor(NODE)))), NODE);

{
  let calls = 0;
  const flaky = async (url) => {
    calls++;
    if (url.includes("1.1.1.1")) throw new TypeError("blocked");
    return { ok: true, json: async () => txt(recordFor(NODE)) };
  };
  is("if the first resolver is unreachable, the second is asked", await lookup("taylorswift.com", flaky), NODE);
  is("  and no more than it needed", calls, 2);
}

{
  let asked = "";
  await lookup("TaylorSwift.com", async (url) => { asked = url; return { ok: true, json: async () => ({}) }; });
  is("the question is the _amply name, lower-cased", asked.includes(encodeURIComponent("_amply.taylorswift.com")), true);
}

{
  let calls = 0;
  const allDown = async () => { calls++; throw new TypeError("blocked"); };
  is("with every resolver blocked, the answer is simply none", await lookup("taylorswift.com", allDown), null);
  is("  after trying each of the three once", calls, 3);
}

is("a domain with no record is nothing", await lookup("taylorswift.com", reply({ Status: 0, Answer: [] })), null);
is("an address that isn't a domain isn't even looked up", await lookup("x.sub.workers.dev/manifest.json", reply(txt(recordFor(NODE)))), null);

// ── both ways round ─────────────────────────────────────────────────────────

is("a domain pointing at this manifest confirms it",
  await confirms("taylorswift.com", NODE, reply(txt(recordFor(NODE)))), true);
is("  whatever the trailing slash",
  await confirms("taylorswift.com", NODE + "/", reply(txt(recordFor(NODE)))), true);
is("a domain pointing somewhere else does not — the impersonator's case",
  await confirms("taylorswift.com", "https://faker.sub.workers.dev/manifest.json", reply(txt(recordFor(NODE)))), false);
is("a domain with no record confirms nothing",
  await confirms("taylorswift.com", NODE, reply({ Answer: [] })), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
