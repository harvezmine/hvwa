// The Archive API shell (src/districts/archive-api/_shared/api-lab.ts, docs/RECIPES.md section 3) through the real app, with a
// fixture lab (AA-01 "Reading Room", like UP-01 and XS-01 fixture their engines): the key, Bearer identity, JSON answers,
// the proof's flag member, the landing page's views and the JSON request console.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request, Response } from 'express';
import { describe, it, expect } from 'vitest';
import { byLevel } from '../src/core/lab.js';
import { flagFor } from '../src/core/mount.js';
import { defineChallenge, register } from '../src/core/registry.js';
import { sendPage } from '../src/core/render.js';
import {
  CONSOLE_LIMITS, apiKeyFor, apiView, consoleHeaders, consoleRequestOf, flagJson, jsonError, sendJson, viewerOf,
  type ApiEndpoint, type ConsoleRequest,
} from '../src/districts/archive-api/_shared/api-lab.js';
import { describeApiLanding } from '../src/districts/archive-api/_shared/api-lab.testkit.js';
import { mountIntents, success } from '../src/districts/_shared/intents.js';
import { FLAG_RE, freshSession } from './helpers.js';

const view = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'api-desk.ejs');
const LAB = '/d/archive-test/reading-room';

const ENDPOINTS: readonly ApiEndpoint[] = [
  { method: 'GET', path: '/api/hours', auth: 'none', description: 'Opening hours.', example: '/api/hours' },
  { method: 'GET', path: '/api/vault', auth: 'bearer', description: 'The vault.', example: '/api/vault' },
];

const impl = byLevel<Record<string, never>>({ acolyte: {}, divine: {} });
const typedOf = (req: Request): ConsoleRequest => consoleRequestOf(req);

const ROOM = register(defineChallenge({
  id: 'AA-01', district: 'archive-test', slug: 'reading-room', dir: process.cwd(),
  title: { id: 'Ruang baca', en: 'Reading Room' }, summary: { id: 'Fixture', en: 'Fixture' },
  maps: [], levels: impl.levels, hints: [],
  mount: (router) => {
    const page = (req: Request, res: Response, result: { ok: boolean; text: string } | null, output: string | null = null) =>
      sendPage(res, view, apiView(req, res, {
        result, curl: { path: '/api/vault', headers: ['Authorization: Bearer <your API key>'] }, endpoints: ENDPOINTS,
        console: { typed: typedOf(req), output },
      }));
    router.get('/', (req, res) => page(req, res, null));
    mountIntents(router, {
      console: {
        path: '/console', fields: ['method', 'path', 'headers', 'body'],
        run: (req) => {
          const t = typedOf(req);
          return success(`${t.method} ${t.path} | ${JSON.stringify(consoleHeaders(t.headers))} | ${t.body}`);
        },
      },
    }, async (req, res, o) => {
      await page(req, res, o.result, o.result?.text ?? null);
    });
    router.get('/api/hours', (_req, res) => { sendJson(res, 200, { open: '09:00-17:00' }); });
    router.get('/api/vault', (req, res) => {
      if (viewerOf(req) === null) return jsonError(res, 401, 'Send your API key as a Bearer token.');
      return sendJson(res, 200, { items: ['scroll'], ...flagJson(req, ROOM) });
    });
  },
}));

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });
const keyOn = async (agent: Awaited<ReturnType<typeof freshSession>>['agent'], level: string) =>
  /data-testid="api-key"><?(ak_pilgrim_[0-9a-f]{32})/.exec((await agent.get(`${LAB}?level=${level}`)).text)?.[1] ?? '';

describeApiLanding({
  challenge: ROOM, path: LAB,
  endpoints: ENDPOINTS.map((e) => ({ method: e.method, path: e.path, auth: e.auth })),
});

describe('AA-01: the Archive API shell through the real app', () => {
  it('apiKeyFor is ak_pilgrim_<32 hex>, per (session, level), and the page shows that very key', async () => {
    const { agent, sid } = await freshSession();
    const key = await keyOn(agent, 'acolyte');
    expect(key).toMatch(/^ak_pilgrim_[0-9a-f]{32}$/);
    expect(apiKeyFor({ sessionId: sid, level: 'acolyte' })).toBe(key);
    expect(apiKeyFor({ sessionId: sid, level: 'divine' })).not.toBe(key);
    expect(apiKeyFor({ sessionId: 'someone-else', level: 'acolyte' })).not.toBe(key);
  });

  it('viewerOf: the right key is a pilgrim; no header, another scheme, a wrong, malformed or foreign key is null (401)', async () => {
    const { agent } = await freshSession();
    const other = await freshSession();
    const key = await keyOn(agent, 'acolyte');
    const url = `${LAB}/api/vault?level=acolyte`;
    expect((await agent.get(url).set(bearer(key))).status).toBe(200);
    expect((await agent.get(url).set({ Authorization: `bearer  ${key}` })).status).toBe(200); // scheme is case-insensitive
    const refused: Record<string, string>[] = [
      {}, { Authorization: key }, { Authorization: `Basic ${key}` }, { Authorization: `Bearer ${key}x` },
      { Authorization: 'Bearer ak_pilgrim_00000000000000000000000000000000' }, { Authorization: 'Bearer ' },
      { Authorization: `Bearer ${await keyOn(other.agent, 'acolyte')}` }, { Authorization: `Bearer ${await keyOn(agent, 'divine')}` },
      bearer(key.toUpperCase()),
    ];
    for (const h of refused) {
      const res = await agent.get(url).set(h);
      expect(res.status, JSON.stringify(h)).toBe(401);
      expect(res.body).toEqual({ error: 'Send your API key as a Bearer token.' });
      expect(res.text).not.toMatch(FLAG_RE);
    }
  });

  it('sendJson and jsonError answer application/json, uncached, with the status given', async () => {
    const { agent } = await freshSession();
    const ok = await agent.get(`${LAB}/api/hours?level=acolyte`);
    expect([ok.status, ok.headers['content-type'], ok.headers['cache-control']]).toEqual([200, expect.stringMatching(/^application\/json/), 'no-store']);
    const no = await agent.get(`${LAB}/api/vault?level=acolyte`);
    expect([no.status, no.headers['content-type'], no.headers['cache-control']]).toEqual([401, expect.stringMatching(/^application\/json/), 'no-store']);
  });

  it('flagJson: { flag } below Divine, credited at that level; {} at Divine, which never computes one', async () => {
    const { agent, sid } = await freshSession();
    const res = await agent.get(`${LAB}/api/vault?level=acolyte`).set(bearer(await keyOn(agent, 'acolyte')));
    expect(res.body.flag).toMatch(FLAG_RE);
    const submit = await agent.post('/api/submit').send({ challengeId: ROOM.id, submission: res.body.flag });
    expect(submit.body).toMatchObject({ solved: true, level: 'acolyte' });
    const div = await agent.get(`${LAB}/api/vault?level=divine`).set(bearer(await keyOn(agent, 'divine')));
    expect(div.status).toBe(200);
    expect(div.body).toEqual({ items: ['scroll'] });
    expect(div.text).not.toMatch(FLAG_RE);
    expect(flagJson({ sessionId: sid, level: 'divine' }, ROOM)).toEqual({});
    expect(flagJson({ sessionId: sid, level: 'acolyte' }, ROOM)).toEqual({ flag: flagFor({ sessionId: sid, level: 'acolyte' }, ROOM) });
    expect(() => flagFor({ sessionId: sid, level: 'divine' }, ROOM)).toThrow();
  });

  it('the endpoint table links only an open GET example, with the served level', async () => {
    const { agent } = await freshSession();
    const page = (await agent.get(`${LAB}?level=divine`)).text;
    expect(page).toContain(`<a href="${LAB}/api/hours?level=divine">`);
    expect(page).not.toContain(`href="${LAB}/api/vault`);
    expect(page).toContain(`<code>${LAB}/api/vault</code>`);
    expect(page).toContain('<td>Bearer key</td>');
  });
});

describe('the JSON request console', () => {
  const post = async (fields: Record<string, string>) => {
    const { agent } = await freshSession();
    return agent.post(`${LAB}?level=acolyte`).type('form').send({ intent: 'console', ...fields });
  };

  it('is a plain form with the four fields, a hidden intent and no script at all', async () => {
    const { agent } = await freshSession();
    const html = (await agent.get(`${LAB}?level=acolyte`)).text;
    const page = /<section class="lab-note" data-testid="console">[\s\S]*?<\/section>/.exec(html)?.[0] ?? ''; // the layout has its own scripts
    expect(page).not.toBe('');
    for (const name of ['method', 'path', 'headers', 'body']) expect(page).toContain(`name="${name}"`);
    expect(page).toContain('<input type="hidden" name="intent" value="console">');
    expect(page).not.toMatch(/<script/i);
    expect(page).not.toMatch(/\son[a-z]+=/i);
    expect([...page.matchAll(/<option value="([A-Z]+)"/g)].map((m) => m[1])).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
  });

  it('keeps what was typed, escaped, and shows the answer escaped in a <pre>', async () => {
    const evil = '"><script>alert(1)</script>';
    const res = await post({ method: 'POST', path: evil, headers: `X-A: ${evil}`, body: `{"q":"${evil}"}` });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<script>alert(1)');
    expect(res.text).toContain('value="&#34;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(res.text).toMatch(/<pre data-testid="console-output">POST &#34;&gt;&lt;script&gt;/);
    expect(res.text).toContain('<option value="POST" selected>');
  });

  it('consoleRequestOf: an unknown or non-string method is GET; every field is clipped; objects and arrays are empty', async () => {
    const odd = await post({ method: 'TRACE', path: 'x'.repeat(5000), body: 'y'.repeat(20000) });
    expect(odd.text).toContain('<option value="GET" selected>');
    expect(odd.text).toContain(`x`.repeat(CONSOLE_LIMITS.path));
    expect(odd.text).not.toContain('x'.repeat(CONSOLE_LIMITS.path + 1));
    expect(odd.text).not.toContain('y'.repeat(CONSOLE_LIMITS.body + 1));
    const { agent } = await freshSession();
    for (const body of [{ intent: 'console', method: ['POST'], path: { a: 1 }, headers: [], body: null }, []]) {
      const res = await agent.post(`${LAB}?level=acolyte`).send(body as object);
      expect(res.status).toBe(200);
      expect(res.text).not.toMatch(FLAG_RE);
    }
  });

  it('consoleHeaders: Name: value lines only, at most 20, no control characters or bad names', () => {
    expect(consoleHeaders('Content-Type: application/json\r\nX-A:b\n\nbad line\nBad Name: x\n: v\nX-Tab:  v \n'))
      .toEqual([['Content-Type', 'application/json'], ['X-A', 'b'], ['X-Tab', 'v']]);
    expect(consoleHeaders('X-A: a\u0001b')).toEqual([]);
    expect(consoleHeaders(Array.from({ length: 50 }, (_, i) => `X-${i}: v`).join('\n'))).toHaveLength(CONSOLE_LIMITS.headerCount);
    expect(consoleHeaders('')).toEqual([]);
  });
});
