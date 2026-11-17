// src/districts/archive-api/_shared/api-lab.testkit.ts — what every Archive API lab's spec repeats: the landing page's
// endpoint table, the player's key and the curl note. A test kit (docs/RECIPES.md section 1): `*.testkit.ts` is never
// collected as a spec and never reaches dist/.
import { describe, it, expect } from 'vitest';
import { freshSession } from '../../../../tests/helpers.js';
import { LEVELS, type Level } from '../../../core/levels.js';

/** One row the landing page's endpoint table must have. */
export interface ExpectedEndpoint { readonly method: string; readonly path: string; readonly auth: 'none' | 'bearer' }

export interface ApiLandingSpec {
  readonly challenge: { readonly id: string; readonly levels: readonly Level[] };
  /** The lab's base path, e.g. '/d/archive-api/api-v1-alive'. */
  readonly path: string;
  /** The rows of the endpoint table, in order (path below the lab). */
  readonly endpoints: readonly ExpectedEndpoint[];
}

const KEY = /<code data-testid="api-key">(ak_pilgrim_[0-9a-f]{32})<\/code>/;

/**
 * The landing page of an API lab, at every implemented level: GET / answers 200 HTML with the endpoint table (method,
 * path below the lab, auth), the player's own key (per session and level, stable on a reload, never the session id), the
 * curl note for a lab nobody signs in to, and only forms that post back with no `action`.
 */
export function describeApiLanding(o: ApiLandingSpec): void {
  const levels = LEVELS.filter((l) => o.challenge.levels.includes(l));
  describe(`${o.challenge.id} API landing page`, () => {
    it('lists every endpoint with its method, path and auth', async () => {
      const { agent } = await freshSession();
      for (const level of levels) {
        const res = await agent.get(`${o.path}?level=${level}`);
        expect(res.status, level).toBe(200);
        expect(res.headers['content-type'], level).toMatch(/text\/html/);
        const rows = [...res.text.matchAll(/<tr data-method="([^"]*)" data-path="([^"]*)" data-auth="([^"]*)">/g)]
          .map((m) => ({ method: m[1], path: m[2], auth: m[3] }));
        expect(rows, level).toEqual(o.endpoints.map((e) => ({ method: e.method, path: e.path, auth: e.auth })));
        expect(res.text, level).toContain('data-testid="endpoints"');
      }
    });

    it('shows the player\'s own API key: stable on a reload, different per level and per player, never the session id', async () => {
      const a = await freshSession();
      const b = await freshSession();
      const seen = new Set<string>();
      for (const level of levels) {
        const first = await a.agent.get(`${o.path}?level=${level}`);
        const key = KEY.exec(first.text)?.[1];
        expect(key, level).toBeDefined();
        expect(first.text, level).toContain('Your API key');
        expect(KEY.exec((await a.agent.get(`${o.path}?level=${level}`)).text)?.[1], level).toBe(key);
        expect(first.text, level).not.toContain(a.sid);
        seen.add(key ?? '');
        seen.add(KEY.exec((await b.agent.get(`${o.path}?level=${level}`)).text)?.[1] ?? '');
      }
      expect(seen.size).toBe(levels.length * 2);
    });

    it('gives a curl line for a lab nobody signs in to, and forms that post back with no action', async () => {
      const { agent, sid } = await freshSession();
      for (const level of levels) {
        const res = await agent.get(`${o.path}?level=${level}`);
        expect(res.text, level).toContain(`${o.path}?level=${level}"`);
        expect(res.text, level).toMatch(/<code>curl "http:\/\//);
        expect(res.text, level).toContain('open this page in your browser');
        expect(res.text, level).toContain('<code>curl.exe</code>');
        expect(res.text, level).not.toContain(sid);
        const forms = [...res.text.matchAll(/<form[^>]*>/g)].map((m) => m[0])
          .filter((f) => !f.includes('lab-restart') && !f.includes('class="sim-action"'));
        for (const f of forms) expect(f, level).not.toMatch(/\saction=/);
      }
    });
  });
}
