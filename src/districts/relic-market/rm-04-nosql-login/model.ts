// model.ts — RM-04's staff store and the contract every levels/<level>.ts implements.
// Not served: View Source shows only levels/*.ts, and nothing here has a route.
import { randomBytes } from 'node:crypto';
import { perLevel } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import { createStore, type Doc, type DocStore } from './docstore.js';

/** What every levels/<level>.ts exports (checked by byLevel<LoginLevel> in challenge.ts). */
export interface LoginLevel {
  /** The signed-in account, null for wrong credentials, or a refusal message. Store errors are thrown (tryDb, label "Query error"). */
  login(store: DocStore, body: unknown): Doc | null | string;
}

/** A body field exactly as it arrived (a string, or whatever JSON or extended-urlencoded nesting made of it); undefined when absent. */
export function raw(body: unknown, name: string): unknown {
  if (body === null || typeof body !== 'object' || !Object.hasOwn(body, name)) return undefined;
  return Object.getOwnPropertyDescriptor(body, name)?.value;
}

/** The player's own account, shown on the page. */
export const PLAYER = Object.freeze({ username: 'pilgrim', password: 'pilgrim' });

// One staff store per level, each with its own random admin password: a password read out at Acolyte must not sign in at
// Templar, Inquisitor or Divine. Read-only: a query cannot change a document. The admin is FIRST (insertion order), so a
// condition that matches everyone returns the admin.
const stores = perLevel(() => {
  const password = randomBytes(8).toString('hex');
  const store = createStore([
    { username: 'relic_admin', username_lc: 'relic_admin', password, role: 'admin' },
    { username: PLAYER.username, username_lc: PLAYER.username, password: PLAYER.password, role: 'customer' },
    { username: 'Brother_Tobias', username_lc: 'brother_tobias', password: randomBytes(8).toString('hex'), role: 'staff' },
  ]);
  return { store, password };
});

/** The staff store serving `level` (test seam too). */
export function staffStore(level: Level): DocStore {
  return stores.for(level).store;
}

/** Test seam: the real relic_admin password at `level`. */
export function adminPassword(level: Level): string {
  return stores.for(level).password;
}
