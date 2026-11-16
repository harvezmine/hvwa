import { field } from '../../../../core/lab.js';
import type { Product } from '../../_shared/shop.js';
import type { Form } from '../model.js';

// ACOLYTE — no defense: the price travels in a hidden form field, and the server charges whatever it says.

export function formFields(p: Product): Readonly<Record<string, string>> {
  return { price: String(p.price) };
}

export function unitPrice(_p: Product, form: Form): number | string {
  const price = Number.parseInt(field(form, 'price'), 10);
  return Number.isSafeInteger(price) ? price : 'Invalid price.';
}
