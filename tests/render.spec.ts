import { describe, it, expect } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { diffView, page, sendPage, RESERVED_VIEW_KEYS } from '../src/core/render.js';
import { langMiddleware } from '../src/core/i18n.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hello.ejs');

function rowKinds(html: string): string[] {
  return [...html.matchAll(/<tr class="diff-(same|add|del|changed)"/g)].map((m) => m[1]);
}

describe('diffView (LCS)', () => {
  it('one inserted line does not mark the following identical lines as changed', () => {
    const html = diffView('a\nb\nc\nd', 'a\nINSERTED\nb\nc\nd', 'en');
    expect(rowKinds(html)).toEqual(['same', 'add', 'same', 'same', 'same']);
  });

  it('aligns a deleted line on the vulnerable side', () => {
    const html = diffView('a\nGONE\nb\nc', 'a\nb\nc', 'en');
    expect(rowKinds(html)).toEqual(['same', 'del', 'same', 'same']);
  });

  it('pairs a replaced line as a single changed row', () => {
    const html = diffView('a\nquery(`${x}`)\nc', 'a\nquery(?, [x])\nc', 'en');
    expect(rowKinds(html)).toEqual(['same', 'changed', 'same']);
  });

  it('treats CRLF like LF and ignores a single trailing newline', () => {
    expect(rowKinds(diffView('a\r\nb\r\n', 'a\nb', 'en'))).toEqual(['same', 'same']);
  });

  it('escapes HTML in source lines', () => {
    const html = diffView('<script>alert(1)</script>', '&amp; "q"', 'en');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&amp;amp; &quot;q&quot;');
  });

  it('localises the column headers', () => {
    const en = diffView('a', 'b', 'en');
    const id = diffView('a', 'b', 'id');
    expect(en).toContain('Vulnerable');
    expect(en).toContain('Secure');
    expect(id).toContain('Rentan');
    expect(id).toContain('Aman');
  });
});

describe('page()', () => {
  it('renders a view inside the shared layout using res.locals lang/t', async () => {
    const app = express();
    app.use(cookieParser());
    app.use(langMiddleware());
    app.get('/', async (_req, res) => {
      res.send(await page(res, fixture, { title: 'T', name: '<b>world</b>' }));
    });
    const en = await request(app).get('/?lang=en');
    expect(en.text).toMatch(/^<!doctype html>/i);
    expect(en.text).toContain('<html lang="en">');
    expect(en.text).toContain('<p id="hello">Districts &lt;b&gt;world&lt;/b&gt;</p>');
    const id = await request(app).get('/?lang=id');
    expect(id.text).toContain('<p id="hello">Distrik');
  });
});

describe('page() resists EJS option injection through data', () => {
  const MARKER = '__hvwaEjsInjected';
  const payload = `function(){};globalThis.${MARKER}=1;`;
  const g = globalThis as Record<string, unknown>;

  function appWith(handler: (req: express.Request, res: express.Response) => Promise<string>) {
    const app = express();
    app.use(express.urlencoded({ extended: true })); // same parser as createApp
    app.use(cookieParser());
    app.use(langMiddleware());
    app.all('/', async (req, res) => { res.send(await handler(req, res)); });
    return app;
  }

  function expectNormal(html: string) {
    expect(g[MARKER]).toBeUndefined();
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<p id="hello">Distrik &lt;b&gt;x&lt;/b&gt;</p>');
    expect(html).not.toContain('<%');
  }

  it('ignores settings["view options"] (client + escapeFunction) in data', async () => {
    delete g[MARKER];
    const app = appWith((_req, res) => page(res, fixture, {
      name: '<b>x</b>',
      settings: { 'view options': { client: true, escapeFunction: payload } },
    }));
    expectNormal((await request(app).get('/')).text);
  });

  // ejs 3.1.10 honours these top-level data keys as options in the two-argument
  // renderFile form (its _OPTS_PASSABLE_WITH_DATA list), so each one fails this
  // test against the vulnerable form: delimiter changes parsing, async makes
  // the body a Promise.
  it.each([
    ['delimiter', { delimiter: '?' }],
    ['async', { async: true }],
  ])('a top-level %s key in data cannot change how the view renders', async (_key, extra) => {
    const app = appWith((_req, res) => page(res, fixture, { name: '<b>x</b>', ...extra }));
    const html = (await request(app).get('/')).text;
    expectNormal(html);
    expect(html).not.toContain('[object Promise]');
  });

  it('is safe when a handler spreads an extended-urlencoded body into data', async () => {
    delete g[MARKER];
    const app = appWith((req, res) => page(res, fixture, { ...req.body }));
    const res = await request(app).post('/').type('form').send(
      'name=%3Cb%3Ex%3C%2Fb%3E' +
      '&settings[view options][client]=1' +
      `&settings[view options][escapeFunction]=${encodeURIComponent(payload)}`,
    );
    expectNormal(res.text);
  });
});

describe('page() / sendPage() guards', () => {
  function appWith(handler: (req: express.Request, res: express.Response) => Promise<void>) {
    const app = express();
    app.use(cookieParser());
    app.use(langMiddleware());
    app.get('/', async (req, res) => { await handler(req, res); });
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ message: err.message });
    });
    return app;
  }

  it('reserves exactly the keys ejs and the layout depend on', () => {
    expect([...RESERVED_VIEW_KEYS].sort()).toEqual(
      ['__append', '__output', 'body', 'escapeFn', 'include', 'lang', 'locals', 'rethrow', 't'].sort());
  });

  it.each(['escapeFn', 'include', 'rethrow', '__append', '__output', 'locals', 'body', 't', 'lang'])(
    'rejects reserved data key %s', async (key) => {
      const app = appWith(async (_req, res) => { res.send(await page(res, fixture, { name: 'x', [key]: 'y' })); });
      const res = await request(app).get('/');
      expect(res.status).toBe(500);
      expect(res.body.message).toMatch(new RegExp(`reserved.*"${key}"`));
    });

  it('rejects a view path that does not end in .ejs', async () => {
    const app = appWith(async (_req, res) => { res.send(await page(res, fixture.replace(/\.ejs$/, '.html'))); });
    expect((await request(app).get('/')).body.message).toMatch(/\.ejs/);
  });

  it('rejects a relative view path', async () => {
    const app = appWith(async (_req, res) => { res.send(await page(res, 'tests/fixtures/hello.ejs', { name: 'x' })); });
    expect((await request(app).get('/')).body.message).toMatch(/absolute/);
  });

  it('sendPage() renders inside the layout and sends HTML', async () => {
    const app = appWith(async (_req, res) => { await sendPage(res, fixture, { name: '<i>w</i>' }); });
    const res = await request(app).get('/?lang=en');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('<p id="hello">Districts &lt;i&gt;w&lt;/i&gt;</p>');
  });
});
