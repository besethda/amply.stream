/**
 * The passkey wallet: the same passkey gives the same wallet, the address is
 * the one Solana's own library computes, and every way a browser can answer
 * (secret at once, secret after a second prompt, no PRF, cancelled) is met.
 *
 *   node spec/test-passkey-wallet.mjs
 */
import { createRequire } from "node:module";
import {
  WALLET_LABEL, NoPasskeySecret, createPasskeySeed, restorePasskeySeed, seedFrom, addressOf, base58,
} from "./passkey-wallet.mjs";

const require = createRequire(import.meta.url);
const { Keypair, PublicKey } = require("../app/node_modules/@solana/web3.js");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ── the maths ───────────────────────────────────────────────────────────────
const secretA = new Uint8Array(32).fill(7);
const secretB = new Uint8Array(32).fill(8);
const seedA = await seedFrom(secretA);
ok("a passkey secret becomes a 32-byte seed", seedA.length === 32);
ok("  the same secret always gives the same seed", eq(seedA, await seedFrom(secretA)));
ok("  a different secret gives a different one", !eq(seedA, await seedFrom(secretB)));
ok("  and the seed isn't the secret itself", !eq(seedA, secretA));
const addr = await addressOf(seedA);
ok("the address matches Solana's own library", addr === Keypair.fromSeed(seedA).publicKey.toBase58(), addr);
for (const [label, bytes] of [["all zeros", new Uint8Array(32)], ["leading zeros", Uint8Array.from([0, 0, 5, ...new Array(29).fill(200)])], ["ordinary bytes", Uint8Array.from({ length: 32 }, (_, i) => 255 - i * 7)]]) {
  ok(`base58 matches Solana's for ${label}`, base58(bytes) === new PublicKey(bytes).toBase58());
}

// ── a pretend browser ───────────────────────────────────────────────────────
let created = null, asked = [];
function browser({ secret = secretA, atCreate = true, prf = true, cancel = false } = {}) {
  asked = []; created = null;
  const creds = {
    async create({ publicKey }) {
      if (cancel) throw Object.assign(new Error("closed"), { name: "NotAllowedError" });
      created = publicKey;
      return {
        rawId: new Uint8Array([1, 2, 3]).buffer,
        getClientExtensionResults: () => (!prf ? { prf: { enabled: false } } : atCreate ? { prf: { enabled: true, results: { first: secret.buffer.slice(0) } } } : { prf: { enabled: true } }),
      };
    },
    async get({ publicKey }) {
      asked.push(publicKey);
      if (cancel) throw Object.assign(new Error("closed"), { name: "NotAllowedError" });
      return { getClientExtensionResults: () => (prf ? { prf: { results: { first: secret.buffer.slice(0) } } } : {}) };
    },
  };
  Object.defineProperty(globalThis.navigator, "credentials", { value: creds, configurable: true });
}
const salt = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(WALLET_LABEL)));

browser({ atCreate: true });
const s1 = await createPasskeySeed();
ok("a passkey that answers while being made gives the wallet straight away", eq(s1, seedA) && asked.length === 0);
ok("  the passkey asks for the wallet's label", eq(new Uint8Array(created.extensions.prf.eval.first), salt));
ok("  it names no person: the keychain shows \"Amply wallet\"", created.user.name === "Amply wallet" && created.user.displayName === "Amply wallet");
ok("  Face ID, fingerprint or PIN is required", created.authenticatorSelection.userVerification === "required");
ok("  and it's saved to sync across the person's devices", created.authenticatorSelection.residentKey === "required");

browser({ atCreate: false });
const s2 = await createPasskeySeed();
ok("one that needs a second confirmation is asked once more", eq(s2, seedA) && asked.length === 1);
ok("  for exactly the passkey just made", asked[0].allowCredentials?.length === 1);

browser({ secret: secretA });
ok("restoring on another device gives the same wallet", eq(await restorePasskeySeed(), seedA));
ok("  letting the person pick any of their passkeys, a phone's included", asked[0].allowCredentials === undefined);

const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
browser({ prf: false });
ok("a passkey that can't make secrets says so, so a backup code can be offered", (await threw(createPasskeySeed)) instanceof NoPasskeySecret);
ok("  and restoring with one says so too", (await threw(restorePasskeySeed)) instanceof NoPasskeySecret);
browser({ cancel: true });
const c = await threw(createPasskeySeed);
ok("closing the dialog is a plain cancel, not an error", c?.name === "Cancelled");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
