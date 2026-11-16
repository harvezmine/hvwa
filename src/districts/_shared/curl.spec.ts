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

  it('no method, no body: a plain GET line; always the session placeholder and the PowerShell note', async () => {
    const text = await render(view({}));
    expect(text).toContain('curl "http://127.0.0.1:3000/d/gatekeeper/x/p?level=acolyte" -b "hvwa_sid=&lt;copy from devtools&gt;"');
    expect(text).not.toContain('-X');
    expect(text).not.toContain('-d ');
    expect(text).toMatch(/bash syntax[\s\S]*PowerShell[\s\S]*<code>curl\.exe<\/code>[\s\S]*Invoke-WebRequest/);
  });
});
