import type { Identity, LabState } from '../model.js';

// TEMPLAR — naive obfuscation. The cookie is base64(JSON { user, role }): it looks opaque, but
// base64 is an encoding, not a signature, and nothing checks that the server wrote it.
export const httpOnly = false;
export function issue(_state: LabState, who: Identity): string {
  return Buffer.from(JSON.stringify({ user: who.user, role: who.role })).toString('base64url');
}
export function read(_state: LabState, cookie: unknown): Identity | undefined {
  if (typeof cookie !== 'string' || cookie === '' || cookie.length > 2000) return undefined;
  try {
    const body: unknown = JSON.parse(Buffer.from(cookie, 'base64url').toString('utf8'));
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
    const { user, role } = body as Record<string, unknown>;
    return typeof user === 'string' && typeof role === 'string' ? { user, role } : undefined;
  } catch {
    return undefined;
  }
}
