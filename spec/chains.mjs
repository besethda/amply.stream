/**
 * Solana's fixed addresses, in one place: the artist's server (node/src), the
 * editor (manage/src/chain.js) and the listening app (app/src) all read them
 * from here. No imports, so the app's tiny networks.js can take it without
 * pulling anything else in.
 */

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

/**
 * Per network: where to ask, and which token is dollars there. Keyed as the
 * editor and app name them; a manifest says "solana" for mainnet.
 *
 * Mainnet is not api.mainnet-beta.solana.com, which refuses every request
 * from a website (and from a Cloudflare Worker). PublicNode is free, needs no
 * key and accepts both; it is a third party with no guarantee, so this is the
 * line to change if it stops. The editor's CSP (node/src/constants.ts) names
 * the same hosts.
 */
export const SOLANA = {
  mainnet: { rpc: "https://solana-rpc.publicnode.com", usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  devnet: { rpc: "https://api.devnet.solana.com", usdc: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" },
  // A second test cluster with its own faucet; only the app offers it.
  testnet: { rpc: "https://api.testnet.solana.com", usdc: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" },
};
