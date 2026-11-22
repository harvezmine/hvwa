// src/range/user.ts — the signed-in range user, shared by the range's routers (catalog, lab actions, teams).
import type { Request, Response } from 'express';

export interface RangeUser { readonly userId: number; readonly username: string; readonly role: 'player' | 'admin' }

/** The signed-in user (the login gate runs before every range route). */
export function userOf(res: Response): RangeUser {
  const a = res.locals.platformAuth;
  if (!a?.signedIn || a.userId === undefined || a.user === undefined) throw new Error('range: no signed-in user (is the login gate mounted?)');
  return { userId: a.userId, username: a.user, role: a.role === 'admin' ? 'admin' : 'player' };
}

export const isHtmx = (req: Request) => req.get('HX-Request') === 'true';
