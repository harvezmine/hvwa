// _shared/twin.spec.ts — the Reply adapter of the victim-driven labs: what each browser receives from one Reply.
import { describe, it, expect } from 'vitest';
import { freshSession } from '../../../../tests/helpers.js';
import { perSession } from '../../../core/lab.js';
import { defineChallenge, register } from '../../../core/registry.js';
import { simWorld } from '../../../core/sim.js';
import { cookiePath, sendReply, toSim, type Reply } from './twin.js';

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

// --- sendReply: the same Replies for the player's real browser, through a fixture lab -------------------------------

const LAB = '/d/twin-test/reply';
const REPLIES: Readonly<Record<string, Reply>> = {
  page: { status: 200, text: 'A page.' },
  redirect: { status: 302, location: '/next?a=1', text: '' },
  seeOther: { status: 303, location: 'http://citadel.test/elsewhere', text: '' },
  locationOn200: { status: 200, location: 'http://citadel.test/elsewhere', text: 'Still a page.' },
  locationOn400: { status: 400, location: 'http://attacker.test/', text: 'Refused.' },
  cookies: {
    status: 200, text: '',
    cookies: [{ name: 'tw_acolyte', value: 'a;b c', path: LAB }, { name: 'gone_acolyte', value: '', path: LAB, clear: true }],
  },
};
const replyNamed = (name: string): Reply => {
  if (!Object.hasOwn(REPLIES, name)) throw new Error(`no fixture reply ${name}`);
  return REPLIES[name];
};

register(defineChallenge({
  id: 'TW-01', district: 'twin-test', slug: 'reply', dir: process.cwd(),
  title: { id: 't', en: 't' }, summary: { id: 's', en: 's' }, maps: [], levels: ['acolyte', 'divine'], hints: [],
  mount: (router) => {
    router.get('/reply/:name', (req, res) => sendReply(res, replyNamed(String(req.params.name)), async () => {
      res.json({ rendered: true });
    }));
  },
}));

// The simulated browser on the same Replies: /start/<name> answers toSim(that Reply), any other page 'landed'.
const sims = perSession(() => {
  const world = simWorld();
  return world.browser((r) => (r.path.startsWith('/start/') ? toSim(replyNamed(r.path.slice('/start/'.length))) : { status: 200, body: 'landed' }));
});
const simVisit = (name: string) => sims.for({ sessionId: `sim-${name}`, level: 'acolyte' }).follow(`http://citadel.test/start/${name}`);

describe('twin: sendReply for the real browser', () => {
  it('a page is rendered at its status', async () => {
    const { agent } = await freshSession();
    const page = await agent.get(`${LAB}/reply/page?level=acolyte`);
    expect(page.status).toBe(200);
    expect(page.body).toEqual({ rendered: true });
  });

  it('a 3xx Location goes through sendSimRedirect: into the lab, at the served level', async () => {
    const { agent } = await freshSession();
    const r302 = await agent.get(`${LAB}/reply/redirect?level=acolyte`);
    expect(r302.status).toBe(302);
    expect(r302.headers.location).toBe(`${LAB}/next?a=1&level=acolyte`);
    const r303 = await agent.get(`${LAB}/reply/seeOther?level=divine`);
    expect(r303.status).toBe(303);
    expect(r303.headers.location).toBe(`${LAB}/elsewhere?level=divine`);
  });

  it('a Location on a status that is not a redirect is a page, as the simulated browser treats it', async () => {
    const { agent } = await freshSession();
    for (const [name, status] of [['locationOn200', 200], ['locationOn400', 400]] as const) {
      const res = await agent.get(`${LAB}/reply/${name}?level=acolyte`);
      expect(res.status, name).toBe(status);
      expect(res.headers.location, name).toBeUndefined();
      expect(res.body, name).toEqual({ rendered: true });
      const visit = simVisit(name);
      expect(visit.outcome, name).toBe('page');
      expect(visit.hops, name).toHaveLength(1);
    }
    expect(simVisit('redirect').hops.map((h) => h.via)).toEqual(['start', 'redirect']); // a real 3xx: both follow it
  });

  it('cookies are set on their path, HttpOnly and SameSite=Lax, values URL-encoded; a cleared one expires', async () => {
    const { agent } = await freshSession();
    const res = await agent.get(`${LAB}/reply/cookies?level=acolyte`);
    const lines = [res.headers['set-cookie'] ?? []].flat();
    expect(lines).toContain(`tw_acolyte=a%3Bb%20c; Path=${LAB}; HttpOnly; SameSite=Lax`);
    expect(lines.find((l) => l.startsWith('gone_acolyte='))).toMatch(new RegExp(`^gone_acolyte=; Path=${LAB}; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax$`));
  });
});
