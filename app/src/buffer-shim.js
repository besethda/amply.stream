/**
 * Buffer, for the Solana libraries.
 *
 * They were written for Node and use Buffer throughout, which browsers do not
 * have. wallet.js and pay.js import this first, so `Buffer` resolves to the
 * polyfill rather than to a global that isn't there. Without it the wallet
 * loads and then fails at the first transaction.
 *
 * Those modules load only when a listener sets up a wallet, so nobody who is
 * just listening pays for this.
 */
import { Buffer } from "buffer";

// Some of the library's own code looks for the global rather than importing it.
if (typeof globalThis.Buffer === "undefined") globalThis.Buffer = Buffer;

export { Buffer };
