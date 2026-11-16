import { createHash } from 'node:crypto';
import { field } from '../../../../core/lab.js';
import type { Product } from '../../_shared/shop.js';
import type { Form } from '../model.js';

// TEMPLAR — naive integrity check: the hidden price travels with a checksum, sha256("<sku>:<price>"), and a mismatch
// is refused. But the checksum has no secret in it: anyone can compute it for any price.

const sha256hex = (text: string): string => createHash('sha256').update(text).digest('hex');

export function formFields(p: Product): Readonly<Record<string, string>> {
  const price = String(p.price);
  return { price, sig: sha256hex(`${p.sku}:${price}`) };
}

export function unitPrice(p: Product, form: Form): number | string {
  const raw = field(form, 'price');
  if (field(form, 'sig') !== sha256hex(`${p.sku}:${raw}`)) return 'Tampering detected: the price checksum does not match.';
  const price = Number.parseInt(raw, 10);
  return Number.isSafeInteger(price) ? price : 'Invalid price.';
}
