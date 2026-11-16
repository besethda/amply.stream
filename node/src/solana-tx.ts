/**
 * Reading a Solana transaction, without a Solana library.
 *
 * The node signs listeners' payments as their fee payer (feepay.ts), so it
 * must know exactly what it is signing. This reads the wire format byte by
 * byte and refuses anything it doesn't fully understand:
 *
 *   - only legacy transactions. A versioned one can name accounts through
 *     address lookup tables, which a reader of the message alone can't see;
 *   - every byte accounted for: nothing trailing, nothing short;
 *   - every account index in range.
 *
 * Kept deliberately small: the node is code an artist has to update inside
 * their own account, and a reader is easier to trust when it can be read.
 */

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let k = zeros; k < bytes.length; k++) {
    let carry = bytes[k];
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] * 256;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  return "1".repeat(zeros) + digits.reverse().map((d) => B58[d]).join("");
}

export function unbase58(s: string): Uint8Array | null {
  if (typeof s !== "string" || !s || s.length > 128) return null;
  const bytes: number[] = [];
  for (const ch of s) {
    let carry = B58.indexOf(ch);
    if (carry < 0) return null;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const ch of s) { if (ch === "1") bytes.push(0); else break; }
  return new Uint8Array(bytes.reverse());
}

/** A 32-byte key from base58, or null. */
export function keyOf(s: string): Uint8Array | null {
  const k = unbase58(s);
  return k && k.length === 32 ? k : null;
}

export class TxError extends Error {}

export interface Instruction {
  program: number;       // index into accounts
  accounts: number[];    // indices into accounts
  data: Uint8Array;
}

export interface Transaction {
  signatures: Uint8Array[];     // 64 bytes each, all zero where not yet signed
  header: { required: number; readonlySigned: number; readonlyUnsigned: number };
  accounts: string[];           // base58
  blockhash: string;            // base58
  instructions: Instruction[];
  message: Uint8Array;          // the exact bytes every signature covers
}

/** Bounds on what a payment could need; anything bigger isn't one. */
const MAX_TX_BYTES = 1232;      // Solana's packet limit
const MAX_SIGNATURES = 4;

class Reader {
  at = 0;
  bytes: Uint8Array;
  constructor(bytes: Uint8Array) { this.bytes = bytes; }
  byte(): number {
    if (this.at >= this.bytes.length) throw new TxError("the transaction ends early");
    return this.bytes[this.at++];
  }
  take(n: number): Uint8Array {
    if (n < 0 || this.at + n > this.bytes.length) throw new TxError("the transaction ends early");
    const out = this.bytes.slice(this.at, this.at + n);
    this.at += n;
    return out;
  }
  /** Solana's "compact-u16": up to three bytes, seven bits each. */
  short(): number {
    let value = 0;
    for (let i = 0; i < 3; i++) {
      const b = this.byte();
      value |= (b & 0x7f) << (7 * i);
      if ((b & 0x80) === 0) {
        // The shortest encoding only, or one value would have two spellings.
        if (i > 0 && b === 0) throw new TxError("a length is written in a non-standard way");
        return value;
      }
    }
    throw new TxError("a length is too long");
  }
}

export function shortBytes(n: number): number[] {
  const out: number[] = [];
  let v = n;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if (v === 0) { out.push(b); return out; }
    out.push(b | 0x80);
  }
}

/** Read a whole wire transaction, or throw TxError saying why not. */
export function readTransaction(bytes: Uint8Array): Transaction {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new TxError("there is no transaction");
  if (bytes.length > MAX_TX_BYTES) throw new TxError("the transaction is too large");
  const r = new Reader(bytes);

  const sigCount = r.short();
  if (sigCount === 0 || sigCount > MAX_SIGNATURES) throw new TxError("the transaction has an unexpected number of signatures");
  const signatures: Uint8Array[] = [];
  for (let i = 0; i < sigCount; i++) signatures.push(r.take(64));

  const messageStart = r.at;
  const required = r.byte();
  // A versioned message sets the top bit of its first byte. Refused: it can
  // name accounts in lookup tables that aren't in these bytes.
  if (required & 0x80) throw new TxError("only legacy transactions are accepted");
  const readonlySigned = r.byte();
  const readonlyUnsigned = r.byte();

  const accountCount = r.short();
  if (accountCount === 0 || accountCount > 64) throw new TxError("the transaction has an unexpected number of accounts");
  const accounts: string[] = [];
  for (let i = 0; i < accountCount; i++) accounts.push(base58(r.take(32)));
  if (new Set(accounts).size !== accounts.length) throw new TxError("an account is listed twice");

  if (required !== sigCount) throw new TxError("the signatures don't match the signers");
  if (required > accountCount || readonlySigned >= required || readonlyUnsigned > accountCount - required) {
    throw new TxError("the transaction's header doesn't fit its accounts");
  }

  const blockhash = base58(r.take(32));

  const ixCount = r.short();
  if (ixCount === 0 || ixCount > 16) throw new TxError("the transaction has an unexpected number of instructions");
  const instructions: Instruction[] = [];
  for (let i = 0; i < ixCount; i++) {
    const program = r.byte();
    if (program >= accountCount) throw new TxError("an instruction names an account that isn't there");
    const n = r.short();
    const idx: number[] = [];
    for (let j = 0; j < n; j++) {
      const a = r.byte();
      if (a >= accountCount) throw new TxError("an instruction names an account that isn't there");
      idx.push(a);
    }
    const len = r.short();
    instructions.push({ program, accounts: idx, data: r.take(len) });
  }
  if (r.at !== bytes.length) throw new TxError("there are extra bytes after the transaction");

  return {
    signatures, header: { required, readonlySigned, readonlyUnsigned },
    accounts, blockhash, instructions, message: bytes.slice(messageStart),
  };
}

/** Is account `i` a signer, and can the transaction change it? */
export function isSigner(tx: Transaction, i: number): boolean {
  return i < tx.header.required;
}
export function isWritable(tx: Transaction, i: number): boolean {
  const { required, readonlySigned, readonlyUnsigned } = tx.header;
  if (i < required) return i < required - readonlySigned;
  return i < tx.accounts.length - readonlyUnsigned;
}

/** The wire bytes again, with the signatures as they are now. */
export function writeTransaction(tx: Transaction): Uint8Array {
  const head = shortBytes(tx.signatures.length);
  const out = new Uint8Array(head.length + tx.signatures.length * 64 + tx.message.length);
  out.set(head, 0);
  tx.signatures.forEach((s, i) => out.set(s, head.length + i * 64));
  out.set(tx.message, head.length + tx.signatures.length * 64);
  return out;
}

/** Whether `sig` is `key`'s signature over the message. */
export async function verifySignature(key: string, sig: Uint8Array, message: Uint8Array): Promise<boolean> {
  const raw = keyOf(key);
  if (!raw || sig.length !== 64) return false;
  try {
    const pub = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, pub, sig, message);
  } catch {
    return false;
  }
}

/** Little-endian u64 at `at`, as a number (amounts here are far below 2^53). */
export function u64(data: Uint8Array, at: number): number {
  if (at + 8 > data.length) throw new TxError("an amount is cut short");
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[at + i]);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new TxError("an amount is impossibly large");
  return Number(v);
}

export const base64 = {
  encode: (b: Uint8Array) => btoa(String.fromCharCode(...b)),
  decode: (s: string): Uint8Array | null => {
    if (typeof s !== "string" || s.length > 2000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
    try { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); } catch { return null; }
  },
};

// ── building a transaction ──────────────────────────────────────────────────

/** Whether 32 bytes are a point on Ed25519. A program address must not be:
 *  nobody can hold its key. The standard decoding (RFC 8032, 5.1.3). */
const P = (1n << 255n) - 19n;
const D = (((-121665n * inverse(121666n)) % P) + P) % P;
const SQRT_M1 = pow(2n, (P - 1n) / 4n);
function pow(b: bigint, e: bigint): bigint {
  let r = 1n; b %= P;
  while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; }
  return r;
}
function inverse(a: bigint): bigint { return pow(((a % P) + P) % P, P - 2n); }

export function onCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  const sign = bytes[31] >> 7;
  if (y >= P) return false;
  const yy = (y * y) % P;
  const u = (yy - 1n + P) % P;
  const v = (D * yy + 1n) % P;
  // x = u v^3 (u v^7)^((p-5)/8), then check v x^2 = ±u.
  const v3 = (v * v % P) * v % P;
  const v7 = (v3 * v3 % P) * v % P;
  let x = (u * v3 % P) * pow(u * v7 % P, (P - 5n) / 8n) % P;
  const vxx = v * (x * x % P) % P;
  if (vxx !== u) {
    if (vxx === (P - u) % P) x = (x * SQRT_M1) % P;
    else return false;
  }
  if (x === 0n && sign === 1) return false;
  return true;
}

const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

/** Solana's findProgramAddress: the first bump, from 255 down, that lands
 *  off the curve. */
export async function programAddress(seeds: Uint8Array[], program: string): Promise<string> {
  const programKey = keyOf(program);
  if (!programKey) throw new TxError("not a program address");
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, Uint8Array.of(bump), programKey, PDA_MARKER];
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { all.set(p, at); at += p.length; }
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", all));
    if (!onCurve(hash)) return base58(hash);
  }
  throw new TxError("no program address");
}

/** The USDC (or any token's) account that belongs to `owner`. */
export async function tokenAccountOf(owner: string, mint: string, tokenProgram: string, ataProgram: string): Promise<string> {
  const o = keyOf(owner), m = keyOf(mint), t = keyOf(tokenProgram);
  if (!o || !m || !t) throw new TxError("not an address");
  return programAddress([o, t, m], ataProgram);
}

export interface Meta { key: string; signer: boolean; writable: boolean }
export interface PlannedInstruction { program: string; accounts: Meta[]; data: Uint8Array }

/**
 * A legacy transaction, unsigned, from instructions: the fee payer first,
 * then signers before others and writable before read-only, as Solana
 * requires. Every signature slot is left empty.
 */
export function compileTransaction(feePayer: string, blockhash: string, plan: PlannedInstruction[]): Uint8Array {
  const metas = new Map<string, Meta>();
  const add = (m: Meta) => {
    const had = metas.get(m.key);
    metas.set(m.key, had ? { key: m.key, signer: had.signer || m.signer, writable: had.writable || m.writable } : { ...m });
  };
  add({ key: feePayer, signer: true, writable: true });
  for (const ix of plan) { for (const a of ix.accounts) add(a); add({ key: ix.program, signer: false, writable: false }); }
  const all = [...metas.values()];
  const rank = (m: Meta) => (m.key === feePayer ? -1 : m.signer ? (m.writable ? 0 : 1) : (m.writable ? 2 : 3));
  const ordered = all.map((m, i) => ({ m, i })).sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i).map((x) => x.m);
  const index = new Map(ordered.map((m, i) => [m.key, i]));
  const required = ordered.filter((m) => m.signer).length;
  const readonlySigned = ordered.filter((m) => m.signer && !m.writable).length;
  const readonlyUnsigned = ordered.filter((m) => !m.signer && !m.writable).length;

  const bytes: number[] = [];
  const push = (b: ArrayLike<number>) => { for (let i = 0; i < b.length; i++) bytes.push(b[i]); };
  const key = (k: string) => { const raw = keyOf(k); if (!raw) throw new TxError(`not an address: ${k}`); return raw; };
  push([required, readonlySigned, readonlyUnsigned]);
  push(shortBytes(ordered.length));
  for (const m of ordered) push(key(m.key));
  push(key(blockhash));
  push(shortBytes(plan.length));
  for (const ix of plan) {
    bytes.push(index.get(ix.program)!);
    push(shortBytes(ix.accounts.length));
    for (const a of ix.accounts) bytes.push(index.get(a.key)!);
    push(shortBytes(ix.data.length));
    push(ix.data);
  }
  const message = Uint8Array.from(bytes);
  const head = shortBytes(required);
  const out = new Uint8Array(head.length + required * 64 + message.length);
  out.set(head, 0);
  out.set(message, head.length + required * 64);
  return out;
}

/** A little-endian u64. */
export function u64Bytes(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new TxError("not an amount");
  const out = new Uint8Array(8);
  let v = BigInt(n);
  for (let i = 0; i < 8; i++) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}
