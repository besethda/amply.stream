#!/usr/bin/env node
// Amply manifest validator. Zero dependencies.
//   node spec/validate.mjs <file-or-url>

import { validate, SPEC_VERSION, MAX_BYTES } from "./manifest-rules.mjs";

const errors = [];
const warnings = [];
const err = (p, m) => errors.push(`${p}: ${m}`);

const target = process.argv[2];
if (!target) {
  console.error("usage: node spec/validate.mjs <file-or-url>");
  process.exit(2);
}

let raw;
try {
  if (/^https?:\/\//i.test(target)) {
    const res = await fetch(target);
    if (!res.ok) { console.error(`fetch failed: HTTP ${res.status}`); process.exit(2); }
    raw = await res.text();
  } else {
    raw = await (await import("node:fs/promises")).readFile(target, "utf8");
  }
} catch (e) {
  console.error(`could not read ${target}: ${e.message}`);
  process.exit(2);
}

const bytes = Buffer.byteLength(raw, "utf8");
if (bytes > MAX_BYTES) err("$", `manifest is ${(bytes / 1048576).toFixed(2)} MB — clients must refuse anything over 2 MB`);

let parsed;
try { parsed = JSON.parse(raw); }
catch (e) { console.error(`invalid JSON: ${e.message}`); process.exit(1); }

const { errors: found, warnings: noted } = validate(parsed);
errors.push(...found);
warnings.push(...noted);

const n = (x) => `${x} ${x === 1 ? "problem" : "problems"}`;
if (warnings.length) { console.log("warnings:"); warnings.forEach((w) => console.log(`  ! ${w}`)); }
if (errors.length) {
  console.log("errors:");
  errors.forEach((e) => console.log(`  x ${e}`));
  console.log(`\nFAIL — ${n(errors.length)} (${(bytes / 1024).toFixed(1)} kB)`);
  process.exit(1);
}
console.log(`OK — valid Amply manifest v${SPEC_VERSION} (${(bytes / 1024).toFixed(1)} kB)`);
