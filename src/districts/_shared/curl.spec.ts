// src/districts/_shared/curl.spec.ts — the curl example of every district's lab pages: curlFor, shellQuote and the
// curl-note partial.
import { fileURLToPath } from 'node:url';
import { renderFile } from 'ejs';
import type { Request, Response } from 'express';
import { describe, it, expect } from 'vitest';
import { curlFor, shellQuote, type CurlView } from './curl.js';

const fakeRes = () => ({ locals: { labPath: '/d/gatekeeper/x' } }) as unknown as Response;
const fakeReq = (level: string) => ({ protocol: 'http', level, sessionId: '11111111-1111-4111-8111-111111111111', get: () => '127.0.0.1:3000' }) as unknown as Request;

describe('curl helpers', () => {
  it('shellQuote closes and reopens a single quote', () => {
    expect(shellQuote("it's")).toBe("it'\\''s");
    expect(shellQuote("it's")).toHaveLength(7);
  });

  it('curlFor: method, JSON data and form fields; the sid is never in the data', () => {
    const base = curlFor(fakeReq('templar'), fakeRes(), { path: '/profile' });
    expect(base).toEqual({ url: 'http://127.0.0.1:3000/d/gatekeeper/x/profile?level=templar', method: '', headers: [], cookies: [], data: '', form: [] });
    const put = curlFor(fakeReq('divine'), fakeRes(), { path: '/p', method: 'PUT', headers: ['A: b'], data: `{"a":"it's"}`, form: { name: 'Brother Lamp', bio: "it's" } });
    expect(put.method).toBe('PUT');
    expect(put.data).toBe(`{"a":"it'\\''s"}`);
    expect(put.form).toEqual(['name=Brother Lamp', "bio=it'\\''s"]);
    expect(JSON.stringify(put)).not.toContain('11111111-1111');
  });

  it('curlFor: files add multipart -F entries (files in the order given, then the form fields); no files, no multipart key', () => {
    expect(curlFor(fakeReq('acolyte'), fakeRes(), { path: '/p', form: { a: 'b' } })).not.toHaveProperty('multipart');
    const m = curlFor(fakeReq('acolyte'), fakeRes(), {
      path: '', form: { caption: "it's", note: 'x' },
      files: [{ field: 'scroll', filename: './local-file', sendAs: '<name>', type: '<content type>' }, { field: 'extra', filename: 'b.txt' }],
    });
    expect(m.multipart).toEqual(['scroll=@./local-file;filename=<name>;type=<content type>', 'extra=@b.txt', "caption=it'\\''s", 'note=x']);
    expect(m.form).toEqual([]);
  });
});

const curlPartial = fileURLToPath(new URL('./views/curl-note.ejs', import.meta.url));

/** The curl partial itself: method, JSON data, form fields, quoting, the PowerShell note, and no session id. */
describe('curl-note partial', () => {
  const view = (c: Partial<CurlView>): CurlView => ({ url: 'http://127.0.0.1:3000/d/gatekeeper/x/p?level=acolyte', method: '', headers: [], cookies: [], data: '', form: [], ...c });
  const render = (c: CurlView) => renderFile(curlPartial, { curl: c }, { async: false });

  it('emits -X for a method, -d for JSON and --data-urlencode for form fields, in that order', async () => {
    const text = await render(view({ method: 'PUT', headers: ['Content-Type: application/json'], data: '{"a":"b"}', form: ['name=Brother Lamp', "bio=it'\''s"] }));
    expect(text).toContain(`curl -X PUT "http://127.0.0.1:3000/d/gatekeeper/x/p?level=acolyte" -H "Content-Type: application/json"`);
    expect(text).toContain(`-b "hvwa_sid=&lt;copy from devtools&gt;" -d '{&#34;a&#34;:&#34;b&#34;}' --data-urlencode 'name=Brother Lamp' --data-urlencode 'bio=it&#39;\&#39;&#39;s'`);
  });

  it('multipart entries render as -F after everything else, the placeholder and PowerShell note stay', async () => {
    const text = await render(view({ multipart: ['scroll=@./f;type=text/plain', "caption=it'\\''s"] }));
    expect(text).toContain(`-b "hvwa_sid=&lt;copy from devtools&gt;" -F 'scroll=@./f;type=text/plain' -F 'caption=it&#39;\\&#39;&#39;s'`);
    expect(text).toContain('curl sends exactly what you write');
    expect(text).toMatch(/PowerShell[\s\S]*<code>curl\.exe<\/code>/);
    expect(await render(view({}))).not.toContain('-F ');
  });

  it('says to sign in first by default; a lab without a sign-in (signIn: false) says to open the page instead', async () => {
    const SIGN_IN = 'Your lab belongs to your browser session: sign in here first, then copy the (HttpOnly) <code>hvwa_sid</code> cookie from the devtools storage into <code>-b</code>.';
    expect(await render(view({}))).toContain(SIGN_IN);
    expect(curlFor(fakeReq('acolyte'), fakeRes(), { path: '/cart' })).not.toHaveProperty('signIn');
    const shop = curlFor(fakeReq('acolyte'), fakeRes(), { path: '/cart', signIn: false });
    expect(shop.signIn).toBe(false);
    const text = await render(shop);
    expect(text).not.toContain('sign in');
    expect(text).toContain('Your lab belongs to your browser session: open this page in your browser, then copy the (HttpOnly) <code>hvwa_sid</code> cookie from the devtools storage into <code>-b</code>.');
  });

  it('no method, no body: a plain GET line; always the session placeholder and the PowerShell note', async () => {
    const text = await render(view({}));
    expect(text).toContain('curl "http://127.0.0.1:3000/d/gatekeeper/x/p?level=acolyte" -b "hvwa_sid=&lt;copy from devtools&gt;"');
    expect(text).not.toContain('-X');
    expect(text).not.toContain('-d ');
    expect(text).toMatch(/bash syntax[\s\S]*PowerShell[\s\S]*<code>curl\.exe<\/code>[\s\S]*Invoke-WebRequest/);
  });
});
