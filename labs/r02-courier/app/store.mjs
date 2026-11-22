// labs/r02-courier/app/store.mjs — Courier's in-memory data and sessions. The flaw is authorization, not authentication:
// a session is easy to get (demo mode); the question is which parcels it may read. From Inquisitor up, parcel routes
// also demand the owning customer's API key — and support hands keys out too freely. The per-level rule is `canRead`.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const MAX_SESSIONS = 256; // bounded: a lab, not an auth service; oldest sessions are evicted first

export function createStore(level, flag) {
  const parcels = JSON.parse(readFileSync(join(here, 'seed', 'parcels.json'), 'utf8'));
  const vaultParcel = parcels.find((p) => p.id === 1001);
  vaultParcel.note = level === 'divine' || !flag
    ? 'Divine is the secure reference: every parcel route checks ownership, so there is no note to steal here.'
    : flag;
  const sessions = new Map(); // token -> customerId
  // One API key per customer, minted at start. Never written to a page, a hint, a solve or a log.
  const customers = [...new Set(parcels.map((p) => p.owner))];
  const apiKeys = new Map(customers.map((customer) => [customer, randomBytes(24).toString('base64url')]));
  const keyOwnedBy = (customer, apiKey) => typeof apiKey === 'string' && apiKey.length > 0
    && apiKeys.get(customer) === apiKey;

  return {
    openDemoSession() {
      const token = randomBytes(18).toString('base64url');
      if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      sessions.set(token, 'demo');
      return token;
    },
    customerFor(token) { return token ? sessions.get(token) : undefined; },
    customerExists(customer) { return apiKeys.has(customer); },
    apiKeyFor(customer) { return apiKeys.get(customer); },
    parcel(id) { return parcels.find((p) => p.id === id); },
    parcelsOf(customer) { return parcels.filter((p) => p.owner === customer); },

    /**
     * May `customer` read `parcel` through route `kind` ('detail' | 'label' | 'events') with `apiKey`?
     * - acolyte:     always (no authorization at all; no key needed).
     * - templar:     'detail' requires ownership; 'label' and 'events' were NOT updated (the partial fix).
     * - inquisitor:  the owner's API key is required, but it need not belong to the session (the flaw).
     * - divine:      every route requires both the session owner and the key owner to be the parcel owner.
     */
    canRead(customer, parcel, kind, apiKey) {
      if (level === 'acolyte') return true;
      if (level === 'templar') return kind === 'detail' ? parcel.owner === customer : true;
      if (level === 'inquisitor') return keyOwnedBy(parcel.owner, apiKey);
      return parcel.owner === customer && keyOwnedBy(parcel.owner, apiKey); // divine
    },
  };
}
