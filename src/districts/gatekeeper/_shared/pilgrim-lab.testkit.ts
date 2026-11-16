// _shared/pilgrim-lab.testkit.ts — the tests and set-up every pilgrim lab (GK-12, 13, 14, 17, 18) shares, for their specs.
// A test kit (see jwt-lab.testkit.ts): `*.testkit.ts` is never collected as a spec and never reaches dist/.
import type request from 'supertest';
import type { Express } from 'express';
import { freshSession, describeLabView, setCookieValue, type Agent } from '../../../../tests/helpers.js';
import type { Level } from '../../../core/levels.js';
import { describeCurlExample, type CurlExampleSpec } from '../../_shared/curl.testkit.js';
import { PLAYER } from './lab.js';

// The curl-example check is district-agnostic (districts/_shared/curl.testkit.ts); re-exported for the Gatekeeper specs.
export { describeCurlExample, type ExpectedCurl } from '../../_shared/curl.testkit.js';

/** One player's session on a fresh app, at one level. */
export interface PilgrimCtx { readonly agent: Agent; readonly level: Level; readonly sid: string; readonly app: Express }

export async function newCtx(level: Level): Promise<PilgrimCtx> {
  const { agent, sid, app } = await freshSession();
  return { agent, level, sid, app };
}

const form = { username: PLAYER.username, password: PLAYER.password };

/** The lab's front page and sign-in, as requests: `home(c)`, `login(c)`, `get(c, '/admin')`. */
export function pilgrimClient(path: string) {
  return {
    home: (c: PilgrimCtx) => c.agent.get(`${path}?level=${c.level}`),
    login: (c: PilgrimCtx) => c.agent.post(`${path}?level=${c.level}`).type('form').send(form),
    get: (c: PilgrimCtx, sub: string) => c.agent.get(`${path}${sub}?level=${c.level}`),
    /** The sign-in cookie a login sets, by name. */
    cookie: (res: request.Response, name: string) => setCookieValue(res, name),
  };
}

/** A pilgrim lab: the challenge, its base path (e.g. '/d/gatekeeper/idor-profile') and the curl line its front page shows. */
export type PilgrimLabSpec = CurlExampleSpec;

/**
 * The shared lab-view checks (account told, no password inputs, forms without action, escaped echo, odd bodies,
 * message classes, upper-case URL) plus the shared curl check: a line a player can use as written, with the full
 * quoted URL and the platform session cookie to copy (never its value).
 */
export function describePilgrimLab(o: PilgrimLabSpec): void {
  describeLabView({
    challenge: o.challenge, path: o.path, account: /pilgrim<\/code> \/ <code>pilgrim/, echoField: 'username', extra: { password: 'x' },
    oddBodies: [{ username: { a: 1 }, password: ['x'] }, { username: [], password: null }, []],
    ok: (agent, level) => agent.post(`${o.path}?level=${level}`).type('form').send(form),
    bad: (agent, level) => agent.post(`${o.path}?level=${level}`).type('form').send({ username: 'pilgrim', password: 'no' }),
  });

  describeCurlExample(o);
}
