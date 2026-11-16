import type { Channel, OrdersLevel, PlacedOrder } from '../model.js';

// INQUISITOR — random ids and a real ownership check on both single-order doors (the order page with its Find form,
// and the JSON API). The flaws: the batch door checks only the FIRST id of the list and then serves all of them, and
// the "recently shipped" feed prints every order's id, Sister Maren's included.
export const idStyle: OrdersLevel['idStyle'] = 'random';
export const feedShowsIds = true;
export const uniformNotFound = false;

export function canRead(viewerId: string, order: PlacedOrder, _channel: Channel): boolean {
  return order.owner === viewerId;
}

export function authorizeBatch(viewerId: string, orders: readonly (PlacedOrder | undefined)[]): readonly PlacedOrder[] | 'deny' {
  return orders[0]?.owner === viewerId ? orders.filter((o): o is PlacedOrder => o !== undefined) : 'deny';
}
