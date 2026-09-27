/**
 * The spending wallet.
 *
 * The part of this app where a mistake costs someone real money, so the rules
 * it must keep are asserted rather than trusted: a wallet is never overwritten,
 * a backup restores exactly the same key, and a bad backup is refused rather
 * than quietly turned into a new empty wallet.
 *
 * Run via `npm --prefix app run test`.
 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const w = await import("./src/wallet.js");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};
const is = (name, got, want) => ok(name, Object.is(got, want), `expected ${want}, got ${got}`);
const throws = (name, fn, re) => {
  try { fn(); ok(name, false, "it was allowed"); }
  catch (e) { ok(name, re.test(e.message), `said: ${e.message}`); }
};

// base58, which is how a key gets written on paper.
const bytes = Uint8Array.from([0, 0, 1, 2, 250, 255, 128, 7]);
is("base58 survives a round trip", w.bs58(w.unbs58(w.bs58(bytes))), w.bs58(bytes));
ok("leading zeros are kept, which a number would lose", w.unbs58(w.bs58(bytes))[0] === 0 && w.unbs58(w.bs58(bytes)).length === bytes.length);
throws("characters that aren't base58", () => w.unbs58("0OIl+/"), /not base58/);

// The wallet itself.
store.clear();
is("no wallet to begin with", w.loadWallet(), null);
const made = w.createWallet();
ok("making one gives an address", typeof made.publicKey.toBase58() === "string" && made.publicKey.toBase58().length >= 32);
is("and it is there next time", w.loadWallet().publicKey.toBase58(), made.publicKey.toBase58());

// The rule that matters most: never quietly replace a wallet holding money.
throws("a second wallet is refused", () => w.createWallet(), /already has a wallet/);
is("  and the first is untouched", w.loadWallet().publicKey.toBase58(), made.publicKey.toBase58());

// Backup and restore.
const backup = w.backupOf(made);
ok("the backup is a base58 string", typeof backup === "string" && backup.length > 60);
store.clear();
const back = w.restoreWallet(backup);
is("restoring gives the same address", back.publicKey.toBase58(), made.publicKey.toBase58());
is("  and it is the one on the device now", w.loadWallet().publicKey.toBase58(), made.publicKey.toBase58());
is("  with the same key, so it can still spend", w.backupOf(w.loadWallet()), backup);

store.clear();
throws("an empty backup", () => w.restoreWallet("   "), /Paste your backup/);
throws("a backup that is not one", () => w.restoreWallet("hello"), /isn't a backup key/);
throws("an address pasted instead of a key", () => w.restoreWallet(made.publicKey.toBase58()), /isn't a backup key/);
is("  and none of those left a wallet behind", w.loadWallet(), null);

// Corruption is reported, not papered over.
store.set("amply.wallet.v1", "{ not json");
throws("a damaged wallet says so", () => w.loadWallet(), /could not be read/);

// Networks. Real money unless someone deliberately says otherwise: this
// defaulted to the test network once, which meant a listener could play a
// whole album and send tokens worth nothing, with both ends believing the
// artist had been paid.
store.clear();
is("real money by default", w.networkName(), "mainnet");
is("  and it is real", w.network().real, true);
w.useNetwork("devnet");
is("switching sticks", w.networkName(), "devnet");
is("  and that one is not real", w.network().real, false);

// What a manifest asks for, in this app's words. Absent means real money,
// because every manifest written before the field existed meant that.
is("a manifest saying solana means the real chain", w.networkFor("solana"), "mainnet");
is("saying devnet means the test one", w.networkFor("devnet"), "devnet");
is("saying nothing means real money", w.networkFor(undefined), "mainnet");
is("something unrecognised means nowhere at all", w.networkFor("dogecoin"), null);
throws("an unknown network", () => w.useNetwork("elsewhere"), /No such network/);
w.useNetwork("devnet");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
