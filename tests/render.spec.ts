import { describe, it, expect } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { diffView, page } from '../src/core/render.js';
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
