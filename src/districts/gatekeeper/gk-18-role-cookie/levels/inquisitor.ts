import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Identity, LabState } from '../model.js';

// INQUISITOR — a real signature, over the wrong thing. The cookie is base64(JSON { user, role })
// plus an HMAC-SHA256 made with a server secret, checked in constant time. But the HMAC covers
// only `user`, so the payload's `role` can be changed without breaking the signature.
export const httpOnly = false;
const secret = randomBytes(32); // this level's signing key; never leaves the server, never shared with other levels

const sign = (user: string): string => createHmac('sha256', secret).update(user).digest('hex');

export function issue(_state: LabState, who: Identity): string {
  const payload = Buffer.from(JSON.stringify({ user: who.user, role: who.role })).toString('base64url');
  return `${payload}.${sign(who.user)}`; // the signature does not cover the role
}

export function read(_state: LabState, cookie: unknown): Identity | undefined {
  if (typeof cookie !== 'string' || cookie.length > 2000) return undefined;
  const parts = cookie.split('.');
  if (parts.length !== 2) return undefined;
  try {
    const body: unknown = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
    const { user, role } = body as Record<string, unknown>;
    if (typeof user !== 'string' || typeof role !== 'string') return undefined;
    const given = Buffer.from(parts[1], 'utf8');
    const expected = Buffer.from(sign(user), 'utf8');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    return { user, role }; // the role comes from the client-held payload
  } catch {
    return undefined;
  }
}
