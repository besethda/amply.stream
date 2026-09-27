/**
 * Money, as a unit.
 *
 * Its own module with no dependencies, so the spending rules can use it
 * without pulling in pay.js, and with it the whole Solana library.
 *
 * A micro is a millionth of a dollar, which is what USDC counts in. Money is
 * held as whole micros everywhere it is stored or divided; floats appear only
 * at the edges, for display and for reading a rate out of a manifest.
 */
export const MICROS = 1e6;
export const toMicros = (usd) => Math.round(usd * MICROS);
export const toUsd = (micros) => micros / MICROS;
