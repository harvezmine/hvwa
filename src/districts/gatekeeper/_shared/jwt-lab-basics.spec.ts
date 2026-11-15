// _shared/jwt-lab-basics.spec.ts — the tests every JWT lab (GK-04 … GK-07) shares, as a helper for their specs.
// (It is a .spec.ts file so the build leaves test code out of dist/; it carries one test of its own so vitest
// accepts it as a suite.)
import { describe, it, expect } from 'vitest';
import { freshSession, bare, FLAG_RE } from '../../../../tests/helpers.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import type { Claims } from './jwt-lab.js';
import { cookieName } from './jwt-lab.js';

export interface JwtLabBasics {
  readonly challenge: { readonly id: string };
  /** The lab's base path, e.g. '/d/gatekeeper/jwt-alg-none'. */
  readonly path: string;
  /** A genuine token (real server key) for any claims: the lab's test seam. */
  readonly mint: (sessionId: string, level: Level, claims: Claims) => string;
}

const ADMIN = { sub: 'citadel_admin', role: 'admin' };
const jwtCookies = (res: { headers: Record<string, unknown> }) =>
  [res.headers['set-cookie'] ?? []].flat().map(String).filter((l) => l.startsWith('citadel_jwt'));

/** Register the shared JWT-lab tests for one lab. */
export function describeJwtLabBasics(b: JwtLabBasics): void {
  const { path } = b;
  describe(`${b.challenge.id} JWT lab basics`, () => {
    it('the vault takes the token from the lab cookie too, and an Authorization header wins over it', async () => {
      const { agent, sid, app } = await freshSession();
      const admin = b.mint(sid, 'acolyte', ADMIN);
      const viaCookie = await bare(app, sid, `${cookieName('acolyte')}=${admin}`).get(`${path}/vault?level=acolyte`);
      expect(viaCookie.text).toMatch(FLAG_RE);
      // the agent's jar gets pilgrim's cookie; the header carries the admin token and is the one that counts
      await agent.post(`${path}?level=acolyte`).type('form').send({ username: 'pilgrim', password: 'pilgrim' });
      expect((await agent.get(`${path}/vault?level=acolyte`).set('Authorization', `Bearer ${admin}`)).text).toMatch(FLAG_RE);
      const bad = await agent.get(`${path}/vault?level=acolyte`).set('Authorization', `Bearer ${admin}x`);
      expect(bad.text).not.toMatch(FLAG_RE);
      // a header that is not a Bearer token is not a token (and the cookie is not consulted behind its back)
      const basic = await bare(app, sid, `${cookieName('acolyte')}=${admin}`).get(`${path}/vault?level=acolyte`).set('Authorization', 'Basic abc');
      expect(basic.text).not.toMatch(FLAG_RE);
    });

    it('a wrong password signs nobody in; the admin cannot be signed in through the form', async () => {
      const { agent } = await freshSession();
      for (const level of LEVELS) {
        for (const creds of [{ username: 'pilgrim', password: 'nope' }, { username: 'citadel_admin', password: 'pilgrim' }, { username: 'citadel_admin', password: '' }]) {
          const res = await agent.post(`${path}?level=${level}`).type('form').send(creds);
          expect(res.text, level).toContain('Invalid username or password.');
          expect(jwtCookies(res), level).toEqual([]);
        }
      }
    });

    it('links are absolute lab paths, even for an upper-case request URL', async () => {
      const { agent } = await freshSession();
      for (const level of LEVELS) {
        const res = await agent.get(`${path.toUpperCase()}?level=${level}`);
        expect(res.text, level).toContain(`href="${path}/vault?level=${level}"`);
        expect(res.text, level).not.toContain(path.toUpperCase());
        for (const href of [...res.text.matchAll(/href="([^"]*)"/g)].map((m) => m[1])) {
          if (href.includes('/vault') || href.includes(`${path}/`)) expect(href, level).toMatch(/^\/d\/gatekeeper\//);
        }
      }
    });

    it('probing the vault without a token changes nothing: no cookie, a plain denial', async () => {
      const { app, sid } = await freshSession();
      for (const level of LEVELS) {
        const probe = await bare(app, sid).get(`${path}/vault?level=${level}`);
        expect(probe.status, level).toBe(200);
        expect(probe.text, level).toContain('Missing token');
        expect(jwtCookies(probe), level).toEqual([]);
      }
    });

    it('POST /_reset is 404 (JWT labs need no Restart: nothing can get stuck)', async () => {
      const { agent } = await freshSession();
      expect((await agent.post(`${path}/_reset?level=acolyte`)).status).toBe(404);
    });

    it('below Divine a denial says why; Divine only says "Invalid token."', async () => {
      const { agent } = await freshSession();
      const at = async (level: Level) => (await agent.get(`${path}/vault?level=${level}`).set('Authorization', 'Bearer not.a.token')).text;
      for (const level of ['acolyte', 'templar', 'inquisitor'] as const) expect(await at(level), level).toMatch(/Invalid token: [a-z]/);
      expect(await at('divine')).toMatch(/Invalid token\.</);
    });

    it('the vault page has no form (nothing to post), and links back to the sign-in page', async () => {
      const { agent, sid } = await freshSession();
      for (const level of LEVELS) {
        for (const token of [undefined, 'junk', b.mint(sid, level, ADMIN)]) {
          const req = agent.get(`${path}/vault?level=${level}`);
          const res = token === undefined ? await req : await req.set('Authorization', `Bearer ${token}`);
          expect(res.status, level).toBe(200);
          const main = res.text.slice(res.text.indexOf('<section class="lab">'));
          expect(main, level).not.toContain('<form');
          expect(main, level).toContain(`href="${path}?level=${level}">Back to sign-in</a>`);
        }
      }
    });

    it('the sign-in page gives a curl line that can work: full quoted URL and the session cookie to copy, never its value', async () => {
      const { agent, sid } = await freshSession();
      const res = await agent.get(`${path}?level=templar`);
      expect(res.text).toMatch(new RegExp(`curl "http://[^"\\s]+${path}/vault\\?level=templar" -H "Authorization: Bearer &lt;token&gt;" -b "hvwa_sid=&lt;copy from devtools&gt;"`));
      expect(res.text).toMatch(/devtools[\s\S]*Authorization: Bearer/);
      expect(res.text).toContain(cookieName('templar'));
      expect(res.text).not.toContain(sid);
    });
  });
}

describe('describeJwtLabBasics', () => {
  it('is a function', () => { expect(typeof describeJwtLabBasics).toBe('function'); });
});
