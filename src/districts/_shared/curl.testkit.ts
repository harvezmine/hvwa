// src/districts/_shared/curl.testkit.ts — the curl-example check every lab page with a curl line shares, any district.
// A test kit (docs/RECIPES.md section 1): `*.testkit.ts` is never collected as a spec and never reaches dist/.
import { describe, it, expect } from 'vitest';
import { freshSession } from '../../../tests/helpers.js';
import { LEVELS, type Level } from '../../core/levels.js';
import { shellQuote } from './curl.js';

/** EJS's own escaping of an output value. */
const escapeXML = (v: string): string => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&#34;').replace(/'/g, '&#39;');

/** The curl example a lab page must show at one level. */
export interface ExpectedCurl {
  readonly path: string;
  readonly method?: string;
  readonly headers?: readonly string[];
  readonly cookies?: readonly string[];
  readonly data?: string;
  /** Form fields as 'name=value'. */
  readonly form?: readonly string[];
}

export interface CurlExampleSpec {
  readonly challenge: { readonly id: string; readonly levels: readonly Level[] };
  /** The lab's base path, e.g. '/d/gatekeeper/idor-profile'. */
  readonly path: string;
  /** The curl line the front page must show at `level`. */
  readonly curl: (level: Level) => ExpectedCurl;
}

/** The front page's curl line, at every implemented level: one a player can use as written. */
export function describeCurlExample(o: CurlExampleSpec): void {
  describe(`${o.challenge.id} curl example`, () => {
    it('the front page gives a curl line that can work: full quoted URL, the headers it needs, the session cookie to copy, never its value', async () => {
      for (const level of LEVELS.filter((l) => o.challenge.levels.includes(l))) {
        const { agent, sid } = await freshSession();
        const res = await agent.get(`${o.path}?level=${level}`);
        const e = o.curl(level);
        const headers = (e.headers ?? []).map((h) => ` -H "${escapeXML(h)}"`).join('');
        const cookies = (e.cookies ?? []).map((c) => `; ${escapeXML(c)}`).join('');
        const data = (e.data ? ` -d '${escapeXML(shellQuote(e.data))}'` : '')
          + (e.form ?? []).map((f) => ` --data-urlencode '${escapeXML(shellQuote(f))}'`).join('');
        const want = `curl${e.method ? ` -X ${e.method}` : ''} "http://127.0.0.1${o.path}${escapeXML(e.path)}?level=${level}"${headers} -b "hvwa_sid=&lt;copy from devtools&gt;${cookies}"${data}`;
        expect(res.text.replace(/curl "http:\/\/[^/"\s]+/, 'curl "http://127.0.0.1'), level).toContain(want);
        expect(res.text, level).toMatch(/hvwa_sid<\/code> cookie from the devtools storage/);
        expect(res.text, level).toContain('<code>curl.exe</code>');
        expect(res.text, level).not.toContain(sid);
      }
    });
  });
}
