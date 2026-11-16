import { formatMoney, type Currency } from '../../_shared/shop.js';
import type { Conversion, RateTable } from '../model.js';

// INQUISITOR — a real fix for amounts: the same minimums, and every credit rounds DOWN, so no amount can gain from
// rounding. The flaw is in the RATE. The table publishes two columns per currency: how many units one dollar buys
// (unitsPerUsd), used to sell units, and how many 1/10 000 USD one unit is worth (usdPerUnitE4), used to buy dollars
// back. For rupiah they are not inverses: 16,250 IDR to the dollar is 0.0000615 USD each, but the second column keeps
// 0.0001 to four decimals, so a round trip through rupiah gains 62.5%.

export const RATES = {
  CRN: { unitsPerUsd: 1, usdPerUnitE4: 10000 },
  IDR: { unitsPerUsd: 16250, usdPerUnitE4: 1 },
} satisfies RateTable;

const MINIMUM: Readonly<Record<Currency, number>> = { USD: 100, CRN: 1, IDR: 16250 };

export function convert(from: Currency, to: Currency, n: number): Conversion | string {
  if (n < MINIMUM[from]) return `Minimum exchange is ${formatMoney(MINIMUM[from], from)}.`;
  const credit = ((): number => {
    if (from === 'USD') return Math.floor(n * RATES[to === 'CRN' ? 'CRN' : 'IDR'].unitsPerUsd / 100);
    return Math.floor(n * RATES[from === 'CRN' ? 'CRN' : 'IDR'].usdPerUnitE4 * 100 / 10000);
  })();
  return { debit: n, credit };
}
