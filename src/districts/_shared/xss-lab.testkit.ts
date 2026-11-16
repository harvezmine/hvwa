// src/districts/_shared/xss-lab.testkit.ts — the tests and helpers the specs of server-sink XSS labs share, any district
// (SC-01, SC-02, SC-04, FP-05; docs/RECIPES.md section 13), modelled on tests/xss-lab.spec.ts (XV-01). The player reads
// the marker on the lab page, plants a payload and has the admin render it, reads the stolen key from the attacker log,
// and signs in with it.
// A test kit (docs/RECIPES.md section 1): `*.testkit.ts` is never collected as a spec and never reaches dist/.
import { parseFragment } from 'parse5';
import { describe, expect, it } from 'vitest';
import type request from 'supertest';
import { attackerHits, freshSession, unescapeHtml, type Agent, type ExploitLevel, type PanelHit } from '../../../tests/helpers.js';
import { LEVELS, type Level } from '../../core/levels.js';
import { XSS_STEAL_URL, xssOracle } from '../../core/xss.js';
import type { XssVictim } from './xss-lab.js';

// --- Reading the page as the player does ---------------------------------------------------------------------------

/** The player's marker call, as the lab page shows it (`<code data-marker>`). */
export const markerOn = (html: string): string => unescapeHtml(/<code data-marker>([^<]*)<\/code>/.exec(html)?.[1] ?? '');

/** The steals in the attacker log: `GET <XSS_STEAL_URL>?c=...`, oldest first. */
export const stealsOn = (html: string): PanelHit[] => attackerHits(html).filter((h) => h.url.startsWith(`${XSS_STEAL_URL}?`));

/** The session key the newest steal carried, or 'none'. */
export const stolenKey = (html: string): string => {
  const hit = stealsOn(html).at(-1);
  return hit === undefined ? 'none' : new URL(hit.url).searchParams.get('c') ?? 'none';
};

/** The preview frame's srcdoc document, as the browser decodes the attribute ('' when the page has none). */
export const previewSrcdoc = (html: string): string => {
  const frame = /<iframe class="xss-preview"[^>]*><\/iframe>/.exec(html)?.[0] ?? '';
  const el = parseFragment(frame).childNodes.find((n) => 'tagName' in n);
  return el !== undefined && 'attrs' in el ? el.attrs.find((a) => a.name === 'srcdoc')?.value ?? '' : '';
};

/** The proof form (views/xss-proof.ejs): sign in with a session key. */
export const signIn = (a: Agent, path: string, level: Level, key: string) =>
  a.post(`${path}?level=${level}`).type('form').send({ intent: 'sign-in', key });

/** The lab page in English. */
export const labPage = (a: Agent, path: string, level: Level, query = '') => a.get(`${path}?level=${level}&lang=en${query}`);

/**
 * An exploit as the player does it: read the marker on the lab page, `attack` with the payload made from it (plant it
 * and press the victim's button), read the stolen key from the attacker log, sign in with it. The last answer.
 */
export const xssExploit = (path: string, attack: (a: Agent, level: Level, payload: string) => Promise<unknown>) =>
  (payload: (marker: string) => string) => async (a: Agent, level: Level): Promise<request.Response> => {
    const marker = markerOn((await labPage(a, path, level)).text);
    await attack(a, level, payload(marker));
    return signIn(a, path, level, stolenKey((await labPage(a, path, level)).text));
  };

// --- Shared cases --------------------------------------------------------------------------------------------------

export interface XssLabSpec {
  readonly challenge: { readonly id: string; readonly levels: readonly Level[] };
  readonly path: string;
  /** Test seam: the victim side of session `sid` at `level` (its marker, key and the admin's browser). */
  readonly victimOf: (sid: string, level: Level) => XssVictim;
  /** Plant `payload` and have the admin render it, as the player does (the victim's button). */
  readonly attack: (a: Agent, level: Level, payload: string) => Promise<unknown>;
  /** The player's own lab page previewing `payload` (a stored lab plants it first). */
  readonly preview: (a: Agent, level: Level, payload: string) => Promise<request.Response>;
  /** The fragment the level builds for `payload`: the preview's one raw value, and what the admin's page holds. */
  readonly fragment: (level: Level, payload: string) => string;
  /** One working payload per exploitable level, made from the marker call. */
  readonly payloads: { readonly [L in ExploitLevel]?: (marker: string) => string };
}

const exploitable = (o: XssLabSpec): ExploitLevel[] => LEVELS.filter((l): l is ExploitLevel => l !== 'divine' && o.challenge.levels.includes(l));
const payloadsOf = (o: XssLabSpec): [ExploitLevel, (m: string) => string][] =>
  exploitable(o).flatMap((l) => { const p = o.payloads[l]; return p === undefined ? [] : [[l, p] as [ExploitLevel, (m: string) => string]]; });

/**
 * The XSS proof at every level: the preview runs only inside the sandboxed frame and holds exactly the level's
 * fragment; a payload that runs sends the admin's key to the player's server (one steal, no Referer); Divine's admin
 * sees the marker as text and nothing arrives; players and levels are isolated.
 */
export function describeXssLab(o: XssLabSpec): void {
  describe(`${o.challenge.id} XSS proof`, () => {
    it('your page runs the payload only inside the sandboxed preview: exactly the fragment the admin gets, isolated', async () => {
      const { agent, sid } = await freshSession();
      for (const [level, make] of payloadsOf(o)) {
        const { call } = o.victimOf(sid, level).marker;
        const payload = make(call);
        const fragment = o.fragment(level, payload);
        const res = await o.preview(agent, level, payload);
        expect(res.status, level).toBe(200);
        expect(previewSrcdoc(res.text).endsWith(`<body>${fragment}</body></html>`), level).toBe(true);
        expect(xssOracle(fragment, call).executes, `${level}: the fragment runs on the admin's page`).toBe(true);
        const v = xssOracle(res.text, call); // ...and on yours only where the frame isolates it
        expect(v.executes, level).toBe(false);
        expect(v.sinks.filter((s) => s.marker).length, level).toBeGreaterThan(0);
        expect(v.sinks.filter((s) => s.marker).every((s) => s.isolated), level).toBe(true);
        expect(res.text, `${level}: the payload is never raw on the platform page`).not.toContain(payload);
        expect(res.text, level).toContain('sandbox="allow-scripts"');
        expect(res.text, level).not.toContain('allow-same-origin');
      }
    });

    it('a payload that runs sends the admin\'s session key to your server: one GET to /steal, no Referer', async () => {
      for (const [level, make] of payloadsOf(o)) {
        const { agent, sid } = await freshSession();
        const victim = o.victimOf(sid, level);
        await o.attack(agent, level, make(victim.marker.call));
        const steals = stealsOn((await labPage(agent, o.path, level)).text);
        expect(steals.map((h) => [h.method, h.url, h.referer]), level).toEqual([['GET', `${XSS_STEAL_URL}?c=${victim.key}`, undefined]]);
        expect(victim.admin.verdicts.filter((v) => v.fired).length, level).toBe(1);
      }
    });

    it('divine: the admin sees your marker as text, and your server receives nothing', async () => {
      const { agent, sid } = await freshSession();
      const victim = o.victimOf(sid, 'divine');
      for (const [level, make] of payloadsOf(o)) {
        await o.attack(agent, 'divine', make(victim.marker.call));
        expect(attackerHits((await labPage(agent, o.path, 'divine')).text), `the ${level} payload`).toEqual([]);
        const verdicts = victim.admin.verdicts;
        expect(verdicts.length, level).toBeGreaterThan(0);
        expect(verdicts.every((v) => !v.fired), level).toBe(true);
        expect(verdicts.every((v) => v.page.limited === undefined), level).toBe(true);
        expect(verdicts.at(-1)?.page.reachedMarker, `${level}: the marker reached the admin's page as text`).toBe(true);
      }
    });

    it('isolates players and levels: your marker runs nowhere else', async () => {
      const [first] = payloadsOf(o);
      if (first === undefined) throw new Error(`${o.challenge.id}: describeXssLab needs at least one payload`);
      const [level, make] = first;
      const higher = exploitable(o).find((l) => l !== level) ?? 'divine';
      const a = await freshSession();
      const b = await freshSession(a.app);
      const markerA = o.victimOf(a.sid, level).marker.call;
      const mine = make(markerA);
      await o.attack(b.agent, level, mine); // B sends A's payload to B's admin
      expect(attackerHits((await labPage(b.agent, o.path, level)).text)).toEqual([]);
      // A's marker of one level, in the payload that works at another level: the wrong marker proves nothing there.
      await o.attack(a.agent, higher, (o.payloads[higher as ExploitLevel] ?? make)(markerA));
      expect(stealsOn((await labPage(a.agent, o.path, higher)).text)).toEqual([]);
      await o.attack(a.agent, level, mine);
      expect(stolenKey((await labPage(a.agent, o.path, level)).text)).toBe(o.victimOf(a.sid, level).key);
      expect(attackerHits((await labPage(b.agent, o.path, level)).text)).toEqual([]);
    });
  });
}
