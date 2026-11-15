import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register, defineChallenge } from '../src/core/registry.js';
import { levelSource } from '../src/core/source.js';
import { issueFlag } from '../src/core/flags.js';
import { scoreFor } from '../src/core/scoreboard.js';
import { freshSession } from './helpers.js';

const root = mkdtempSync(join(tmpdir(), 'hvwa-cp-'));
function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(root, 'c-'));
  mkdirSync(join(dir, 'levels'));
  for (const [n, body] of Object.entries(files)) writeFileSync(join(dir, 'levels', `${n}.ts`), body);
  return dir;
}
afterAll(() => rmSync(root, { recursive: true, force: true }));

// templar is declared but its file is missing; divine exists.
const CP1 = register(defineChallenge({
  id: 'CP-01', district: 'gatekeeper', slug: 'cp-fixture',
  dir: dirWith({
    acolyte: 'const a = 1;\nconst x = "<script>alert(1)</script>";\n',
    divine: 'const a = 1;\nconst x = safe();\n',
  }),
  title: { id: 'Judul Uji', en: 'Page Title' }, summary: { id: 'ringkasan-id', en: 'summary-en' },
  maps: ['A05:2025', 'CWE-89'], levels: ['acolyte', 'templar', 'divine'], mount: () => {},
  hints: [{ id: 1, text: { id: 'petunjuk-id <b>', en: 'hint-en <b>' }, cost: 30 }],
}));
// no divine level -> no diff
const CP2 = register(defineChallenge({
  id: 'CP-02', district: 'gatekeeper', slug: 'cp-nodivine',
  dir: dirWith({ acolyte: 'x' }),
  title: { id: 't', en: 't' }, summary: { id: 's', en: 's' },
  maps: [], levels: ['acolyte', 'templar'], mount: () => {}, hints: [],
}));

const fresh = () => freshSession();

describe('levelSource', () => {
  it('reads an implemented level file', () => {
    expect(levelSource(CP1, 'acolyte')).toContain('const a = 1;');
  });
  it('is undefined for an unimplemented level or a missing file', () => {
    expect(levelSource(CP2, 'inquisitor')).toBeUndefined();
    expect(levelSource(CP1, 'templar')).toBeUndefined(); // declared, no file
  });
  it('rejects non-level input', () => {
    expect(levelSource(CP1, '../acolyte' as never)).toBeUndefined();
  });
});

describe('GET /c/:id', () => {
  it('renders title, summary in current lang, tags, and exactly the implemented levels', async () => {
    const { agent } = await fresh();
    const en = (await agent.get('/c/CP-01?lang=en')).text;
    expect(en).toContain('Page Title');
    expect(en).toContain('summary-en');
    expect(en).toContain('CWE-89');
    expect(en).toContain('A05:2025');
    const tabs = [...en.matchAll(/data-testid="level-tab-(\w+)"/g)].map((m) => m[1]);
    expect(tabs).toEqual(['acolyte', 'templar']); // divine is not a tab
    expect(en).toContain('href="/d/gatekeeper/cp-fixture?level=acolyte"');
    expect(en).toContain('href="/c/CP-01/diff"');
    expect((await agent.get('/c/CP-01?lang=id')).text).toContain('ringkasan-id');
  });

  it('shows a locked hint with its cost, and unlocked text escaped after unlock', async () => {
    const { agent } = await fresh();
    const before = (await agent.get('/c/CP-01?lang=en')).text;
    expect(before).toContain('30');
    expect(before).not.toContain('hint-en');
    await agent.post('/api/hint').type('form').send({ challengeId: 'CP-01', tier: '1' });
    const after = (await agent.get('/c/CP-01?lang=en')).text;
    expect(after).toContain('hint-en &lt;b&gt;');
  });

  it('marks levels at or below the best solved level as solved', async () => {
    const { agent, sid } = await fresh();
    expect((await agent.get('/c/CP-01')).text).not.toContain('data-solved="true"');
    await agent.post('/api/submit').send({ challengeId: 'CP-01', submission: issueFlag('CP-01', sid, 'templar') });
    const html = (await agent.get('/c/CP-01')).text;
    expect(html).toMatch(/data-testid="level-tab-acolyte"[^>]*data-solved="true"/);
    expect(html).toMatch(/data-testid="level-tab-templar"[^>]*data-solved="true"/);
    const s2 = await fresh();
    await s2.agent.post('/api/submit').send({ challengeId: 'CP-01', submission: issueFlag('CP-01', s2.sid, 'acolyte') });
    const h2 = (await s2.agent.get('/c/CP-01')).text;
    expect(h2).toMatch(/data-testid="level-tab-acolyte"[^>]*data-solved="true"/);
    expect(h2).toMatch(/data-testid="level-tab-templar"[^>]*data-solved="false"/);
  });

  it('404s for unknown and odd ids', async () => {
    const { agent } = await fresh();
    for (const p of ['/c/ZZ-99', '/c/..%2Fx', '/c/%00', '/c/constructor', '/c/__proto__']) {
      expect((await agent.get(p)).status, p).toBe(404);
    }
  });

  it('is linked from the portal index instead of the lab', async () => {
    const { agent } = await fresh();
    const html = (await agent.get('/')).text;
    expect(html).toContain('href="/c/CP-01"');
    expect(html).not.toContain('href="/d/gatekeeper/cp-fixture"');
  });
});

describe('htmx fragments from the page endpoints', () => {
  it('hint unlock with HX-Request returns an escaped HTML fragment; JSON contract unchanged', async () => {
    const { agent } = await fresh();
    const res = await agent.post('/api/hint').set('HX-Request', 'true').type('form')
      .send({ challengeId: 'CP-01', tier: '1' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('petunjuk-id &lt;b&gt;');
    expect(res.text).not.toContain('<b>');
    const json = await agent.post('/api/hint').send({ challengeId: 'CP-01', tier: 1 });
    expect(json.headers['content-type']).toMatch(/json/);
    expect(json.body).toMatchObject({ unlocked: true, tier: 1, cost: 30 });
  });

  it('hint unlock changes the score', async () => {
    const { agent, sid, app } = await fresh();
    const solve = await agent.post('/api/submit')
      .send({ challengeId: 'CP-01', submission: issueFlag('CP-01', sid, 'acolyte') });
    expect(solve.body.solved).toBe(true);
    expect(scoreFor(app.locals.db, sid)).toBe(100);
    await agent.post('/api/hint').set('HX-Request', 'true').type('form').send({ challengeId: 'CP-01', tier: '1' });
    expect(scoreFor(app.locals.db, sid)).toBe(70);
  });

  it('submit with HX-Request: correct flag credits the solve; wrong submission is escaped', async () => {
    const { agent, sid, app } = await fresh();
    const bad = await agent.post('/api/submit').set('HX-Request', 'true').type('form')
      .send({ challengeId: 'CP-01', submission: '<img src=x onerror=alert(1)>' });
    expect(bad.headers['content-type']).toMatch(/html/);
    expect(bad.text).not.toContain('<img');
    expect(scoreFor(app.locals.db, sid)).toBe(0);
    const ok = await agent.post('/api/submit').set('HX-Request', 'true').type('form')
      .send({ challengeId: 'CP-01', submission: issueFlag('CP-01', sid, 'acolyte') });
    expect(ok.headers['content-type']).toMatch(/html/);
    expect(ok.text).toContain('data-solved="true"');
    expect(scoreFor(app.locals.db, sid)).toBe(100);
  });

  it('the page wires its forms to the API via htmx', async () => {
    const { agent } = await fresh();
    const html = (await agent.get('/c/CP-01')).text;
    expect(html).toContain('hx-post="/api/submit"');
    expect(html).toContain('hx-post="/api/hint"');
    expect(html).toContain('name="challengeId" value="CP-01"');
  });
});

describe('GET /c/:id/source/:level', () => {
  it('returns the escaped file content in <pre>', async () => {
    const { agent } = await fresh();
    const res = await agent.get('/c/CP-01/source/acolyte');
    expect(res.status).toBe(200);
    expect(res.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(res.text).not.toContain('<script>alert(1)');
    expect(res.text).toMatch(/<pre[^>]*>/);
  });
  it('serves divine source when the file exists', async () => {
    const { agent } = await fresh();
    expect((await agent.get('/c/CP-01/source/divine')).text).toContain('safe()');
  });
  it('404s for unimplemented level, missing file, unknown challenge, bad level', async () => {
    const { agent } = await fresh();
    expect((await agent.get('/c/CP-01/source/inquisitor')).status).toBe(404);
    expect((await agent.get('/c/CP-01/source/templar')).status).toBe(404); // file missing
    expect((await agent.get('/c/CP-02/source/divine')).status).toBe(404);
    expect((await agent.get('/c/ZZ-99/source/acolyte')).status).toBe(404);
    for (const l of ['..%2Facolyte', '%2e%2e', 'acolyte.ts', 'constructor']) {
      expect((await agent.get(`/c/CP-01/source/${l}`)).status, l).toBe(404);
    }
  });
});

describe('GET /c/:id/diff', () => {
  it('renders both columns for vulnerable vs divine', async () => {
    const { agent } = await fresh();
    const res = await agent.get('/c/CP-01/diff?lang=en');
    expect(res.status).toBe(200);
    expect(res.text).toContain('diff-vuln');
    expect(res.text).toContain('diff-secure');
    expect(res.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(res.text).toContain('safe()');
  });
  it('404s without a divine level, or for an unknown challenge', async () => {
    const { agent } = await fresh();
    expect((await agent.get('/c/CP-02/diff')).status).toBe(404);
    expect((await agent.get('/c/ZZ-99/diff')).status).toBe(404);
  });
});
