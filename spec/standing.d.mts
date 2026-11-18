// Types for standing.mjs, so the artist's server shares the rules with the editor.
export interface StandingRow {
  seconds?: number;
  owed_micros?: number | null;
  owed_seconds?: number | null;
  last_seen?: number;
}
export const DAY: number;
export function owedOf(row: StandingRow | null | undefined, ratePerMinute: number): number;
export function behind(owedMicros: number, paidMicros: number, settleAt: unknown): boolean;
export function overdue(owedMicros: number, paidMicros: number, lastSeen: unknown, now?: number): boolean;
export function unpaidOf(owedMicros: number, paidMicros: number): number;
export function autoBlock(
  row: StandingRow | null | undefined,
  paidMicros: number,
  options?: { ratePerMinute?: number; settleAt?: unknown; subscribed?: boolean; now?: number },
): { blocked: boolean; owes: number };
