// Types for chains.mjs, so the artist's server shares Solana's addresses with the editor and app.
export const TOKEN_PROGRAM: string;
export const ATA_PROGRAM: string;
export const SYSTEM_PROGRAM: string;
export const MEMO_PROGRAM: string;
export interface Network { rpc: string; usdc: string }
export const SOLANA: { mainnet: Network; devnet: Network; testnet: Network };
