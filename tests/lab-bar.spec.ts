// The lab bar: the layout's player guidance on every challenge route (/d/<district>/<slug>).
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createApp } from '../src/app.js';
import { register, defineChallenge } from '../src/core/registry.js';
import { sendPage } from '../src/core/render.js';

const hello = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hello.ejs');
const LAB = '/d/lab-bar-test/fixture';

// Levels deliberately listed out of rank order; inquisitor is not implemented.
register(defineChallenge({
  id: 'LB-01', district: 'lab-bar-test', slug: 'fixture', dir: process.cwd(),
  title: { id: 'Judul <b>Lab</b>', en: 'Lab <b>Title</b>' },
  summary: { id: 'ringkasan-id <i>', en: 'summary-en <i>' },
  maps: [], levels: ['divine', 'templar', 'acolyte'], hints: [],
  mount: (router) => {
    router.get('/', (_req, res) => sendPage(res, hello, { name: 'lab body' }));
    router.get('/titled', (_req, res) => sendPage(res, hello, { name: 'x', title: 'Own Title' }));
    router.get('/sets-level', (_req, res) => sendPage(res, hello, { name: 'x', level: 'divine' }));
    router.get('/sets-challenge', (_req, res) => sendPage(res, hello, { name: 'x', challenge: { id: 'ZZ-99' } }));
  },
}));

const get = async (path: string) => {
  const res = await request(createApp()).get(path);
  return { status: res.status, html: res.text };
};
const bar = (html: string) => /<nav class="lab-bar"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
const switcher = (html: string) =>
  [...bar(html).matchAll(/<a href="([^"]+)" data-level="(\w+)"([^>]*)>([^<]*)<\/a>/g)]
    .map((m) => ({ href: m[1], level: m[2], current: m[3].includes('aria-current="page"'), label: m[4] }));

describe('lab bar (layout, challenge routes only)', () => {
  it('shows id, title, summary (current lang, escaped), level badge and back link', async () => {
    const { status, html } = await get(`${LAB}?level=templar&lang=en`);
    expect(status).toBe(200);
    const b = bar(html);
    expect(b).toContain('data-testid="lab-bar"');
    expect(b).toContain('LB-01');
    expect(b).toContain('Lab &lt;b&gt;Title&lt;/b&gt;');
    expect(b).toContain('summary-en &lt;i&gt;');
    expect(b).toMatch(/data-testid="lab-level"[^>]*data-level="templar"[^>]*>Templar</);
    expect(b).toContain('<a class="lab-bar-back" href="/c/LB-01">Back to challenge</a>');
    expect(html).toContain('<p id="hello">Districts lab body</p>'); // the view still renders
  });

  it('switcher: one link per implemented level, rank order, current marked, Divine = secure reference', async () => {
    const { html } = await get(`${LAB}?level=templar&lang=en`);
    expect(switcher(html)).toEqual([
      { href: `${LAB}?level=acolyte`, level: 'acolyte', current: false, label: 'Acolyte' },
      { href: `${LAB}?level=templar`, level: 'templar', current: true, label: 'Templar' },
      { href: `${LAB}?level=divine`, level: 'divine', current: false, label: 'Divine (secure reference)' },
    ]);
  });

  it('follows the clamped level (inquisitor is not implemented → templar)', async () => {
    const { html } = await get(`${LAB}?level=inquisitor&lang=en`);
    expect(bar(html)).toMatch(/data-testid="lab-level"[^>]*data-level="templar"/);
    expect(switcher(html).filter((l) => l.current).map((l) => l.level)).toEqual(['templar']);
  });

  it('is bilingual: Indonesian title, summary, back link and Divine label', async () => {
    const { html } = await get(`${LAB}?level=divine&lang=id`);
    const b = bar(html);
    expect(b).toContain('Judul &lt;b&gt;Lab&lt;/b&gt;');
    expect(b).toContain('ringkasan-id &lt;i&gt;');
    expect(b).toContain('>Kembali ke tantangan</a>');
    expect(switcher(html).find((l) => l.level === 'divine')).toMatchObject({ current: true, label: 'Divine (referensi aman)' });
    expect(b).toMatch(/aria-label="Ganti level"/);
  });

  it('default <title> is "<id> — <title>"; a view title still wins', async () => {
    expect((await get(`${LAB}?lang=en`)).html).toContain('<title>LB-01 — Lab &lt;b&gt;Title&lt;/b&gt;</title>');
    expect((await get(`${LAB}?lang=id`)).html).toContain('<title>LB-01 — Judul &lt;b&gt;Lab&lt;/b&gt;</title>');
    expect((await get(`${LAB}/titled`)).html).toContain('<title>Own Title</title>');
  });

  it('is absent from portal pages', async () => {
    for (const p of ['/', '/c/LB-01', '/scoreboard']) {
      const { status, html } = await get(p);
      expect(status, p).toBe(200);
      expect(html, p).not.toContain('data-testid="lab-bar"');
      expect(html, p).not.toContain('class="lab-bar"');
    }
  });

  it('a view cannot pass `level` or `challenge` (engine-owned) in its data', async () => {
    for (const p of ['/sets-level', '/sets-challenge']) {
      const { status, html } = await get(`${LAB}${p}`);
      expect(status, p).toBe(500);
      expect(html, p).not.toContain('ZZ-99');
    }
  });
});
