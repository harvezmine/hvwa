// src/districts/_shared/xss-lab.ts — plumbing the server-sink XSS labs share, any district (SC-01, SC-02, SC-04, FP-05;
// docs/RECIPES.md section 13): the admin's simulated browser signed in with a session key, the player's marker, the
// re-arm step, a sign-out page, and the proof (sign in with the key your server received). Plumbing only: the fragment
// each level builds, escaping it or not, stays in the lab's levels/*.ts, where View Source and the Diff show it.
import type { Request } from 'express';
import type { Level } from '../../core/levels.js';
import { flagFor } from '../../core/mount.js';
import { simWorld, type SimBrowser, type SimHandler, type SimResponse, type SimWorld, type VictimRearm } from '../../core/sim.js';
import { XSS_STEAL_URL, newMarker, xssBrowser, type XssBrowser, type XssMarker } from '../../core/xss.js';
import { newId } from './collections.js';
import type { Result } from './result.js';

/** The victim side of one player's XSS lab at one level. */
export interface XssVictim {
  /** The attacker log, the victim's visits and the clock. */
  readonly world: SimWorld;
  /** The player's marker at this level: only a payload that calls it counts. */
  readonly marker: XssMarker;
  /** The admin's session key: what a payload that runs steals, and what signs the player in as the admin. */
  readonly key: string;
  /** The admin's browser: every page it renders goes through the XSS oracle. */
  readonly admin: XssBrowser;
}

/**
 * Inside the lab's perSession factory: a world, a fresh marker, the admin's session key, and the admin's XSS browser,
 * already signed in (cookie `cookie` = key). A payload that runs steals whatever that cookie holds at that moment (read
 * after the page's own Set-Cookie: a signed-out admin has nothing to steal). `handler` answers the citadel.
 */
export function xssVictim(cookie: string, handler: SimHandler): XssVictim {
  const world = simWorld();
  const marker = newMarker();
  const key = newId();
  const v: XssVictim = { world, marker, key, admin: xssBrowser(world, handler, { marker: marker.call, canary: () => v.admin.cookies.get(cookie) ?? '' }) };
  v.admin.cookies.set(cookie, key);
  return v;
}

/** The re-arm step every victim action starts with: the admin is signed in again, whatever the player's last link did. */
export function rearmVictim(cookie: string, victimFor: (req: Request) => XssVictim): VictimRearm {
  return (req: Request, browser: SimBrowser): void => { browser.cookies.set(cookie, victimFor(req).key); };
}

/** The citadel's /logout: the admin's session cookie cleared (a link the player can send; re-arm undoes it). */
export function signOutPage(cookie: string): SimResponse {
  return { status: 200, headers: { 'Set-Cookie': `${cookie}=; Max-Age=0; Path=/` }, body: '<!DOCTYPE html><p>Signed out.</p>' };
}

/** The answer to a wrong or empty session key (what Divine answers every exploit with). */
export const WRONG_KEY = 'Wrong session key.';

/**
 * The proof: sign in with a session key. The admin's key below Divine shows the flag (the payload ran in the admin's
 * browser and sent the key to the player's server); at Divine it signs in with no flag (Divine never issues one).
 */
export function keySignIn(
  req: Pick<Request, 'sessionId' | 'level'>, challenge: { readonly id: string; readonly levels: readonly Level[] },
  typed: string, victim: XssVictim, who: string,
): Result {
  if (typed === '' || typed !== victim.key) return { ok: false, text: WRONG_KEY };
  return { ok: true, text: req.level === 'divine' ? `Signed in as ${who}.` : `Signed in as ${who}. Flag: ${flagFor(req, challenge)}` };
}

/** The view data the proof partial (views/xss-proof.ejs) needs. */
export function proofView(victim: XssVictim, who: string, key: string, result: Result | null) {
  return { marker: victim.marker.call, who, key, result, steal: XSS_STEAL_URL };
}
