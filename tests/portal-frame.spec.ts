// Portal pages may be framed only by HVWA itself: `Content-Security-Policy: frame-ancestors 'self'`. Without it a
// same-SITE page (another port of 127.0.0.1, cookies included) could frame /c/<id> or the scoreboard. Lab routes
// never get it: a lab's framing is its lesson, set per level by setLabHeaders (core/http.ts) and nothing else.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { defineChallenge, register } from '../src/core/registry.js';
import { setLabHeaders } from '../src/core/http.js';
import { PORTAL_FRAME_POLICY } from '../src/portal/frame-policy.js';
import { TEST_SECRET } from './helpers.js';
import { join } from 'node:path';

// Level files, so the portal serves View Source and the Diff for the fixture lab.
const dir = mkdtempSync(join(tmpdir(), 'hvwa-pf-'));
mkdirSync(join(dir, 'levels'));
writeFileSync(join(dir, 'levels', 'acolyte.ts'), 'export const level = 1;\n');
writeFileSync(join(dir, 'levels', 'divine.ts'), 'export const level = 2;\n');
afterAll(() => rmSync(dir, { recursive: true, force: true }));
// A lab with real level files (View Source, Diff) and three kinds of routes: no headers, its own framing, a 404.
register(defineChallenge({
  id: 'PF-01', district: 'frame-test', slug: 'lab', dir,
  title: { id: 'Frame', en: 'Frame' }, summary: { id: '', en: '' }, maps: ['x'], levels: ['acolyte', 'divine'], hints: [],
  mount: (r) => {
    r.get('/', (_req, res) => { res.type('html').send('<p>lab</p>'); });
    r.get('/framed', (_req, res) => { setLabHeaders(res, { frameAncestors: '*' }); res.type('html').send('<p>framable lab</p>'); });
  },
}));

const csp = (res: request.Response) => res.headers['content-security-policy'] as string | undefined;

describe("portal pages: frame-ancestors 'self'", () => {
  it('is exactly the frame-ancestors directive: no script, style or connect rule, so htmx and the layout are untouched', () => {
    expect(PORTAL_FRAME_POLICY).toBe("frame-ancestors 'self'");
  });

  it.each([false, true])('every portal page and its 404 carry it (login %s); no X-Frame-Options', async (auth) => {
    const app = createApp({ flagSecret: TEST_SECRET, auth });
    const agent = request.agent(app);
    if (auth) {
      const page = await agent.get('/login');
      const _csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)?.[1];
      expect((await agent.post('/login').type('form').send({ _csrf, username: 'admin', password: 'password' })).status).toBe(303);
    }
    for (const path of ['/', '/?lang=en', '/c/PF-01', '/scoreboard', '/c/PF-01/source/acolyte', '/c/PF-01/diff', '/no-such-page',
      '/d/frame-test', '/d/frame-test/', '/d/frame-test?show=todo']) {
      const res = await agent.get(path);
      expect(res.status, path).toBe(path === '/no-such-page' ? 404 : 200);
      expect(csp(res), path).toBe(PORTAL_FRAME_POLICY);
      expect(res.headers['x-frame-options'], path).toBeUndefined();
    }
    // The portal's player actions (form posts, htmx fragments) answer under it too.
    const submit = await agent.post('/c/PF-01/submit').set('HX-Request', 'true').type('form').send({ submission: 'x' });
    expect(submit.status).toBe(200);
    expect(csp(submit)).toBe(PORTAL_FRAME_POLICY);
    app.locals.db.close();
  });

  it('the login and password pages keep their stricter frame-ancestors \'none\' (and X-Frame-Options: DENY)', async () => {
    const app = createApp({ flagSecret: TEST_SECRET, auth: true });
    const res = await request(app).get('/login');
    expect(csp(res)).toBe("frame-ancestors 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    app.locals.db.close();
  });
});

describe('never on lab routes, nor on the platform\'s non-page answers', () => {
  it('a lab page, a lab 404 and a lab that sets its own framing carry only what the lab set', async () => {
    const app = createApp({ flagSecret: TEST_SECRET });
    const agent = request.agent(app);
    for (const path of ['/d/frame-test/lab?level=acolyte', '/d/frame-test/lab?level=divine', '/D/FRAME-TEST/LAB', '/d/frame-test/lab/nope']) {
      expect(csp(await agent.get(path)), path).toBeUndefined();
    }
    expect(csp(await agent.get('/d/frame-test/lab/framed'))).toBe('frame-ancestors *');
    for (const path of ['/healthz', '/static/app.css', '/static/vendor/htmx.min.js', '/api/nope']) {
      expect(csp(await agent.get(path)), path).toBeUndefined();
    }
    expect(csp(await agent.post('/api/submit').send({ challengeId: 'PF-01', submission: 'x' }))).toBeUndefined();
    app.locals.db.close();
  });
});
