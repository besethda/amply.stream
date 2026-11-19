/**
 * Receipts: every payment this device sent, kept here and nowhere else.
 *
 * Run via `npm --prefix app run test`.
 */
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const { recordReceipt, receipts, forgetReceipts } = await import("./src/receipts.js");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { cond ? pass++ : fail++; console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`); };

ok("nothing to begin with", receipts().length === 0);
recordReceipt({ micros: 1_000_000, origin: "https://a.example", artist: "A", signature: "sig1", at: 1 });
recordReceipt({ micros: 250_000, origin: "https://b.example", artist: "B", kind: "tip", signature: "sig2", at: 2 });
ok("newest first", receipts()[0].signature === "sig2" && receipts()[1].signature === "sig1");
recordReceipt({ micros: 1_000_000, signature: "sig1", at: 3 });
ok("a payment found twice is one receipt", receipts().length === 2);
recordReceipt({ micros: 0, signature: "sig3" });
recordReceipt({ micros: -5, signature: "sig4" });
ok("nothing for nothing", receipts().length === 2);
ok("what it was for, kept", receipts()[0].kind === "tip" && receipts()[1].kind === "listen");
for (let i = 0; i < 600; i++) recordReceipt({ micros: 1, signature: `x${i}`, at: 10 + i });
ok("the newest 500 kept", receipts().length === 500 && receipts()[0].signature === "x599");
store.set("amply.receipts.v1", "not json");
ok("a corrupt store reads as empty, not a crash", receipts().length === 0);
forgetReceipts();
ok("forgotten on request", receipts().length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
