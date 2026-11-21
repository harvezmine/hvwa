// labs/r02-courier/app/store.mjs — Courier's in-memory data and sessions. The flaw is authorization, not authentication:
// a session is easy to get (demo mode); the question is which parcels it may read. The per-level rule is `canRead`.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export function createStore(level, flag) {
  const parcels = JSON.parse(readFileSync(join(here, 'seed', 'parcels.json'), 'utf8'));
  const vaultParcel = parcels.find((p) => p.id === 1001);
  vaultParcel.note = level === 'divine' || !flag
    ? 'Divine is the secure reference: every parcel route checks ownership, so there is no note to steal here.'
    : flag;
  const sessions = new Map(); // token -> customerId

  return {
    openDemoSession() { const token = randomBytes(18).toString('base64url'); sessions.set(token, 'demo'); return token; },
    customerFor(token) { return token ? sessions.get(token) : undefined; },
    parcel(id) { return parcels.find((p) => p.id === id); },
    parcelsOf(customer) { return parcels.filter((p) => p.owner === customer); },

    /**
     * May `customer` read `parcel` through route `kind` ('detail' | 'label' | 'events')?
     * - acolyte: always (no authorization at all).
     * - templar: 'detail' requires ownership; 'label' and 'events' were NOT updated (the partial fix).
     * - divine:  every route requires ownership.
     */
    canRead(customer, parcel, kind) {
      if (level === 'acolyte') return true;
      if (level === 'templar') return kind === 'detail' ? parcel.owner === customer : true;
      return parcel.owner === customer; // divine
    },
  };
}
