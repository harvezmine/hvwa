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

// Undeclared inquisitor.ts + a sibling secret.ts must never be reachable.
const CP3dir = dirWith({
  acolyte: 'ACOLYTE_MARKER\n', templar: 'TEMPLAR_MARKER\n', inquisitor: 'INQ_UNDECLARED\n', divine: 'DIVINE_MARKER\n',
});
writeFileSync(join(CP3dir, 'secret.ts'), 'TOP_SECRET\n');
const CP3 = register(defineChallenge({
  id: 'CP-03', district: 'gatekeeper', slug: 'cp-markers', dir: CP3dir,
  title: { id: '<b>x</b>', en: '<b>x</b>' }, summary: { id: '<i>s</i>', en: '<i>s</i>' },
  maps: [], levels: ['acolyte', 'templar', 'divine'], mount: () => {}, hints: [],
}));
// lowest exploitable level is templar
register(defineChallenge({
  id: 'CP-04', district: 'gatekeeper', slug: 'cp-templar-low',
  dir: dirWith({ templar: 'T_LOW\n', divine: 'D_SEC\n' }),
  title: { id: 't', en: 't' }, summary: { id: 's', en: 's' },
  maps: [], levels: ['templar', 'divine'], mount: () => {}, hints: [],
}));

register(defineChallenge({
  id: 'CP-05', district: 'gatekeeper', slug: 'cp-throws', dir: dirWith({ acolyte: 'x' }),
  title: { id: 't', en: 't' }, summary: { id: 's', en: 's' },
  maps: [], levels: ['acolyte'], mount: () => {}, hints: [],
  check: () => { throw new Error('kaboom-internal'); },
}));

const fresh = () => freshSession();
const col = (html: string, side: 'vuln' | 'secure') =>
  [...html.matchAll(new RegExp(`<td class="diff-${side}">([\\s\\S]*?)</td>`, 'g'))].map((m) => m[1]).join('');

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

describe('source cache', () => {
  it('caches misses too (files are static per process)', () => {
    const dir = dirWith({});
    const c = defineChallenge({
      id: 'CP-78', district: 'x', slug: 'y', dir, title: { id: 't', en: 't' }, summary: { id: 's', en: 's' },
      maps: [], levels: ['acolyte'], mount: () => {}, hints: [],
    });
    expect(levelSource(c, 'acolyte')).toBeUndefined();
    writeFileSync(join(dir, 'levels', 'acolyte.ts'), 'LATE');
    expect(levelSource(c, 'acolyte')).toBeUndefined();
  });
});

describe('undeclared files are unreachable', () => {
  it('levelSource ignores an undeclared level file and traversal', () => {
    expect(levelSource(CP3, 'inquisitor')).toBeUndefined();
    expect(levelSource(CP3, '../secret' as never)).toBeUndefined();
  });
  it('/source/inquisitor is 404 when undeclared', async () => {
    const { agent } = await fresh();
    expect((await agent.get('/c/CP-03/source/inquisitor')).status).toBe(404);
  });
  it('level sources are cached after the first read (static files)', () => {
    const dir = dirWith({ acolyte: 'FIRST' });
    const c = defineChallenge({
      id: 'CP-77', district: 'x', slug: 'x', dir, title: { id: 't', en: 't' }, summary: { id: 's', en: 's' },
      maps: [], levels: ['acolyte'], mount: () => {}, hints: [],
    });
    expect(levelSource(c, 'acolyte')).toBe('FIRST');
    rmSync(join(dir, 'levels', 'acolyte.ts'));
    expect(levelSource(c, 'acolyte')).toBe('FIRST');
  });
});

describe('page content', () => {
  it('escapes challenge title and summary', async () => {
    const { agent } = await fresh();
    const html = (await agent.get('/c/CP-03?lang=en')).text;
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('&lt;i&gt;s&lt;/i&gt;');
    expect(html).not.toContain('<b>x</b>');
    expect(html).not.toContain('<i>s</i>');
  });
  it('has the form fields, the swap target element, and every source + diff link', async () => {
    const { agent } = await fresh();
    const html = (await agent.get('/c/CP-01')).text;
    expect(html).toContain('name="submission"');
    expect(html).toContain('name="tier" value="1"');
    expect(html).toContain('hx-target="#submit-result"');
    expect(html).toContain('id="submit-result"');
    expect(html).toContain('hx-target="#hint-1"');
    expect(html).toContain('id="hint-1"');
    expect(html).toContain('href="/c/CP-01/source/acolyte"');
    expect(html).toContain('href="/c/CP-01/source/divine"');
    expect(html).toContain('href="/c/CP-01/diff"');
    // CP-01 declares templar but ships no file: no dead link
    expect(html).not.toContain('/c/CP-01/source/templar');
  });
  it('shows unlocked hint text in id', async () => {
    const { agent } = await fresh();
    await agent.post('/api/hint').send({ challengeId: 'CP-01', tier: 1 });
    expect((await agent.get('/c/CP-01?lang=id')).text).toContain('petunjuk-id &lt;b&gt;');
  });
  it('solved state is per session on the same app', async () => {
    const a = await fresh();
    const b = await freshSession(a.app);
    await a.agent.post('/api/submit').send({ challengeId: 'CP-01', submission: issueFlag('CP-01', a.sid, 'acolyte') });
    expect((await a.agent.get('/c/CP-01')).text).toMatch(/level-tab-acolyte"[^>]*data-solved="true"/);
    expect((await b.agent.get('/c/CP-01')).text).toMatch(/level-tab-acolyte"[^>]*data-solved="false"/);
  });
  it('page titles are valid UTF-8 (no replacement characters)', async () => {
    const { agent } = await fresh();
    for (const p of ['/c/CP-01', '/c/CP-01/source/acolyte', '/c/CP-01/diff']) {
      const title = /<title>([\s\S]*?)<\/title>/.exec((await agent.get(`${p}?lang=en`)).text)![1];
      expect(title, p).not.toContain('�');
      if (p !== '/c/CP-01') expect(title, p).toContain('CP-01');
    }
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
    expect(tabs).toEqual(['acolyte', 'templar', 'divine']); // one tab per implemented level
    expect(en).toContain('href="/d/gatekeeper/cp-fixture?level=divine"');
    expect(en).toMatch(/data-testid="level-tab-divine"[^>]*>[^<]*secure reference/i);
    // divine is never scored: no solved flag or badge on its tab
    expect(en).not.toMatch(/data-testid="level-tab-divine"[^>]*data-solved/);
    expect(/data-testid="level-tab-divine"[\s\S]*?<\/li>/.exec(en)![0]).not.toContain('class="badge');
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

const hx = { 'HX-Request': 'true' };

describe('portal POST /c/:id/hint and /submit (htmx fragments)', () => {
  it('hint unlock with HX-Request returns an escaped HTML fragment', async () => {
    const { agent } = await fresh();
    const res = await agent.post('/c/CP-01/hint').set(hx).type('form').send({ tier: '1' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('petunjuk-id &lt;b&gt;');
    expect(res.text).not.toContain('<b>');
  });

  it('hint unlock changes the score', async () => {
    const { agent, sid, app } = await fresh();
    await agent.post('/api/submit').send({ challengeId: 'CP-01', submission: issueFlag('CP-01', sid, 'acolyte') });
    expect(scoreFor(app.locals.db, sid)).toBe(100);
    await agent.post('/c/CP-01/hint').set(hx).type('form').send({ tier: '1' });
    expect(scoreFor(app.locals.db, sid)).toBe(70);
  });

  it('correct flag credits the solve; wrong submission is escaped and not echoed', async () => {
    const { agent, sid, app } = await fresh();
    const bad = await agent.post('/c/CP-01/submit').set(hx).type('form').send({ submission: '<img src=x onerror=alert(1)>' });
    expect(bad.status).toBe(200);
    expect(bad.headers['content-type']).toMatch(/html/);
    expect(bad.text).toContain('data-solved="false"');
    expect(bad.text).not.toContain('<img');
    expect(bad.text).not.toContain('onerror');
    expect(scoreFor(app.locals.db, sid)).toBe(0);
    const ok = await agent.post('/c/CP-01/submit').set(hx).type('form').send({ submission: issueFlag('CP-01', sid, 'acolyte') });
    expect(ok.text).toContain('data-solved="true"');
    expect(scoreFor(app.locals.db, sid)).toBe(100);
  });

  it('messages distinguish new best (+gained), already solved, and best-remains', async () => {
    const { agent, sid } = await fresh();
    const post = async (lvl: 'acolyte' | 'templar') =>
      (await agent.post('/c/CP-01/submit?lang=en').set(hx).type('form').send({ submission: issueFlag('CP-01', sid, lvl) })).text;
    const first = await post('templar');
    expect(first).toContain('data-result="new_best"');
    expect(first).toContain('+150');
    const again = await post('templar');
    expect(again).toContain('data-result="already"');
    expect(again).not.toContain('+150');
    const lower = await post('acolyte');
    expect(lower).toContain('data-result="lower"');
    expect(lower).toMatch(/best[^<]*Templar/i);
    expect(lower).not.toMatch(/\+\d/);
  });

  it('gained is the difference from the previous best', async () => {
    const { agent, sid } = await fresh();
    await agent.post('/c/CP-01/submit').set(hx).type('form').send({ submission: issueFlag('CP-01', sid, 'acolyte') });
    const up = await agent.post('/c/CP-01/submit?lang=en').set(hx).type('form').send({ submission: issueFlag('CP-01', sid, 'templar') });
    expect(up.text).toContain('data-result="new_best"');
    expect(up.text).toContain('+50');
    expect(up.text).not.toContain('+150');
  });

  it('error fragments (invalid and unknown tier) are 200 HTML with no input echoed', async () => {
    const { agent } = await fresh();
    for (const tier of ['2', 'x<b>']) {
      const r = await agent.post('/c/CP-01/hint').set(hx).type('form').send({ tier });
      expect(r.status, tier).toBe(200);
      expect(r.text).toContain('data-error');
      expect(r.text).not.toContain('x<b>');
    }
  });

  it('hint fragment honors ?lang and the remembered cookie', async () => {
    const a = await fresh();
    const en = await a.agent.post('/c/CP-01/hint?lang=en').set(hx).type('form').send({ tier: '1' });
    expect(en.text).toContain('hint-en &lt;b&gt;');
    const b = await fresh();
    await b.agent.get('/c/CP-01?lang=id');
    const id = await b.agent.post('/c/CP-01/hint').set(hx).type('form').send({ tier: '1' });
    expect(id.text).toContain('petunjuk-id &lt;b&gt;');
  });

  it('unknown challenge ids 404', async () => {
    const { agent } = await fresh();
    expect((await agent.post('/c/ZZ-99/submit').type('form').send({ submission: 'x' })).status).toBe(404);
    expect((await agent.post('/c/..%2Fx/hint').type('form').send({ tier: '1' })).status).toBe(404);
  });
});

describe('portal POST without htmx (303 + one-shot result)', () => {
  it('submit redirects back with a closed-set result key; the page renders it', async () => {
    const { agent, sid } = await fresh();
    const res = await agent.post('/c/CP-01/submit?lang=en').type('form').send({ submission: issueFlag('CP-01', sid, 'templar') });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/c/CP-01?r=new_best&lvl=templar');
    const page = (await agent.get(res.headers.location)).text;
    expect(page).toContain('data-result="new_best"');
    expect(page).toMatch(/New best level: Templar/);
    expect(page).not.toContain('+150');
  });

  it('a genuine no-JS lower solve shows "best remains <stored best>"', async () => {
    const { agent, sid } = await fresh();
    await agent.post('/c/CP-01/submit').type('form').send({ submission: issueFlag('CP-01', sid, 'templar') });
    const res = await agent.post('/c/CP-01/submit').type('form').send({ submission: issueFlag('CP-01', sid, 'acolyte') });
    expect(res.headers.location).toBe('/c/CP-01?r=lower&lvl=acolyte');
    const page = (await agent.get(res.headers.location + '&lang=en')).text;
    expect(page).toMatch(/data-result="lower"[^>]*>[^<]*best remains Templar/);
    const again = await agent.post('/c/CP-01/submit').type('form').send({ submission: issueFlag('CP-01', sid, 'templar') });
    expect(again.headers.location).toBe('/c/CP-01?r=already&lvl=templar');
    expect((await agent.get(again.headers.location)).text).toContain('data-result="already"');
  });

  it('spoofed result links render no message', async () => {
    const { agent, sid } = await fresh();
    const none = async (q: string) => expect((await agent.get('/c/CP-01' + q)).text, q).not.toContain('data-result');
    // nothing solved yet
    await none('?r=new_best&lvl=templar&g=999999');
    await none('?r=already&lvl=acolyte');
    await none('?r=lower&lvl=acolyte');
    await agent.post('/c/CP-01/submit').type('form').send({ submission: issueFlag('CP-01', sid, 'acolyte') });
    await none('?r=new_best&lvl=templar&g=999999'); // best is acolyte, not templar
    await none('?r=new_best&lvl=inquisitor&g=999999');
    await none('?r=new_best'); // no lvl
    await none('?r=already'); await none('?r=lower');
    await none('?r=already&lvl=templar');
    await none('?r=lower&lvl=divine');
    await none('?r=lower&lvl=acolyte'); // best acolyte is not above acolyte
    await none('?r=new_best&lvl=divine');
    // consistent with the stored best: shown, and g is never rendered
    const ok = (await agent.get('/c/CP-01?r=new_best&lvl=acolyte&g=999999')).text;
    expect(ok).toContain('data-result="new_best"');
    expect(ok).not.toContain('999999');
  });

  it('no-JS hint errors render beside the hints list, not in the submit result', async () => {
    const { agent } = await fresh();
    const html = (await agent.get('/c/CP-01?r=err_unknown_tier')).text;
    const hintFlash = /data-testid="hint-flash"[^>]*>([\s\S]*?)<\/div>/.exec(html);
    expect(hintFlash).not.toBeNull();
    expect(hintFlash![1]).toContain('data-error="err_unknown_tier"');
    const submit = /id="submit-result"[^>]*>([\s\S]*?)<\/div>/.exec(html)!;
    expect(submit[1]).not.toContain('data-error');
  });

  it('wrong submission redirects without echoing it', async () => {
    const { agent } = await fresh();
    const res = await agent.post('/c/CP-01/submit').type('form').send({ submission: 'SECRETGUESS<x>' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/c/CP-01?r=wrong');
    expect(res.headers.location).not.toContain('SECRETGUESS');
    expect((await agent.get(res.headers.location)).text).toContain('data-solved="false"');
  });

  it('hint redirects to the page, which shows the unlocked hint; bad tier shows an error key', async () => {
    const { agent } = await fresh();
    const ok = await agent.post('/c/CP-01/hint').type('form').send({ tier: '1' });
    expect(ok.status).toBe(303);
    expect(ok.headers.location).toBe('/c/CP-01');
    expect((await agent.get('/c/CP-01?lang=en')).text).toContain('hint-en &lt;b&gt;');
    const bad = await agent.post('/c/CP-01/hint').type('form').send({ tier: '3' });
    expect(bad.headers.location).toBe('/c/CP-01?r=err_unknown_tier');
    expect((await agent.get(bad.headers.location)).text).toContain('data-error');
  });

  it('ignores unknown result keys and bad lvl/g values (nothing is echoed)', async () => {
    const { agent } = await fresh();
    const html = (await agent.get('/c/CP-01?r=%3Cscript%3E&lvl=%3Cb%3E&g=%3Ci%3E')).text;
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('data-result');
    const html2 = (await agent.get('/c/CP-01?r=new_best&lvl=%3Cb%3E&g=%3Ci%3E')).text;
    expect(html2).not.toContain('<b>');
    expect(html2).not.toContain('<i>');
    expect(html2).not.toContain('&lt;b&gt;');
    expect(html2).not.toContain('&lt;i&gt;');
  });
});

describe('/api stays JSON-only', () => {
  it('ignores HX-Request on /api/submit and /api/hint', async () => {
    const { agent, sid } = await fresh();
    const s = await agent.post('/api/submit').set(hx).send({ challengeId: 'CP-01', submission: issueFlag('CP-01', sid, 'acolyte') });
    expect(s.headers['content-type']).toMatch(/json/);
    expect(s.body).toMatchObject({ solved: true, level: 'acolyte', points: 100 });
    const h = await agent.post('/api/hint').set(hx).send({ challengeId: 'CP-01', tier: 2 });
    expect(h.status).toBe(404);
    expect(h.body).toEqual({ unlocked: false, error: 'unknown_tier' });
  });
  it('the page wires its forms to the portal routes (htmx + no-JS)', async () => {
    const { agent } = await fresh();
    const html = (await agent.get('/c/CP-01')).text;
    expect(html).toContain('hx-post="/c/CP-01/submit"');
    expect(html).toContain('hx-post="/c/CP-01/hint"');
    expect(html).not.toContain('/api/');
    const forms = [...html.matchAll(/<form[^>]*>/g)].map((m) => m[0]);
    for (const url of ['/c/CP-01/submit', '/c/CP-01/hint']) {
      const f = forms.find((x) => x.includes(`hx-post="${url}"`));
      expect(f, url).toContain('method="post"');
      expect(f, url).toContain(`action="${url}"`);
    }
    expect(html).toMatch(/hx-confirm="[^"]+"/);
  });
});

describe('htmx error visibility', () => {
  it('a throwing check() gives HX callers a stack-free HTML fragment and others the normal page', async () => {
    const { agent } = await fresh();
    const h = await agent.post('/c/CP-05/submit').set(hx).type('form').send({ submission: 'x' });
    expect(h.status).toBe(500);
    expect(h.headers['content-type']).toMatch(/html/);
    expect(h.text).toContain('data-error');
    expect(h.text).not.toContain('<html');
    expect(h.text).not.toContain('kaboom-internal');
    expect(h.text).not.toMatch(/\.ts:\d+/);
    const n = await agent.post('/c/CP-05/submit').type('form').send({ submission: 'x' });
    expect(n.status).toBe(500);
    expect(n.text).toContain('<html');
    expect(n.text).not.toContain('kaboom-internal');
  });
  it('the layout makes htmx swap error responses', async () => {
    const { agent } = await fresh();
    const html = (await agent.get('/c/CP-01')).text;
    const m = /<meta name="htmx-config" content='([^']+)'>/.exec(html);
    expect(m).not.toBeNull();
    const cfg = JSON.parse(m![1]);
    expect(cfg.responseHandling.some((r: { swap: boolean; code: string }) => r.swap && new RegExp(`^${r.code}$`).test('500'))).toBe(true);
    expect(cfg.responseHandling.some((r: { swap: boolean; code: string }) => r.swap && new RegExp(`^${r.code}$`).test('413'))).toBe(true);
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
    expect((await agent.get('/c/CP-01/source/acolyte?lang=en')).text).toContain('<h2>Acolyte</h2>');
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
  it('left column is the lowest exploitable level, right is divine; middle levels absent', async () => {
    const { agent } = await fresh();
    const html = (await agent.get('/c/CP-03/diff')).text;
    expect(col(html, 'vuln')).toContain('ACOLYTE_MARKER');
    expect(col(html, 'secure')).toContain('DIVINE_MARKER');
    expect(html).not.toContain('TEMPLAR_MARKER');
    expect(html).not.toContain('INQ_UNDECLARED');
  });
  it('the diff page title is i18n-ed', async () => {
    const { agent } = await fresh();
    const title = /<title>([\s\S]*?)<\/title>/.exec((await agent.get('/c/CP-01/diff?lang=id')).text)![1];
    expect(title).toContain('perbandingan');
    expect(title).not.toContain('diff');
  });
  it('labels the left column with the actual level (templar-lowest fixture)', async () => {
    const { agent } = await fresh();
    const html = (await agent.get('/c/CP-04/diff?lang=en')).text;
    expect(html).toContain('T_LOW');
    expect(html).toMatch(/<th colspan="2">[^<]*Templar[^<]*<\/th>/);
    expect(html).not.toMatch(/<th colspan="2">[^<]*Acolyte[^<]*<\/th>/);
  });
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
