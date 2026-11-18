/**
 * Which chain the money is on.
 *
 * Its own file, importing only spec/chains.mjs (plain strings), on purpose.
 * The wallet needs the Solana libraries and they are 344kB; deciding whether
 * an artist can be paid here is a string comparison, and every screen in the
 * app needs to do it. Putting this next to the wallet would pull the whole
 * payment stack into the bundle of somebody who is only listening.
 */
import { SOLANA } from "../../spec/chains.mjs";

const NET = "amply.network.v1";

// Where to ask, and which token is dollars: spec/chains.mjs, shared with the
// artist's server and editor.
export const NETWORKS = {
  mainnet: { label: "Solana", ...SOLANA.mainnet, real: true },
  devnet: { label: "Test network", ...SOLANA.devnet, real: false },
  // A second test cluster with its own faucet. Here only because devnet's is
  // frequently dry, and proving the payment path needs one that answers. No
  // manifest can ask for it: the spec offers real money or devnet.
  testnet: { label: "Test network (testnet)", ...SOLANA.testnet, real: false },
};

/**
 * What a manifest's `network` means here.
 *
 * The spec says "solana" for the real chain, because that is what an artist is
 * agreeing to be paid on; this app says "mainnet" internally. One map, in one
 * place, rather than two vocabularies drifting apart.
 */
const FROM_SPEC = { solana: "mainnet", devnet: "devnet" };

/** The network an artist asked to be paid on, in this app's terms. Absent
 *  means real money — see rateOf in manifest.js. */
export const networkFor = (declared) => FROM_SPEC[declared || "solana"] || null;

/**
 * Where this device's money is.
 *
 * Real money by default. Defaulting to the test network would let a listener
 * send an artist tokens worth nothing, with both ends believing they had been
 * paid.
 */
export const networkName = () => {
  try {
    const kept = localStorage.getItem(NET);
    return NETWORKS[kept] ? kept : "mainnet";
  } catch { return "mainnet"; }
};

export const network = () => NETWORKS[networkName()];

export function useNetwork(name) {
  if (!NETWORKS[name]) throw new Error(`No such network: ${name}`);
  try { localStorage.setItem(NET, name); } catch { /* nothing to do */ }
}

/**
 * Do this artist and this wallet mean the same money?
 *
 * A Solana address is valid on every network, so nothing about a payment
 * itself reveals a mismatch: the transfer succeeds, tokens move, and an artist
 * on the real chain has been paid in something nobody can spend. Both ends
 * would believe it worked. So the two have to agree before anything is owed
 * or sent.
 */
export function payableHere(rate, mine = networkName()) {
  if (!rate) return false;
  return networkFor(rate.network) === mine;
}
