import { formatMoney, type Currency } from '../../_shared/shop.js';
import type { Conversion, RateTable } from '../model.js';

// DIVINE — secure reference: ONE exact rational per pair, published as units per cent (crowns 1/100, rupiah
// 325/2 = 162.5), used in both directions: USD to X is floor(n x num / den) and X to USD is floor(n x den / num). The
// same minimums; a zero credit is refused; every credit rounds toward the house and the whole debit is taken, so no
// sequence of exchanges can raise the exact net worth (the spec runs a property test over 200 random exchanges).
// ASVS 5.0 V2.3 (financial calculations: one rate, integer arithmetic, a defined rounding rule).
// Out of scope here: a real changer also charges a spread, caps what one customer may trade and watches for fraud.

export const RATES = {
  CRN: { num: 1, den: 100 },
  IDR: { num: 325, den: 2 },
} satisfies RateTable;

const MINIMUM: Readonly<Record<Currency, number>> = { USD: 100, CRN: 1, IDR: 16250 };

/** floor(a / b) for non-negative safe integers, exact (no float division). */
const floorDiv = (a: number, b: number): number => (a - (a % b)) / b;

export function convert(from: Currency, to: Currency, n: number): Conversion | string {
  const { num, den } = RATES[from === 'USD' ? (to === 'CRN' ? 'CRN' : 'IDR') : (from === 'CRN' ? 'CRN' : 'IDR')];
  const credit = from === 'USD' ? floorDiv(n * num, den) : floorDiv(n * den, num);
  if (credit < 1) return 'Amount too small to exchange.';
  if (n < MINIMUM[from]) return `Minimum exchange is ${formatMoney(MINIMUM[from], from)}.`;
  return { debit: n, credit };
}
