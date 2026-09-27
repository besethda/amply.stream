/**
 * Publish what the current node is, so an artist's own node can tell it is old.
 *
 * Amply cannot reach into an artist's account to update anything, and should
 * not be able to. The next best thing is for their editor to notice and say so,
 * which needs somewhere to compare against. This writes that: one small file,
 * served from amply.stream, read by the editor running on their node.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

const source = await readFile(here("../node/src/constants.ts"), "utf8");
const version = source.match(/export const VERSION = "([^"]+)"/)?.[1];
const spec = source.match(/export const SPEC_VERSION = (\d+)/)?.[1];

if (!version || !spec) {
  throw new Error("node/src/constants.ts no longer declares VERSION and SPEC_VERSION where expected");
}

// The schema travels with the version, so setup and repair create exactly the
// tables this node expects rather than a copy that drifted.
const store = await readFile(here("../node/src/store.ts"), "utf8");
const block = store.match(/export const SCHEMA = \[([\s\S]*?)\n\];/)?.[1];
if (!block) throw new Error("node/src/store.ts no longer declares SCHEMA where expected");
// Comments first: a word in backticks in a comment was once published as a
// statement, and every artist's update failed on it.
const code = block.replace(/\/\/.*$/gm, "");
const schema = [...code.matchAll(/`([^`]+)`/g)].map((m) => m[1].replace(/\s+/g, " ").trim());
if (!schema.length) throw new Error("no statements found in SCHEMA");
for (const s of schema) {
  if (!/^CREATE (TABLE|INDEX|UNIQUE INDEX) IF NOT EXISTS /.test(s)) {
    throw new Error(`SCHEMA holds something that isn't a CREATE … IF NOT EXISTS statement: ${JSON.stringify(s.slice(0, 80))}`);
  }
}

// Changes to those tables. Creating a table is idempotent; altering one is not,
// so these carry an id and setup records the highest one it has applied.
const migrationBlock = store.match(/export const MIGRATIONS[^=]*=\s*\[([\s\S]*?)\];/)?.[1];
if (migrationBlock === undefined) {
  throw new Error("node/src/store.ts no longer declares MIGRATIONS where expected");
}
const migrations = [...migrationBlock.matchAll(/\{\s*id:\s*(\d+),\s*sql:\s*`([^`]+)`\s*\}/g)]
  .map((m) => ({ id: Number(m[1]), sql: m[2].replace(/\s+/g, " ").trim() }));

for (let i = 1; i < migrations.length; i++) {
  if (migrations[i].id <= migrations[i - 1].id) {
    throw new Error(`MIGRATIONS ids must increase: ${migrations[i - 1].id} then ${migrations[i].id}`);
  }
}

// The rate limiters the Worker expects (node/src/limits.ts), for setup to
// bind. Each gets a fixed namespace: Cloudflare counts per namespace within an
// account, and the Worker's keys already name its own host.
const limitsSrc = await readFile(here("../node/src/limits.ts"), "utf8");
const NAMESPACES = { LIMIT_LISTEN: "7101", LIMIT_MEDIA: "7102", LIMIT_WALLET: "7103", LIMIT_NEW: "7104" };
const limits = [...limitsSrc.matchAll(/binding: "(LIMIT_[A-Z]+)", limit: (\d+), period: (\d+)/g)]
  .map((m) => ({ binding: m[1], limit: Number(m[2]), period: Number(m[3]), namespace: NAMESPACES[m[1]] }));
if (limits.length !== Object.keys(NAMESPACES).length || limits.some((l) => !l.namespace || ![10, 60].includes(l.period))) {
  throw new Error(`node/src/limits.ts RULES don't match what setup binds: ${JSON.stringify(limits)}`);
}

const out = {
  version, spec: Number(spec), schema, migrations, limits,
  published: new Date().toISOString().slice(0, 10),
};
await writeFile(here("../site/node-version.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(`site/node-version.json  ${version} (spec ${spec}, ${schema.length} tables, ${migrations.length} migrations)`);
