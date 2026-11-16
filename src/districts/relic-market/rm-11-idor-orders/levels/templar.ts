import type { Channel, OrdersLevel, PlacedOrder } from '../model.js';

// TEMPLAR — security by obscurity. The ids are base64url-encoded ("nobody can guess them"), but encoding is not
// secrecy: it decodes to the same sequential number, and there is still no ownership check on any door.
export const idStyle: OrdersLevel['idStyle'] = 'base64url';
export const feedShowsIds = true;
export const uniformNotFound = false;

export function canRead(_viewerId: string, _order: PlacedOrder, _channel: Channel): boolean {
  return true;
}

export function authorizeBatch(_viewerId: string, orders: readonly (PlacedOrder | undefined)[]): readonly PlacedOrder[] | 'deny' {
  return orders.filter((o): o is PlacedOrder => o !== undefined);
}
