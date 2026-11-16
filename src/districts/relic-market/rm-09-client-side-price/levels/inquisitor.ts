import { field } from '../../../../core/lab.js';
import type { Product } from '../../_shared/shop.js';
import { listPrice, priceList, type Form } from '../model.js';

// INQUISITOR — real defense for the price: the client's price and checksum are ignored, and the server computes the
// price from its own catalog. But the form still says which price list to use (hidden price_list=retail), and the
// server prices from whichever list the client names. Nothing checks that this customer may use it.

export function formFields(_p: Product): Readonly<Record<string, string>> {
  return { price_list: 'retail' };
}

export function unitPrice(p: Product, form: Form): number | string {
  const list = priceList(field(form, 'price_list') || 'retail');
  return list === undefined ? 'Unknown price list.' : listPrice(p, list);
}
