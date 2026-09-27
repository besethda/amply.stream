// Types for pricing.mjs, so the artist's server can share the rule with the app.
export interface Plan { months: number; price: number; currency?: string; url: string }
export const SETTLE_WITHIN_DAYS: number;
export function perMinute(manifest: unknown): boolean;
export function plans(manifest: unknown): Plan[];
export function charges(manifest: unknown): boolean;
export function subscriptionOnly(manifest: unknown): boolean;
export function needsWallet(
  manifest: unknown,
  track: { free?: boolean; needsWallet?: boolean } | null | undefined,
): boolean;
export const DOWNLOADS_PER_PURCHASE: number;
export interface Recipient { address: string; split?: number; name?: string }
export interface WalletPay { recipients: Recipient[]; network: string }
export interface Sale { price: number; card: string | null; wallet: WalletPay | null }
export interface ForSale extends Sale { id: string; kind: "album" | "song"; title: string; tracks: string[] }
export function walletOf(manifest: unknown): WalletPay | null;
export function saleOf(manifest: unknown, item: unknown): Sale | null;
export function forSale(manifest: unknown): ForSale[];
export function includes(manifest: unknown, trackId: string): string[];
