// _shared/lab.ts — plumbing shared by the Gatekeeper labs (login-style labs with citadel_admin and pilgrim).
// Not a challenge: nothing here is served by View Source. Limiter and lockout LOGIC stays in each
// challenge's levels/*.ts, where the flaw (and its Diff) must be visible.
import type { Request } from 'express';
import { flagFor } from '../../../core/mount.js';
import type { Challenge } from '../../../core/registry.js';

/** The lab's message: ok selects the success/error style. */
export interface Result { readonly ok: boolean; readonly text: string }

export interface Account { readonly username: string; readonly password: string; readonly role: 'admin' | 'user' }

/** Failed-attempt bookkeeping for one lockout key. */
export interface Counter { failures: number; lockedUntil: number }

/** The player's own (unprivileged) account, shown on the lab page. */
export const PLAYER = Object.freeze({ username: 'pilgrim', password: 'pilgrim' });
export const ADMIN_NAME = 'citadel_admin';

/** Both accounts of a login lab, the admin with the given password. */
export function accountsFor(adminPassword: string): readonly Account[] {
  return [
    { username: ADMIN_NAME, password: adminPassword, role: 'admin' },
    { username: PLAYER.username, password: PLAYER.password, role: 'user' },
  ];
}

/**
 * The message for someone who is signed in: only the admin holds the flag, and Divine never issues one.
 * Call it OUTSIDE tryDb (flagFor throws at Divine by design).
 */
export function welcome(
  req: Pick<Request, 'sessionId' | 'level'>, challenge: Pick<Challenge, 'id' | 'levels'>,
  who: { readonly username: string; readonly role: string },
): Result {
  const hello = `Welcome, ${who.username} (role: ${who.role}).`;
  if (who.role !== 'admin') return { ok: true, text: `${hello} Only the citadel admin holds the flag.` };
  if (req.level === 'divine') return { ok: true, text: hello };
  return { ok: true, text: `${hello} Flag: ${flagFor(req, challenge)}` };
}
