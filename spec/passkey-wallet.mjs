/**
 * A wallet that comes from a passkey.
 *
 * A passkey is what a phone or computer already uses for "sign in with Face
 * ID": it lives in iCloud Keychain, Google Password Manager, Windows Hello or
 * a security key, and syncs across the person's own devices. The browser's
 * PRF extension lets a page ask a passkey for a secret: the same 32 bytes
 * every time, for the same passkey and the same label. Those bytes become the
 * wallet's key.
 *
 * So nothing is stored anywhere. The same passkey on any of the person's
 * devices makes the same wallet again, there are no recovery words, and no
 * server takes part: making the passkey is not signing in to anything, so
 * no challenge needs checking. A computer without a passkey of its own uses
 * the person's phone instead: the browser offers "use a phone" and shows a
 * QR code, and the phone's passkey answers.
 *
 * Losing the passkey loses the wallet, which is why it is synced and why a
 * backup code can still be shown. Where a browser or authenticator can't
 * answer a PRF request (Windows Hello is uneven; Firefox on Android can't),
 * NoPasskeySecret is thrown and the caller offers a backup-code wallet.
 *
 * A passkey belongs to the site that made it: amply.stream for listeners, the
 * artist's own node for an artist. Moving to another address would orphan it.
 *
 * Zero dependencies, shared by the listener app and the artist's editor.
 */

/** The label the passkey's secret is asked for. Changing it changes every wallet. */
export const WALLET_LABEL = "amply-wallet-v1";
const SEED_INFO = "amply solana wallet seed v1";

export class NoPasskeySecret extends Error {
  constructor(message = "This device's passkey can't make a wallet.") {
    super(message);
    this.name = "NoPasskeySecret";
  }
}

const enc = new TextEncoder();
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const labelSalt = async () => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(WALLET_LABEL)));

/**
 * Whether to offer a passkey wallet at all. True unless the browser says
 * plainly that it can't do PRF; most browsers don't say, so the real answer
 * comes when the passkey is made.
 */
export async function mayOfferPasskey() {
  if (typeof window === "undefined" || !window.PublicKeyCredential || !navigator.credentials) return false;
  try {
    const caps = await PublicKeyCredential.getClientCapabilities?.();
    if (caps && caps["extension:prf"] === false) return false;
  } catch { /* not answered: try it */ }
  return true;
}

/** The PRF secret from an existing passkey: one the person picks, or `ids`. */
async function askSecret(salt, ids = null) {
  let got;
  try {
    got = await navigator.credentials.get({
      publicKey: {
        challenge: random(32),
        userVerification: "required",
        ...(ids ? { allowCredentials: ids.map((id) => ({ type: "public-key", id })) } : {}),
        extensions: { prf: { eval: { first: salt } } },
      },
    });
  } catch (e) {
    throw cancelled(e);
  }
  const first = got?.getClientExtensionResults?.().prf?.results?.first;
  if (!first) throw new NoPasskeySecret();
  return new Uint8Array(first);
}

/** A person closing the dialog is not an error to report as one. */
function cancelled(e) {
  if (e?.name === "NotAllowedError" || e?.name === "AbortError") {
    const out = new Error("Cancelled. Nothing was set up.");
    out.name = "Cancelled";
    return out;
  }
  return e;
}

/**
 * Make a new passkey and the wallet seed that comes from it. Some devices
 * return the secret while making the passkey; the rest need a second
 * confirmation straight after.
 */
export async function createPasskeySeed({ name = "Amply wallet", rpName = "Amply" } = {}) {
  const salt = await labelSalt();
  let cred;
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        rp: { name: rpName },
        // No email, no real name: the person's keychain shows "Amply wallet".
        user: { id: random(16), name, displayName: name },
        challenge: random(32),
        pubKeyCredParams: [
          { type: "public-key", alg: -8 },   // Ed25519
          { type: "public-key", alg: -7 },   // ES256
          { type: "public-key", alg: -257 }, // RS256
        ],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        extensions: { prf: { eval: { first: salt } } },
      },
    });
  } catch (e) {
    throw cancelled(e);
  }
  const ext = cred?.getClientExtensionResults?.() || {};
  if (ext.prf?.enabled === false) throw new NoPasskeySecret();
  const first = ext.prf?.results?.first ? new Uint8Array(ext.prf.results.first) : await askSecret(salt, [cred.rawId]);
  return seedFrom(first);
}

/** The wallet seed from a passkey the person already has, on this device or their phone. */
export async function restorePasskeySeed() {
  return seedFrom(await askSecret(await labelSalt()));
}

/**
 * The 32-byte Ed25519 seed. The passkey's secret already looks random; HKDF
 * names what it is for, so the same passkey could serve something else later
 * without the two ever being the same key.
 */
export async function seedFrom(secret) {
  if (!(secret instanceof Uint8Array) || secret.length < 32) throw new NoPasskeySecret();
  const key = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(SEED_INFO) }, key, 256);
  return new Uint8Array(bits);
}

const ED25519_PKCS8 = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];

/** The public key for a seed, through WebCrypto (no Solana library needed). */
export async function publicKeyOf(seed) {
  const pkcs8 = new Uint8Array(ED25519_PKCS8.length + 32);
  pkcs8.set(ED25519_PKCS8);
  pkcs8.set(seed, ED25519_PKCS8.length);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  const { x } = await crypto.subtle.exportKey("jwk", key);
  return Uint8Array.from(atob(x.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (x.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [];
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

/** The Solana address a seed pays into. */
export async function addressOf(seed) {
  return base58(await publicKeyOf(seed));
}
