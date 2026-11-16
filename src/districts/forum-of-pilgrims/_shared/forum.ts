// src/districts/forum-of-pilgrims/_shared/forum.ts — plumbing the Forum of Pilgrims labs share: the forum's cast, its public
// thread list and the pilgrim sign-in. Not a challenge: nothing here is served by View Source, and the flaw of a lab
// (a redirect check, an ownership check, a query) never lives here: it stays in the lab's levels/*.ts.
import { field } from '../../../core/lab.js';
import type { Result } from '../../_shared/result.js';

export type { Result } from '../../_shared/result.js';
export { curlFor, type CurlView } from '../../_shared/curl.js';

/** The player's own forum account, shown on the lab page. */
export const PLAYER = Object.freeze({ username: 'pilgrim', password: 'pilgrim' });
/** The forum's moderator: the person every lab of this district is aimed at. */
export const ADMIN_NAME = 'citadel_admin';
/** A third forum member, the other end of the admin's private message. */
export const ARCHIVIST = 'archivist';

/** A public forum thread. */
export interface Thread { readonly id: number; readonly title: string; readonly author: string }

/** The forum's public thread list (the same in every lab and at every level: it is scenery, not state). */
export const THREADS: readonly Thread[] = Object.freeze([
  Object.freeze({ id: 1, title: 'Welcome to the Forum of Pilgrims', author: ADMIN_NAME }),
  Object.freeze({ id: 2, title: 'Where do the lanterns come from?', author: PLAYER.username }),
  Object.freeze({ id: 3, title: 'Reading the old scrolls: a beginner\'s guide', author: ARCHIVIST }),
]);

/** A thread by its numeric id, or undefined (compared, never used as an object key). */
export const threadById = (id: string): Thread | undefined => THREADS.find((t) => String(t.id) === id);

/** The player's credentials check, shared by the forum sign-in forms. Reads the username and password fields of anything with a body (an Express request or a simulated browser's). */
export function forumLogin(req: { readonly body?: unknown }): { readonly ok: boolean; readonly result: Result; readonly username: string; readonly password: string } {
  const username = field(req, 'username');
  const password = field(req, 'password');
  const ok = username === PLAYER.username && password === PLAYER.password;
  return {
    ok, username, password,
    result: ok ? { ok: true, text: `Signed in as ${PLAYER.username}.` } : { ok: false, text: 'Invalid username or password.' },
  };
}
