// _shared/twin.spec.ts — the Reply adapter of the victim-driven labs: what the simulated browser receives.
import { describe, it, expect } from 'vitest';
import { cookiePath, toSim } from './twin.js';

describe('twin: a Reply for the simulated browser', () => {
  it('a page: status and body, no headers it did not ask for', () => {
    expect(toSim({ status: 200, text: 'Hello.' })).toEqual({ status: 200, headers: {}, body: 'Hello.' });
  });

  it('a redirect carries its Location; a forwarding page carries Refresh: 0 and its Referrer-Policy', () => {
    expect(toSim({ status: 302, location: '/idp/authorize?x=1', text: '' }).headers).toEqual({ Location: '/idp/authorize?x=1' });
    expect(toSim({ status: 200, forward: 'http://attacker.test/', referrerPolicy: 'no-referrer', text: 'On we go.' }).headers)
      .toEqual({ Refresh: '0; url=http://attacker.test/', 'Referrer-Policy': 'no-referrer' });
  });

  it('cookies become Set-Cookie lines on their path; a cleared one expires at once', () => {
    const r = toSim({
      status: 200, text: '',
      cookies: [{ name: 'a_acolyte', value: 'v1', path: '/' }, { name: 'b_acolyte', value: '', path: '/', clear: true }],
    });
    expect(r.headers?.['Set-Cookie']).toEqual([
      'a_acolyte=v1; Path=/; HttpOnly; SameSite=Lax',
      'b_acolyte=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
    ]);
  });

  it('a value is URL-encoded as res.cookie() does, so both browsers read back the same value', () => {
    const r = toSim({ status: 200, text: '', cookies: [{ name: 'next_acolyte', value: 'http://attacker.test/?a=1;b', path: '/' }] });
    expect(r.headers?.['Set-Cookie']).toEqual(['next_acolyte=http%3A%2F%2Fattacker.test%2F%3Fa%3D1%3Bb; Path=/; HttpOnly; SameSite=Lax']);
  });

  it('the citadel (base \'\') puts its cookies on /, a real route on the lab path', () => {
    expect(cookiePath('')).toBe('/');
    expect(cookiePath('/d/gatekeeper/x')).toBe('/d/gatekeeper/x');
  });
});
