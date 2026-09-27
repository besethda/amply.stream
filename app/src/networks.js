/**
 * Which chain the money is on.
 *
 * Its own file, with no imports, on purpose. The wallet needs the Solana
 * libraries and they are 344kB; deciding whether an artist can be paid here is
 * a string comparison, and every screen in the app needs to do it. Putting
 * this next to the wallet would pull the whole payment stack into the bundle
 * of somebody who is only listening.
 */

const NET = "amply.network.v1";

export const NETWORKS = {
  mainnet: {
    label: "Solana",
    // Not api.mainnet-beta.solana.com: Solana's public mainnet server answers
    // every request from a website with "403 Access forbidden" (devnet's does
    // not). PublicNode is free, needs no key and accepts browsers; it is a
    // third party with no guarantee, so this is the line to change if it stops.
    rpc: "https://solana-rpc.publicnode.com",
    usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    real: true,
  },
  devnet: {
    label: "Test network",
    rpc: "https://api.devnet.solana.com",
    usdc: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    real: false,
  },
  // A second test cluster with its own faucet. Here only because devnet's is
  // frequently dry, and proving the payment path needs one that answers. No
  // manifest can ask for it: the spec offers real money or devnet.
  testnet: {
    label: "Test network (testnet)",
    rpc: "https://api.testnet.solana.com",
    usdc: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    real: false,
  },
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
