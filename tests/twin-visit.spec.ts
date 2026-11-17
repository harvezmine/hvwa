// tests/twin-visit.spec.ts — E1b: what a page function sees of the request, the same in both browsers (core/twin.ts
// RequestVisit). A fixture route echoes visitOf(req, res) for the real browser; a fixture citadel echoes
// simVisitOf(level, r) for the simulated one. Equivalent requests must give equal Visits, `self` excepted.
import { describe, expect, it } from 'vitest';
import { perSession } from '../src/core/lab.js';
import { defineChallenge, register } from '../src/core/registry.js';
import {
  CITADEL_ORIGIN, SIM_LIMITS, TWIN_LIMITS, VISIT_HEADERS, simVisitOf, simWorld, twinBody, visitOf, type RequestVisit, type SimRequest,
} from '../src/core/sim.js';
import { freshSession } from './helpers.js';

const LAB = '/d/twin-test/visit';
const COOKIES = ['tw_acolyte'];
const NAMED = ['accept-language'];

/** Everything a page function can read, as plain data. */
function echo(v: RequestVisit) {
  return {
    level: v.level, base: v.base, query: v.query.toString(), cookies: { ...v.cookies }, method: v.method,
    headers: { ...v.headers }, body: { ...v.body }, text: v.text, self: v.self,
    sameOrigin: v.headers.origin === v.self, nullProto: [Object.getPrototypeOf(v.headers), Object.getPrototypeOf(v.body)],
  };
}
type Echo = ReturnType<typeof echo>;

register(defineChallenge({
  id: 'TW-02', district: 'twin-test', slug: 'visit', dir: process.cwd(),
  title: { id: 't', en: 't' }, summary: { id: 's', en: 's' }, maps: [], levels: ['acolyte', 'divine'], hints: [],
  mount: (router) => {
    router.all('/echo', (req, res) => { res.json(echo(visitOf(req, res, COOKIES, NAMED))); });
    // A state-changing route that reads a text/plain body too (FP-01 Inquisitor, FP-02): twinBody() first.
    router.post('/text', twinBody(), (req, res) => { res.json(echo(visitOf(req, res, COOKIES, NAMED))); });
  },
}));

// The simulated browser's side: every request the citadel gets is echoed into `seen`.
const sims = perSession(() => {
  const seen: Echo[] = [];
  const b = simWorld().browser((r) => { seen.push(echo(simVisitOf('acolyte', r, COOKIES, NAMED))); return { status: 200, headers: { 'Access-Control-Allow-Origin': '*' } }; });
  return { b, seen };
});
let n = 0;
const sim = () => sims.for({ sessionId: `twin-visit-${++n}`, level: 'acolyte' });

/** The real route's own origin, as visitOf computes it for this test server. */
async function realSelf(agent: Awaited<ReturnType<typeof freshSession>>['agent']): Promise<string> {
  return ((await agent.get(`${LAB}/echo?level=acolyte`)).body as Echo).self;
}
/** The fields both browsers must agree on (self and the browser-made headers aside). */
const shared = (e: Echo, headers: readonly string[]) => ({
  method: e.method, body: e.body, text: e.text, query: e.query, level: e.level, sameOrigin: e.sameOrigin,
  headers: Object.fromEntries(headers.map((h) => [h, e.headers[h]])),
});

describe('RequestVisit: the request, the same in both browsers (E1b)', () => {
  it('self is this browser\'s own origin for the lab: CITADEL_ORIGIN in the sim, the request\'s own origin on the real route', async () => {
    const { agent } = await freshSession();
    expect(await realSelf(agent)).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const s = sim();
    s.b.follow('http://citadel.test/echo');
    expect(s.seen[0].self).toBe(CITADEL_ORIGIN);
  });

  it('an urlencoded form posted from the lab\'s own page: method, fields, text, Content-Type, and Origin === self in both', async () => {
    const { agent } = await freshSession();
    const self = await realSelf(agent);
    const real = (await agent.post(`${LAB}/echo?level=acolyte`).set('Origin', self).type('form').send('email=pilgrim%40citadel.test&note=a+b')).body as Echo;
    const s = sim();
    s.b.submit('http://citadel.test/echo?level=acolyte', { email: 'pilgrim@citadel.test', note: 'a b' });
    const fake = s.seen[0];
    expect(shared(real, ['content-type'])).toEqual(shared(fake, ['content-type']));
    expect(shared(fake, ['content-type'])).toMatchObject({
      method: 'POST', body: { email: 'pilgrim@citadel.test', note: 'a b' }, text: 'email=pilgrim%40citadel.test&note=a+b',
      sameOrigin: true, headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect([real.self === fake.self, real.headers.origin, fake.headers.origin]).toEqual([false, self, CITADEL_ORIGIN]);
  });

  it('a cross-site request is told apart the same way in both: Origin is not self', async () => {
    const { agent } = await freshSession();
    const real = (await agent.post(`${LAB}/echo?level=acolyte`).set('Origin', 'http://attacker.test').type('form').send('a=1')).body as Echo;
    const s = sim();
    s.b.crossSitePost('http://citadel.test/echo?level=acolyte', { a: '1' });
    expect(shared(real, ['origin'])).toEqual(shared(s.seen[0], ['origin']));
    expect(real.sameOrigin).toBe(false);
  });

  it('a GET: no body, empty text; a header the lab names is passed on too, in both', async () => {
    const { agent } = await freshSession();
    const real = (await agent.get(`${LAB}/echo?level=acolyte&x=1`).set('Accept-Language', 'id')).body as Echo;
    const s = sim();
    s.b.corsFetch('http://citadel.test/echo?level=acolyte&x=1', { headers: { 'Accept-Language': 'id' } });
    expect(shared(real, ['accept-language'])).toEqual(shared(s.seen[0], ['accept-language']));
    expect(shared(real, ['accept-language'])).toMatchObject({ method: 'GET', body: {}, text: '', headers: { 'accept-language': 'id' } });
  });

  it('a JSON body: its string members, and the text (re-serialised by the app\'s JSON parser on the real route)', async () => {
    const { agent } = await freshSession();
    const json = '{"notify":"all","n":5,"o":{"x":"y"}}';
    const real = (await agent.post(`${LAB}/echo?level=acolyte`).set('Content-Type', 'application/json').send(json)).body as Echo;
    // The sim's browser never sends JSON cross-site (a preflight); the citadel request a same-origin page would make:
    const r = { method: 'POST', url: 'http://citadel.test/echo', path: '/echo', query: new URLSearchParams('level=acolyte'),
      headers: { host: 'citadel.test', 'content-type': 'application/json' }, cookies: {}, body: {}, rawBody: json } as SimRequest;
    expect(shared(real, ['content-type'])).toEqual(shared(echo(simVisitOf('acolyte', r, COOKIES)), ['content-type']));
    expect(real).toMatchObject({ body: { notify: 'all' }, text: json });
  });

  it('only the listed headers and the ones the lab names: never cookie, host or user-agent', async () => {
    const { agent } = await freshSession();
    const real = (await agent.post(`${LAB}/echo?level=acolyte`).set('Referer', 'http://x/').set('X-Requested-With', 'XMLHttpRequest')
      .set('X-Other', 'no').type('form').send('a=1')).body as Echo;
    expect(Object.keys(real.headers).sort()).toEqual(['content-type', 'referer', 'x-requested-with']);
    const s = sim();
    s.b.follow('http://citadel.test/echo', { referrer: 'http://citadel.test/home' });
    expect(Object.keys(s.seen[0].headers).sort()).toEqual(['referer', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-user']);
    expect(VISIT_HEADERS).toEqual(['origin', 'referer', 'content-type', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user', 'x-requested-with']);
  });

  it('headers and body have no prototype; values are bounded copies (header 2049, text and fields 8 KiB)', async () => {
    const { agent } = await freshSession();
    const long = `http://x/${'r'.repeat(5000)}`;
    const real = (await agent.post(`${LAB}/echo?level=acolyte`).set('Referer', long).type('form').send(`a=${'v'.repeat(20_000)}`)).body as Echo;
    expect(real.nullProto).toEqual([null, null]);
    expect(real.headers.referer).toHaveLength(SIM_LIMITS.urlLength + 1);
    expect(real.body.a).toHaveLength(TWIN_LIMITS.textLength);
    expect(real.text).toHaveLength(TWIN_LIMITS.textLength);
    expect(TWIN_LIMITS.textLength).toBe(8 * 1024);
    const r = { method: 'POST', url: 'http://citadel.test/echo', path: '/echo', query: new URLSearchParams(''),
      headers: { referer: long, 'content-type': 'application/x-www-form-urlencoded' }, cookies: {}, body: {}, rawBody: `a=${'v'.repeat(20_000)}` } as SimRequest;
    const fake = echo(simVisitOf('acolyte', r));
    expect([fake.headers.referer?.length, fake.body.a.length, fake.text.length, fake.nullProto]).toEqual([SIM_LIMITS.urlLength + 1, 8192, 8192, [null, null]]);
  });

  it('simVisitOf without names keeps its old behaviour for cookies; the new fields are always there', () => {
    const r = { method: 'GET', url: 'http://citadel.test/', path: '/', query: new URLSearchParams(''), headers: {}, cookies: { a: '1' }, body: {}, rawBody: '' } as SimRequest;
    const v = simVisitOf('divine', r);
    expect([{ ...v.cookies }, v.method, { ...v.headers }, { ...v.body }, v.text, v.self, v.base]).toEqual([{ a: '1' }, 'GET', {}, {}, '', CITADEL_ORIGIN, '']);
  });
});

describe('twinBody(): a route that reads a text/plain body (E1b)', () => {
  const JSON_TEXT = '{"notify":"all","x":"="}';

  it('reads a text/plain body whole into text, as the sim\'s fetch sends it: the same Visit in both browsers', async () => {
    const { agent } = await freshSession();
    const real = (await agent.post(`${LAB}/text?level=acolyte`).set('Content-Type', 'text/plain;charset=UTF-8').send(JSON_TEXT)).body as Echo;
    const s = sim();
    s.b.corsFetch('http://citadel.test/text?level=acolyte', { method: 'POST', body: JSON_TEXT }); // text/plain;charset=UTF-8
    expect(shared(real, ['content-type'])).toEqual(shared(s.seen[0], ['content-type']));
    expect(real).toMatchObject({ method: 'POST', text: JSON_TEXT, body: {} });
    expect(JSON.parse(real.text)).toEqual({ notify: 'all', x: '=' }); // what a level that JSON-parses text/plain reads
  });

  it('without it, the app parses no text/plain body: text is empty (why a state-changing FP route mounts it)', async () => {
    const { agent } = await freshSession();
    const real = (await agent.post(`${LAB}/echo?level=acolyte`).set('Content-Type', 'text/plain').send(JSON_TEXT)).body as Echo;
    expect([real.text, real.body]).toEqual(['', {}]);
  });

  it('JSON and urlencoded bodies on the same route: the app\'s global parsers read them first, so text is re-serialised', async () => {
    const { agent } = await freshSession();
    const json = (await agent.post(`${LAB}/text?level=acolyte`).set('Content-Type', 'application/json').send('{ "notify" : "all", "n": 1 }')).body as Echo;
    expect([json.text, json.body]).toEqual(['{"notify":"all","n":1}', { notify: 'all' }]); // the same fields, not the same bytes
    const form = (await agent.post(`${LAB}/text?level=acolyte`).type('form').send('a=1&a=2&b[c]=x&d=%20')).body as Echo;
    expect([form.text, form.body]).toEqual(['a=1&a=2&b%5Bc%5D=x&d=+', { a: '1', 'b[c]': 'x', d: ' ' }]);
    // ... and the sim reads the same fields from the raw bytes:
    const r = { method: 'POST', url: 'http://citadel.test/text', path: '/text', query: new URLSearchParams(''),
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, cookies: {}, body: {}, rawBody: 'a=1&a=2&b[c]=x&d=%20' } as SimRequest;
    expect({ ...simVisitOf('acolyte', r).body }).toEqual(form.body);
  });

  it(`refuses a text/plain body over ${TWIN_LIMITS.textLength} bytes (413, before the route runs)`, async () => {
    const { agent } = await freshSession();
    const ok = await agent.post(`${LAB}/text?level=acolyte`).set('Content-Type', 'text/plain').send('x'.repeat(TWIN_LIMITS.textLength));
    expect([ok.status, (ok.body as Echo).text.length]).toEqual([200, TWIN_LIMITS.textLength]);
    const big = await agent.post(`${LAB}/text?level=acolyte`).set('Content-Type', 'text/plain').send('x'.repeat(TWIN_LIMITS.textLength + 1));
    expect(big.status).toBe(413);
  });

  it('is route-local: a fresh handler each call, reading only text/plain', () => {
    expect(typeof twinBody()).toBe('function');
    expect(twinBody()).not.toBe(twinBody());
  });
});
