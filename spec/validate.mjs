#!/usr/bin/env node
// Amply manifest validator. Zero dependencies.
//   node spec/validate.mjs <file-or-url>

const SPEC_VERSION = 1;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_RATE = 1.0;
const ID_RE = /^[a-z0-9-]{1,64}$/;
const B58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const errors = [];
const warnings = [];
const err = (p, m) => errors.push(`${p}: ${m}`);
const warn = (p, m) => warnings.push(`${p}: ${m}`);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function str(v, p, { required = false, min = 1, max = Infinity } = {}) {
  if (v === undefined) { if (required) err(p, "required"); return false; }
  if (typeof v !== "string") { err(p, `must be a string, got ${typeof v}`); return false; }
  if (v.length < min) { err(p, `must be at least ${min} character(s)`); return false; }
  if (v.length > max) { err(p, `must be at most ${max} characters (got ${v.length})`); return false; }
  return true;
}

function httpsUrl(v, p, { required = false } = {}) {
  if (v === undefined) { if (required) err(p, "required"); return false; }
  if (typeof v !== "string") { err(p, "must be a string URL"); return false; }
  let u;
  try { u = new URL(v); } catch { err(p, `not a valid absolute URL: ${JSON.stringify(v)}`); return false; }
  if (u.protocol !== "https:") { err(p, `must be https, got ${u.protocol.replace(":", "")}`); return false; }
  return true;
}

function id(v, p, seen) {
  if (!str(v, p, { required: true })) return;
  if (!ID_RE.test(v)) { err(p, `must match [a-z0-9-], 1-64 chars (got ${JSON.stringify(v)})`); return; }
  if (seen.has(v)) err(p, `duplicate id ${JSON.stringify(v)} — ids must be unique across the manifest`);
  seen.add(v);
}

function validate(m) {
  if (!isObj(m)) { err("$", "manifest must be a JSON object"); return; }

  if (m.amply === undefined) err("amply", "required");
  else if (m.amply !== SPEC_VERSION) err("amply", `unsupported spec version ${m.amply} (this validator knows ${SPEC_VERSION})`);

  if (str(m.updated, "updated", { required: true })) {
    if (Number.isNaN(Date.parse(m.updated))) err("updated", "not a parseable ISO 8601 timestamp");
  }

  // artist
  if (!isObj(m.artist)) err("artist", "required, must be an object");
  else {
    str(m.artist.name, "artist.name", { required: true, max: 200 });
    if (m.artist.bio !== undefined) str(m.artist.bio, "artist.bio", { max: 2000 });
    if (m.artist.image !== undefined) httpsUrl(m.artist.image, "artist.image");
    if (m.artist.links !== undefined) {
      if (!Array.isArray(m.artist.links)) err("artist.links", "must be an array");
      else {
        if (m.artist.links.length > 20) err("artist.links", "at most 20 links");
        m.artist.links.forEach((l, i) => {
          const p = `artist.links[${i}]`;
          if (!isObj(l)) return err(p, "must be an object");
          str(l.label, `${p}.label`, { required: true, max: 40 });
          httpsUrl(l.url, `${p}.url`, { required: true });
        });
      }
    }
  }

  // content
  if (m.content !== undefined) {
    if (!isObj(m.content)) err("content", "must be an object");
    else if (m.content.explicit !== undefined && typeof m.content.explicit !== "boolean")
      err("content.explicit", "must be a boolean");
  }

  // payment
  if (m.payment !== undefined) {
    if (!Array.isArray(m.payment)) err("payment", "must be an array");
    else {
      if (m.payment.length === 0) warn("payment", "empty — this artist cannot be paid");
      m.payment.forEach((e, i) => {
        const p = `payment[${i}]`;
        if (!isObj(e)) return err(p, "must be an object");
        if (!str(e.type, `${p}.type`, { required: true })) return;
        if (e.type === "solana-usdc") {
          if (str(e.address, `${p}.address`, { required: true }) && !B58_RE.test(e.address))
            err(`${p}.address`, "not a plausible base58 Solana address (32-44 chars)");
          if (typeof e.ratePerMinute !== "number") err(`${p}.ratePerMinute`, "required, must be a number");
          else if (!(e.ratePerMinute > 0)) err(`${p}.ratePerMinute`, "must be greater than 0");
          else if (e.ratePerMinute > MAX_RATE) err(`${p}.ratePerMinute`, `must be at most ${MAX_RATE} USD/min (got ${e.ratePerMinute})`);
          if (e.settleAt !== undefined) {
            if (typeof e.settleAt !== "number") err(`${p}.settleAt`, "must be a number");
            else if (e.settleAt < 0.05 || e.settleAt > 100) err(`${p}.settleAt`, "must be between 0.05 and 100 USD");
          }
        } else if (e.type === "link") {
          str(e.label, `${p}.label`, { required: true, max: 40 });
          httpsUrl(e.url, `${p}.url`, { required: true });
        } else {
          warn(p, `unknown payment type ${JSON.stringify(e.type)} — clients will skip it`);
        }
      });
    }
  }

  // releases
  const ids = new Set();
  if (!Array.isArray(m.releases)) { err("releases", "required, must be an array"); return; }
  if (m.releases.length === 0) warn("releases", "empty — valid, but nothing to listen to");
  m.releases.forEach((r, i) => {
    const p = `releases[${i}]`;
    if (!isObj(r)) return err(p, "must be an object");
    id(r.id, `${p}.id`, ids);
    str(r.title, `${p}.title`, { required: true, max: 300 });
    if (r.date !== undefined && !DATE_RE.test(String(r.date))) err(`${p}.date`, "must be YYYY-MM-DD");
    if (r.art !== undefined) httpsUrl(r.art, `${p}.art`);
    if (!Array.isArray(r.tracks) || r.tracks.length === 0) return err(`${p}.tracks`, "required, must be a non-empty array");
    r.tracks.forEach((t, j) => {
      const tp = `${p}.tracks[${j}]`;
      if (!isObj(t)) return err(tp, "must be an object");
      id(t.id, `${tp}.id`, ids);
      str(t.title, `${tp}.title`, { required: true, max: 300 });
      if (!Number.isInteger(t.duration)) err(`${tp}.duration`, "required, must be an integer (seconds)");
      else if (t.duration <= 0) err(`${tp}.duration`, "must be greater than 0");
      httpsUrl(t.url, `${tp}.url`, { required: true });
      if (t.explicit !== undefined && typeof t.explicit !== "boolean") err(`${tp}.explicit`, "must be a boolean");
    });
  });
}

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

validate(parsed);

const n = (x) => `${x} ${x === 1 ? "problem" : "problems"}`;
if (warnings.length) { console.log("warnings:"); warnings.forEach((w) => console.log(`  ! ${w}`)); }
if (errors.length) {
  console.log("errors:");
  errors.forEach((e) => console.log(`  x ${e}`));
  console.log(`\nFAIL — ${n(errors.length)} (${(bytes / 1024).toFixed(1)} kB)`);
  process.exit(1);
}
console.log(`OK — valid Amply manifest v${SPEC_VERSION} (${(bytes / 1024).toFixed(1)} kB)`);
