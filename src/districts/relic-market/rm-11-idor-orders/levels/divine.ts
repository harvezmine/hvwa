import type { Channel, OrdersLevel, PlacedOrder } from '../model.js';

// DIVINE — secure reference: random ids, a feed that prints no ids, and object-level authorization on every door.
// Ownership comes from the session only (never from a header or a field), every id of a batch must be the viewer's
// own, and a refusal is answered exactly like a missing order (uniform 404 "Order not found.": no oracle for ids that
// exist, whether asked one at a time or in a batch).
// ASVS 5.0 V8.2 (object-level authorization).
// Out of scope here: a production system would also log denied lookups and rate limit them.
export const idStyle: OrdersLevel['idStyle'] = 'random';
export const feedShowsIds = false;
export const uniformNotFound = true;

export function canRead(viewerId: string, order: PlacedOrder, _channel: Channel): boolean {
  return order.owner === viewerId;
}

export function authorizeBatch(viewerId: string, orders: readonly (PlacedOrder | undefined)[]): readonly PlacedOrder[] | 'deny' {
  const owned: PlacedOrder[] = [];
  for (const o of orders) {
    if (o === undefined || o.owner !== viewerId) return 'deny';
    owned.push(o);
  }
  return owned;
}
