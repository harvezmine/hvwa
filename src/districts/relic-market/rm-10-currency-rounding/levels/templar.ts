import { formatMoney, type Currency } from '../../_shared/shop.js';
import type { Conversion, RateTable } from '../model.js';

// TEMPLAR — naive minimum: $1.00, 1 crown or 16,250 rupiah, whichever you give. It stops the tiny exchange, but the
// credit is still rounded to the NEAREST unit with Math.round, so $1.50 still buys 2 crowns.

export const RATES = {
  CRN: { unitsPerUsd: 1 },
  IDR: { unitsPerUsd: 16250 },
} satisfies RateTable;

const MINIMUM: Readonly<Record<Currency, number>> = { USD: 100, CRN: 1, IDR: 16250 };

export function convert(from: Currency, to: Currency, n: number): Conversion | string {
  if (n < MINIMUM[from]) return `Minimum exchange is ${formatMoney(MINIMUM[from], from)}.`;
  const credit = ((): number => {
    if (from === 'USD' && to === 'CRN') return Math.round(n / 100);
    if (from === 'CRN' && to === 'USD') return n * 100;
    if (from === 'USD' && to === 'IDR') return Math.round(n * RATES.IDR.unitsPerUsd / 100);
    return Math.round(n * 100 / RATES.IDR.unitsPerUsd);
  })();
  return { debit: n, credit };
}
