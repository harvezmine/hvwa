// The redesigned shell (core/views/layout.ejs, src/public): theme preference and toggle, language switch, breadcrumbs,
// the district page, the icon sprite, and the CSP-friendly markup rules (no inline script, handler or style).
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createApp } from '../src/app.js';
import { register, defineChallenge } from '../src/core/registry.js';
import { issueFlag } from '../src/core/flags.js';
import { sendPage } from '../src/core/render.js';
import { freshSession, setCookieHeader } from './helpers.js';

const hello = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hello.ejs');
register(defineChallenge({
  id: 'SH-01', district: 'shell-test', slug: 'one', dir: process.cwd(),
  title: { id: 'Satu', en: 'One' }, summary: { id: 'ringkasan', en: 'summary one' },
  maps: ['A01:2025', 'CWE-639'], levels: ['acolyte', 'templar', 'divine'], hints: [],
  mount: (router) => { router.get('/', (_req, res) => sendPage(res, hello, { name: 'lab' })); },
}));
register(defineChallenge({
  id: 'SH-02', district: 'shell-test', slug: 'two', dir: process.cwd(),
  title: { id: 'Dua', en: 'Two' }, summary: { id: 's', en: 's' },
  maps: [], levels: ['acolyte'], hints: [], mount: () => {},
}));

const get = (path: string, cookie?: string) => {
  const r = request(createApp()).get(path);
  return cookie ? r.set('Cookie', cookie) : r;
};

describe('language and theme toggles keep the page query (keptQuery)', () => {
  it('keeps other query params and drops lang/theme, so a toggle never loses ?next= or ?level=', async () => {
    const res = await get('/d/shell-test/one?level=templar&lang=id&theme=dark&q=a%20b');
    expect(res.text).toContain('href="?level=templar&amp;q=a+b&amp;lang=en"');
    expect(res.text).toContain('href="?level=templar&amp;q=a+b&amp;lang=id"');
    expect(res.text).toContain('href="?level=templar&amp;q=a+b&amp;theme=light"');
    expect(res.text).not.toContain('lang=id&amp;lang=');
  });

  it('percent-encodes kept values, so a reflected payload never breaks out of the href', async () => {
    const res = await get('/d/shell-test/one?q=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E');
    expect(res.text).toContain('href="?q=%22%3E%3Cscript%3Ealert%281%29%3C%2Fscript%3E&amp;lang=en"');
    expect(res.text).not.toContain('<script>alert(1)');
  });

  it('drops a long query instead of copying it into every toggle (lab pages have a 16 KiB budget)', async () => {
    const res = await get(`/d/shell-test/one?q=${'x'.repeat(600)}`);
    expect(res.text).toContain('href="?lang=en"');
    expect(res.text).toContain('href="?theme=light"');
    expect(res.text).not.toContain('x'.repeat(600) + '&amp;lang=');
  });

  it('never carries the one-shot flag-result params (r, lvl, g), so a toggle cannot replay a result', async () => {
    const res = await get('/d/shell-test/one?r=new_best&lvl=templar&g=999999&level=templar');
    expect(res.text).toContain('href="?level=templar&amp;lang=en"');
    expect(res.text).not.toContain('999999');
  });

  it('a plain page keeps the bare toggles', async () => {
    const res = await get('/');
    expect(res.text).toContain('href="?lang=id"');
  });
});

describe('theme preference (core/theme.ts) and toggle', () => {
  it('defaults to the system theme: no data-theme, both toggle links, no cookie', async () => {
    const res = await get('/');
    expect(res.text).toContain('<html lang="en">');
    expect(res.text).toContain('href="?theme=light"');
    expect(res.text).toContain('href="?theme=dark"');
    expect(setCookieHeader(res, 'hvwa_theme')).toBeUndefined();
  });

  it('?theme=light is rendered server-side and remembered in the shared preference cookie policy', async () => {
    const agent = request.agent(createApp());
    const r1 = await agent.get('/?theme=light');
    expect(r1.text).toContain('<html lang="en" data-theme="light">');
    expect(r1.text).toContain('href="?theme=dark"');
    expect(r1.text).not.toContain('href="?theme=light"');
    const line = setCookieHeader(r1, 'hvwa_theme') ?? '';
    expect(line).toMatch(/^hvwa_theme=light; Max-Age=31536000;/);
    expect(line).toMatch(/; HttpOnly/i);
    expect(line).toMatch(/; SameSite=Lax/i);
    const r2 = await agent.get('/scoreboard');
    expect(r2.text).toContain('data-theme="light"');
    const r3 = await agent.get('/?theme=system');
    expect(r3.text).toContain('<html lang="en">');
  });

  it('an invalid ?theme= falls back to the cookie and is never echoed', async () => {
    const res = await get('/?theme=%22%3E%3Cb%3E', 'hvwa_theme=dark');
    expect(res.text).toContain('data-theme="dark"');
    expect(res.text).not.toContain('<b>');
    expect(setCookieHeader(res, 'hvwa_theme')).toBeUndefined();
    expect((await get('/', 'hvwa_theme=neon')).text).toContain('<html lang="en">');
  });

  it('the error page follows the language and theme too, and links home', async () => {
    const res = await get('/no-such-page?lang=id', 'hvwa_theme=light');
    expect(res.status).toBe(404);
    expect(res.text).toContain('<html lang="id" data-theme="light">');
    expect(res.text).toContain('Not Found');
    expect(res.text).toContain('Halaman tidak ditemukan');
    expect(res.text).toContain('<a class="btn btn-primary" href="/">');
  });
});

describe('language switch', () => {
  it('marks the current language and links the other', async () => {
    const en = (await get('/')).text;
    expect(en).toMatch(/<a href="\?lang=en"[^>]*aria-current="true"[^>]*>EN<\/a>/);
    expect(en).toMatch(/<a href="\?lang=id"(?![^>]*aria-current)[^>]*>ID<\/a>/);
    const id = (await get('/?lang=id')).text;
    expect(id).toMatch(/<a href="\?lang=id"[^>]*aria-current="true"[^>]*>ID<\/a>/);
  });
});

describe('district page (/d/<district>)', () => {
  it('lists exactly the district\'s challenges as cards linking their challenge pages, with a breadcrumb', async () => {
    const res = await get('/d/shell-test');
    expect(res.status).toBe(200);
    const cards = [...res.text.matchAll(/<a class="card challenge-card[^"]*" href="\/c\/([A-Z]{2}-\d{2})"/g)].map((m) => m[1]);
    expect(cards).toEqual(['SH-01', 'SH-02']);
    expect(res.text).toContain('<span class="tag">A01:2025</span>');
    expect(res.text).toMatch(/<ol class="crumbs">[\s\S]*href="\/"[\s\S]*aria-current="page">Shell Test<\/span>/);
    expect(res.text).not.toContain('href="/d/shell-test/one"'); // cards go to the challenge page, not the lab
  });

  it('filters by ?show= (closed set), and shows solved state', async () => {
    const { agent, sid } = await freshSession();
    await agent.post('/api/submit').send({ challengeId: 'SH-01', submission: issueFlag('SH-01', sid, 'templar') });
    const ids = async (q: string) => [...(await agent.get(`/d/shell-test${q}`)).text.matchAll(/href="\/c\/(SH-\d{2})" data-challenge="SH-\d{2}" data-solved="(true|false)"/g)].map((m) => `${m[1]}:${m[2]}`);
    expect(await ids('')).toEqual(['SH-01:true', 'SH-02:false']);
    expect(await ids('?show=done')).toEqual(['SH-01:true']);
    expect(await ids('?show=todo')).toEqual(['SH-02:false']);
    expect(await ids('?show=%3Cx%3E')).toEqual(['SH-01:true', 'SH-02:false']);
    expect((await agent.get('/d/shell-test')).text).toContain('Solved at Templar');
  });

  it('404s for an unknown district, and stays out of the lab routes', async () => {
    expect((await get('/d/no-such-district')).status).toBe(404);
    expect((await get('/d/shell-test/one')).text).toContain('data-testid="lab-bar"');
  });
});

describe('lab bar breadcrumb and level meaning', () => {
  it('links Home, the district page and the challenge page, and says what the served level means', async () => {
    const html = (await get('/d/shell-test/one?level=templar')).text;
    const bar = /<nav class="lab-bar"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
    expect(bar).toContain('data-level="templar"');
    expect(bar).toContain('<a href="/d/shell-test">Shell Test</a>');
    expect(bar).toContain('<a href="/c/SH-01">SH-01</a>');
    expect(bar).toContain('You are on Templar:</span> A basic, flawed defence. Find the gap.');
  });
});

describe('markup stays CSP-friendly and offline', () => {
  const pages = ['/', '/d/shell-test', '/c/SH-01', '/c/SH-01?r=wrong', '/scoreboard', '/d/shell-test/one', '/nope'];

  it.each(pages)('%s: no inline script, no event handler attribute, no style attribute or element', async (p) => {
    const html = (await get(p)).text;
    for (const m of html.matchAll(/<script\b([^>]*)>/gi)) expect(m[1], p).toMatch(/\ssrc="\/static\/[^"]+"/);
    expect(html, p).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
    expect(html, p).not.toMatch(/<[a-z][^>]*\sstyle\s*=/i);
    expect(html, p).not.toMatch(/<style[\s>]/i);
    expect(html, p).not.toMatch(/(?:src|href)="(?:https?:)?\/\//i);
  });

  it('every icon a page uses exists in the sprite, which is served locally', async () => {
    const sprite = await get('/static/icons.svg').buffer(true)
      .parse((res, cb) => { let d = ''; res.setEncoding('utf8'); res.on('data', (c: string) => { d += c; }); res.on('end', () => cb(null, d)); });
    expect(sprite.status).toBe(200);
    expect(sprite.headers['content-type']).toMatch(/image\/svg\+xml/);
    const ids = new Set([...String(sprite.body).matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]));
    const used = new Set<string>();
    for (const p of [...pages, '/c/SH-01/diff']) {
      for (const m of (await get(p)).text.matchAll(/<use href="\/static\/icons\.svg#([^"]+)">/g)) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(10);
    expect([...used].filter((u) => !ids.has(u))).toEqual([]);
  });

  it('serves the optional enhancement script locally, and the layout loads it deferred', async () => {
    const js = await get('/static/ui.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
    expect((await get('/')).text).toContain('<script src="/static/ui.js" defer></script>');
  });

  it('the shipped source of the sprite and the script make no network request', () => {
    const pub = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'public');
    for (const f of ['ui.js', 'icons.svg', 'app.css']) {
      const text = readFileSync(join(pub, f), 'utf8');
      expect(text, f).not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
      expect(text, f).not.toMatch(/\b(fetch|XMLHttpRequest|import)\s*\(/);
      expect(text, f).not.toMatch(/@import|url\(/);
    }
  });
});
