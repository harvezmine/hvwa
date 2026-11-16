import type { Channel, OrdersLevel, PlacedOrder } from '../model.js';

// TEMPLAR — security by obscurity. The ids are base64url-encoded ("nobody can guess them"), but encoding is not
// secrecy: it decodes to the same sequential number, and there is still no ownership check on any door. The activity
// feed names orders by that plain number, so a player has to encode it to build a door URL.
export const idStyle: OrdersLevel['idStyle'] = 'base64url';
export function feedId(order: PlacedOrder): string {
  return `#${order.seq}`; // the plain number: the player encodes it themselves
}
export const uniformNotFound = false;

export function canRead(_viewerId: string, _order: PlacedOrder, _channel: Channel): boolean {
  return true;
}

export function authorizeBatch(_viewerId: string, orders: readonly (PlacedOrder | undefined)[]): readonly PlacedOrder[] | 'deny' {
  return orders.filter((o): o is PlacedOrder => o !== undefined);
}
