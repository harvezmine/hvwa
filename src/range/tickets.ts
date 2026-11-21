// src/range/tickets.ts — gate tickets (spec range §5.4): the one-time hop from the portal to an instance host. A ticket
// is 32 random bytes (base64url, 43 characters), valid ONCE and for 60 s, bound to (user, instance). Kept in the
// portal's memory under its SHA-256 only; deleted at its first presentation whatever happens next; a portal restart
// voids open tickets (the player clicks Open lab again). Bounded: at most `max` live tickets, the oldest dropped first.
import { createHash, randomBytes } from 'node:crypto';

export const TICKET_TTL_MS = 60_000;
export const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;
export interface TicketClaims { readonly userId: number; readonly instanceId: string }

export interface TicketStore {
  mint(userId: number, instanceId: string): string;
  /** The claims of a live ticket, which is spent by this call; undefined for anything else. */
  consume(ticket: unknown): TicketClaims | undefined;
  size(): number;
}

export function createTicketStore(opts: { now?: () => number; ttlMs?: number; max?: number } = {}): TicketStore {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? TICKET_TTL_MS;
  const max = opts.max ?? 10_000;
  const tickets = new Map<string, TicketClaims & { readonly expiresAt: number }>();
  const digest = (ticket: string) => createHash('sha256').update(ticket).digest('hex');
  return Object.freeze({
    mint(userId: number, instanceId: string): string {
      const t = now();
      for (const [k, v] of tickets) if (v.expiresAt <= t) tickets.delete(k);
      while (tickets.size >= max) {
        const oldest = tickets.keys().next().value;
        if (oldest === undefined) break;
        tickets.delete(oldest);
      }
      const ticket = randomBytes(32).toString('base64url');
      tickets.set(digest(ticket), { userId, instanceId, expiresAt: t + ttlMs });
      return ticket;
    },
    consume(ticket: unknown): TicketClaims | undefined {
      if (typeof ticket !== 'string' || !TICKET_RE.test(ticket)) return undefined;
      const key = digest(ticket);
      const claims = tickets.get(key);
      tickets.delete(key);
      if (!claims || claims.expiresAt <= now()) return undefined;
      return { userId: claims.userId, instanceId: claims.instanceId };
    },
    size: () => tickets.size,
  });
}
