import type { Currency } from '../../_shared/shop.js';
import type { Conversion, RateTable } from '../model.js';

// ACOLYTE — no defense: no minimum, and every credit is rounded to the NEAREST unit with Math.round, halves up. Crowns
// only come in whole units, so half a crown (50 cents) buys a whole one, and the rounding always favours the player.

export const RATES = {
  CRN: { unitsPerUsd: 1 },
  IDR: { unitsPerUsd: 16250 },
} satisfies RateTable;

export function convert(from: Currency, to: Currency, n: number): Conversion | string {
  const credit = ((): number => {
    if (from === 'USD' && to === 'CRN') return Math.round(n / 100);
    if (from === 'CRN' && to === 'USD') return n * 100;
    if (from === 'USD' && to === 'IDR') return Math.round(n * RATES.IDR.unitsPerUsd / 100);
    return Math.round(n * 100 / RATES.IDR.unitsPerUsd);
  })();
  return { debit: n, credit };
}
