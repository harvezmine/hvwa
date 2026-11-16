import type { Channel, OrdersLevel, PlacedOrder } from '../model.js';

// ACOLYTE — no defense. Sequential order numbers (yours are 1001 and 1003) and no ownership check on any door: the
// single order page, the Find form, the JSON API and the batch API all serve whatever order they are asked for.
export const idStyle: OrdersLevel['idStyle'] = 'number';
export function feedId(order: PlacedOrder): string {
  return order.no;
}
export const uniformNotFound = false;

export function canRead(_viewerId: string, _order: PlacedOrder, _channel: Channel): boolean {
  return true;
}

export function authorizeBatch(_viewerId: string, orders: readonly (PlacedOrder | undefined)[]): readonly PlacedOrder[] | 'deny' {
  return orders.filter((o): o is PlacedOrder => o !== undefined);
}
