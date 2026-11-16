// _shared/oauth.spec.ts — the Pilgrim-ID labs' shared plumbing.
import { describe, it, expect } from 'vitest';
import type { Visit } from '../../../core/sim.js';
import { withParams as sharedWithParams } from '../../_shared/url.js';
import {
  CODE_TTL_MS, pilgrimIdAuthorize, pilgrimIdSignIn, pilgrimIdUser, withParams,
  type PilgrimId, type PilgrimIdPolicy, type PilgrimIdState,
} from './oauth.js';

describe('oauth: withParams', () => {
  it('is the district-agnostic one (districts/_shared/url.ts, tested in url.spec.ts), re-exported', () => {
    expect(withParams).toBe(sharedWithParams);
  });
});

describe('oauth: Pilgrim-ID sign-in and authorize (plumbing; the policy is the lab\'s callback)', () => {
  type S = PilgrimIdState & { readonly adminPw: string; readonly adminPid: string };
  const T0 = Date.UTC(2026, 10, 16, 12, 0, 0);
  const fresh = (): S => ({ idpSessions: new Map([['admin-pid', 'citadel_admin']]), codes: new Map(), world: { now: () => T0 }, adminPw: 'pw-1', adminPid: 'admin-pid' });
  const asked: string[] = [];
  const policy: PilgrimIdPolicy = {
    allowRedirect: (uri) => { asked.push(`allow ${uri}`); return uri.startsWith('http://citadel.test/'); },
    checkPkce: (challenge, method) => { asked.push(`pkce ${String(challenge)} ${String(method)}`); return challenge === 'bad' ? 'PKCE refused.' : undefined; },
  };
  const id: PilgrimId<S> = { cookie: (level) => `pid_${level}`, adminPassword: (s) => s.adminPw, pinnedSession: (s) => s.adminPid, maxEntries: 3, policy: () => policy };
  const visit = (query: string, sid?: string): Visit => ({
    level: 'templar', query: new URLSearchParams(query), cookies: sid === undefined ? {} : { pid_templar: sid }, base: '/d/x/y',
  });
  const authorize = (s: S, query: string) => pilgrimIdAuthorize(id, visit(`response_type=code&client_id=citadel&${query}`, 'admin-pid'), s);

  it('signs in the admin (with this lab\'s password) and pilgrim, with a session cookie on the lab\'s base; anyone else is refused', () => {
    const s = fresh();
    const admin = pilgrimIdSignIn(id, visit(''), s, 'citadel_admin', 'pw-1');
    expect(admin).toMatchObject({ status: 200, ok: true, text: 'Signed in to Pilgrim-ID as citadel_admin.' });
    const cookie = admin.cookies?.[0];
    expect(cookie).toMatchObject({ name: 'pid_templar', path: '/d/x/y' });
    expect(s.idpSessions.get(cookie?.value ?? '')).toBe('citadel_admin');
    expect(pilgrimIdUser(id, visit('', cookie?.value), s)).toBe('citadel_admin');
    expect(pilgrimIdSignIn(id, { ...visit(''), base: '' }, s, 'pilgrim', 'pilgrim').cookies?.[0]?.path).toBe('/'); // on the citadel
    for (const [u, p] of [['citadel_admin', 'pilgrim'], ['pilgrim', 'pw-1'], ['citadel_admin', ''], ['nobody', 'pw-1']]) {
      expect(pilgrimIdSignIn(id, visit(''), s, u, p), `${u}/${p}`).toEqual({ status: 200, ok: false, text: 'Invalid username or password.' });
    }
    expect(pilgrimIdUser(id, visit(''), s)).toBeUndefined();
  });

  it('sessions stay bounded and the pinned one (the admin\'s) is never pushed out', () => {
    const s = fresh();
    for (let i = 0; i < 10; i++) pilgrimIdSignIn(id, visit(''), s, 'pilgrim', 'pilgrim');
    expect(s.idpSessions.size).toBe(3);
    expect(s.idpSessions.get('admin-pid')).toBe('citadel_admin');
  });

  it('authorize refuses in order: not signed in, unknown client, response_type, redirect_uri (policy), PKCE (policy)', () => {
    const s = fresh();
    expect(pilgrimIdAuthorize(id, visit('response_type=code&client_id=citadel&redirect_uri=http://citadel.test/cb'), s))
      .toEqual({ status: 200, text: 'Pilgrim-ID: sign in first, then open this link again.' });
    expect(pilgrimIdAuthorize(id, visit('response_type=code&client_id=other', 'admin-pid'), s)).toEqual({ status: 400, text: 'Pilgrim-ID: unknown client.' });
    expect(pilgrimIdAuthorize(id, visit('response_type=token&client_id=citadel', 'admin-pid'), s)).toEqual({ status: 400, text: 'Pilgrim-ID: unsupported response_type.' });
    asked.length = 0;
    const unregistered = { status: 400, text: 'Pilgrim-ID: this redirect_uri is not registered for the client.' };
    expect(authorize(s, 'redirect_uri=')).toEqual(unregistered); // empty: the policy is not even asked
    expect(authorize(s, 'redirect_uri=http://attacker.test/cb')).toEqual(unregistered);
    expect(authorize(s, 'redirect_uri=http://citadel.test/cb&code_challenge=bad&code_challenge_method=plain')).toEqual({ status: 400, text: 'Pilgrim-ID: PKCE refused.' });
    expect(asked).toEqual(['allow http://attacker.test/cb', 'allow http://citadel.test/cb', 'pkce bad plain']);
    expect(s.codes.size).toBe(0);
  });

  it('authorize: a code for the signed-in user goes to the redirect_uri with the state, and expires CODE_TTL_MS later', () => {
    const s = fresh();
    const r = authorize(s, `redirect_uri=${encodeURIComponent('http://citadel.test/cb?x=1')}&state=s%201&code_challenge=c1&code_challenge_method=S256`);
    expect(r.status).toBe(302);
    const to = new URL(r.location ?? '');
    expect(`${to.origin}${to.pathname}`).toBe('http://citadel.test/cb');
    expect(to.searchParams.get('x')).toBe('1');
    expect(to.searchParams.get('state')).toBe('s 1');
    const code = to.searchParams.get('code') ?? '';
    expect(code).toMatch(/^[0-9a-f]{32}$/);
    expect(s.codes.get(code)).toEqual({
      user: 'citadel_admin', clientId: 'citadel', redirectUri: 'http://citadel.test/cb?x=1', challenge: 'c1', expiresAt: T0 + CODE_TTL_MS, used: false,
    });
    const plain = new URL(authorize(s, 'redirect_uri=http://citadel.test/cb').location ?? '');
    expect(plain.searchParams.has('state')).toBe(false);
    expect(s.codes.get(plain.searchParams.get('code') ?? '')).not.toHaveProperty('challenge');
    for (let i = 0; i < 5; i++) authorize(s, 'redirect_uri=http://citadel.test/cb');
    expect(s.codes.size).toBe(3);
  });
});
