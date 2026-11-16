import type { Product } from '../../_shared/shop.js';
import { listPrice, priceList, type Account, type Form } from '../model.js';

// DIVINE — secure reference: the form carries no price-related field at all, and whatever the client sends about
// prices is ignored. The server prices every line from its own catalog, on the price list of the signed-in customer's
// account, which lives in the session (pilgrim is on retail).
// ASVS 5.0 V2.3 (business logic integrity) and V8 (authorization: who may use a price tier).

export function formFields(_p: Product): Readonly<Record<string, string>> {
  return {};
}

export function unitPrice(p: Product, _form: Form, account: Account): number | string {
  const list = priceList(account.priceList);
  return list === undefined ? 'Unknown price list.' : listPrice(p, list);
}
