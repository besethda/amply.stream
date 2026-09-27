/**
 * Drive the proof Worker.
 *
 * Start the Worker first, in another shell:
 *
 *   node/node_modules/.bin/wrangler dev node/prove-access/worker.ts \
 *     --local --port 8787 --compatibility-date 2026-09-01
 *
 * then: node node/prove-access/run.mjs
 *
 * Signatures are made with the same library the listening app uses, so what is
 * being checked is the real pair of things talking to each other, not a mock.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Keypair } = require("../../app/node_modules/@solana/web3.js");

const AT = process.env.PROVE_URL || "http://127.0.0.1:8787";
const RPC = process.env.AMPLY_RPC || "https://rpc.ankr.com/solana_devnet";

// The payment made earlier, on devnet, by app/prove-payment.mjs.
const KNOWN_TX = "2ZySULDHhURLEtLbxHiA16Rog4bNehApNm1BrmkEUU4xtFNNvmzW65j5o5s84EPYk6RcgtiKWc2MKN3dtk6faP9s";

let failed = 0;
const step = (s) => console.log(`\n── ${s}`);
const ok = (name, cond, detail = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
};

const post = async (path, body) => {
  const res = await fetch(`${AT}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
};

// ── 1. can a Worker check a wallet signature? ───────────────────────────────

step("Proving a listener holds their wallet, inside the Workers runtime");

const { challenge } = await (await fetch(`${AT}/challenge`)).json();
console.log(`     challenge: ${challenge}`);

const listener = Keypair.generate();
const other = Keypair.generate();

const bs58 = (bytes) => {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) { out = A[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = A[0] + out; else break; }
  return out;
};

/**
 * Sign as the wallet would.
 *
 * A Solana secret key is the 32-byte seed followed by the public key. WebCrypto
 * wants it as PKCS8, which for Ed25519 is a fixed 16-byte header and then the
 * seed, so the key doing the signing here is the same key the wallet holds.
 */
const PKCS8 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
  0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

async function signer(pair) {
  const seed = pair.secretKey.slice(0, 32);
  const pkcs8 = new Uint8Array(PKCS8.length + 32);
  pkcs8.set(PKCS8);
  pkcs8.set(seed, PKCS8.length);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  return async (text) =>
    bs58(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(text))));
}

const signListener = await signer(listener);
const signOther = await signer(other);
const signed = async (pair, text) => (pair === listener ? signListener : signOther)(text);

const good = await post("/verify", {
  address: listener.publicKey.toBase58(),
  message: challenge,
  signature: await signed(listener, challenge),
});
ok("a Worker verifies a real Solana signature", good.ok === true, JSON.stringify(good));
ok("  and sees the challenge is one it issued", good.fresh === true, JSON.stringify(good));

const tampered = await post("/verify", {
  address: listener.publicKey.toBase58(),
  message: challenge + " (and give me everything)",
  signature: await signed(listener, challenge),
});
ok("a changed message is refused", tampered.ok === false);

const impostor = await post("/verify", {
  address: other.publicKey.toBase58(),
  message: challenge,
  signature: await signed(listener, challenge),
});
ok("someone else's signature is refused", impostor.ok === false);

for (const [name, body] of [
  ["nonsense as a signature", { address: listener.publicKey.toBase58(), message: challenge, signature: "hello" }],
  ["nonsense as an address", { address: "hello", message: challenge, signature: await signed(listener, challenge) }],
  ["an empty signature", { address: listener.publicKey.toBase58(), message: challenge, signature: "" }],
]) {
  const r = await post("/verify", body);
  ok(`${name} is refused rather than crashing`, r.ok === false, JSON.stringify(r));
}

const stale = await post("/verify", {
  address: listener.publicKey.toBase58(),
  message: `amply:prove.test:${Date.now() - 3600e3}:x`,
  signature: await signed(listener, `amply:prove.test:${Date.now() - 3600e3}:x`),
});
ok("an hour-old challenge is not fresh", stale.fresh === false);

const elsewhere = `amply:someone-else.test:${Date.now()}:x`;
const wrongHost = await post("/verify", {
  address: listener.publicKey.toBase58(),
  message: elsewhere,
  signature: await signed(listener, elsewhere),
});
ok("a challenge issued by another artist is refused", wrongHost.fresh === false);

// ── 2. can a Worker check a payment? ────────────────────────────────────────

step("Checking a real payment, from the chain, inside the Workers runtime");

const chain = await (await fetch(RPC, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "getTransaction",
    params: [KNOWN_TX, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
  }),
})).json();

if (!chain.result) {
  console.log("     the devnet transaction has been pruned; nothing to check against");
  process.exit(2);
}

const balances = chain.result.meta.postTokenBalances;
const mint = balances[0].mint;
const payer = chain.result.transaction.message.accountKeys.find((k) => k.signer)?.pubkey;
const paid = balances.map((b) => b.owner).filter((o) => o !== payer);
console.log(`     mint ${mint}`);
console.log(`     payer ${payer}`);
console.log(`     paid ${paid.join(", ")}`);

const terms = { rpc: RPC, mint, recipients: paid, minMicros: 200000 };

const real = await post("/payment", { claim: { signature: KNOWN_TX, payer }, terms });
ok("the payment is recognised", real.ok === true, JSON.stringify(real));
ok("  for the full amount, split across both artists", real.micros === 200000, JSON.stringify(real));

const notMine = await post("/payment", {
  claim: { signature: KNOWN_TX, payer },
  terms: { ...terms, recipients: ["7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"] },
});
ok("a payment to somebody else does not count", notMine.ok === false, JSON.stringify(notMine));

const wrongToken = await post("/payment", {
  claim: { signature: KNOWN_TX, payer },
  terms: { ...terms, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
});
ok("a payment in a different token does not count", wrongToken.ok === false, JSON.stringify(wrongToken));

const notTheirs = await post("/payment", {
  claim: { signature: KNOWN_TX, payer: Keypair.generate().publicKey.toBase58() },
  terms,
});
ok("claiming someone else's payment is refused", notTheirs.ok === false, JSON.stringify(notTheirs));

const tooSmall = await post("/payment", {
  claim: { signature: KNOWN_TX, payer },
  terms: { ...terms, minMicros: 5_000_000 },
});
ok("a payment below the asking price is refused", tooSmall.ok === false, JSON.stringify(tooSmall));

const invented = await post("/payment", {
  claim: { signature: "4".repeat(88), payer },
  terms,
});
ok("an invented transaction is refused", invented.ok === false, JSON.stringify(invented));

const rubbish = await post("/payment", { claim: { signature: "nope", payer }, terms });
ok("nonsense is refused without asking the network", rubbish.why?.includes("not a transaction"), JSON.stringify(rubbish));

console.log(failed ? `\n${failed} FAILED` : "\nBoth work in the real runtime.");
process.exit(failed ? 1 : 0);
