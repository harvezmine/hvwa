// src/districts/_shared/victim-lab.testkit.ts — the tests and helpers the specs of victim-driven labs share (a simulated
// victim, docs/RECIPES.md section 8: GK-09, 10, 11, 16) and of the sign-in labs around them (GK-08). Any district: the
// Phase 2 victim labs (CSRF, CORS, XSS) use it too. Modelled on gatekeeper/_shared/pilgrim-lab.testkit.ts.
// A test kit (docs/RECIPES.md section 1): `*.testkit.ts` is never collected as a spec and never reaches dist/.
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import { FLAG_RE, describeLabView, freshSession, panelOf, setCookieHeader, type Agent } from '../../../tests/helpers.js';
import { LEVELS, type Level } from '../../core/levels.js';

/** The lab under test: the registered challenge and its canonical path, e.g. '/d/gatekeeper/session-fixation'. */
export interface VictimLabSpec {
  readonly challenge: { readonly id: string; readonly levels: readonly Level[] };
  readonly path: string;
}

const implemented = (o: VictimLabSpec): Level[] => LEVELS.filter((l) => o.challenge.levels.includes(l));
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// --- The player's moves ------------------------------------------------------------------------------------------

/** The victim's buttons as requests (POST <lab>/victim/<name>?level=, answered 303 back to the lab). */
export function victimClient(path: string) {
  return {
    /** "Send link to the admin": the victim opens `url`. */
    sendLink: (a: Agent, level: Level, url: string, action = 'send-link') =>
      a.post(`${path}/victim/${action}?level=${level}`).type('form').send({ url }),
    /** "Ask the admin to check mail". */
    checkMail: (a: Agent, level: Level, action = 'check-mail') => a.post(`${path}/victim/${action}?level=${level}`),
  };
}

/**
 * Your real browser on a lab URL: it follows each redirect (sendSimRedirect keeps every one in the lab), at most
 * `maxHops` of them. The last answer and the URL it came from.
 */
export async function browse(a: Agent, url: string, maxHops = 6): Promise<{ readonly res: request.Response; readonly at: string }> {
  let at = url;
  let res = await a.get(at);
  for (let i = 0; i < maxHops && res.status >= 300 && res.status < 400; i++) {
    at = String(res.headers.location);
    res = await a.get(at);
  }
  return { res, at };
}

// --- What the real browser is shown ------------------------------------------------------------------------------

/** The forward note (core/views/forward-note.ejs) a page shows the real browser instead of moving on ('' when none). */
export const forwardNoteOf = (html: string): string => /<p class="lab-note" data-testid="forward-note">[\s\S]*?<\/p>/.exec(html)?.[0] ?? '';

/** The page sendSimRedirect shows for a Location off the lab (core/views/sim-away.ejs; '' when none). */
export const awayOf = (html: string): string => /<section class="sim-away"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';

/** Your real browser stays where it is: 200, no Location, no Refresh. */
export function expectNoWayOut(res: request.Response, label = ''): void {
  expect(res.status, label).toBe(200);
  expect(res.headers.location, label).toBeUndefined();
  expect(res.headers.refresh, label).toBeUndefined();
}

/**
 * A redirect that keeps your real browser in the lab (sendSimRedirect's citadel case): a redirect status whose Location
 * is under `path`, at the served `level` (labHref sets `level=`). Returns the Location, for the lab's own checks.
 */
export function expectInLab(res: request.Response, path: string, level: Level, label = ''): string {
  expect([301, 302, 303, 307, 308], label).toContain(res.status);
  const location = String(res.headers.location ?? '');
  expect(location, label).toMatch(new RegExp(`^${escapeRe(path)}[/?]`));
  expect(new URL(location, 'http://lab.invalid').searchParams.getAll('level'), label).toEqual([level]);
  return location;
}

/**
 * sendSimRedirect's page for a Location off the lab: no way out (200, no Location, no Refresh), and the target shown
 * as text, never as a link. Returns the page's sim-away section, for the lab's own checks.
 */
export function expectAwayPage(res: request.Response, label = ''): string {
  expectNoWayOut(res, label);
  const away = awayOf(res.text);
  expect(away, label).not.toBe('');
  expect(away, label).not.toMatch(/href=/);
  return away;
}

// --- Shared cases --------------------------------------------------------------------------------------------------

/**
 * describeLabView (tests/helpers.ts) for a lab whose front page signs in with a username and a password
 * (POST <lab>?level=): the player's own account (default pilgrim/pilgrim) works, a wrong password fails.
 */
export function describeSignInView(o: VictimLabSpec & { readonly account?: { readonly username: string; readonly password: string } }): void {
  const { username, password } = o.account ?? { username: 'pilgrim', password: 'pilgrim' };
  const signIn = (a: Agent, level: Level, pw: string) => a.post(`${o.path}?level=${level}`).type('form').send({ username, password: pw });
  describeLabView({
    challenge: o.challenge, path: o.path, account: new RegExp(`${escapeRe(username)}</code> / <code>${escapeRe(password)}`),
    echoField: 'username', extra: { password: 'x' },
    oddBodies: [{ username: { toString: 1 }, password: ['a'] }, [1, 2], {}],
    ok: (a, level) => signIn(a, level, password),
    bad: (a, level) => signIn(a, level, password === 'nope' ? 'wrong' : 'nope'),
  });
}

/** What the victim's button says it does (VictimAction.description), as the panel shows it (escaped: write ' as &#39;). */
export interface VictimActionText {
  readonly description: { readonly en: string; readonly id: string };
  /** The button text, when the lab has its own (VictimAction.label). */
  readonly label?: { readonly en?: string; readonly id?: string };
}

/** The panel under the lab says what the victim does, in both languages, at every implemented level. */
export function describeVictimAction(o: VictimLabSpec & VictimActionText): void {
  describe(`${o.challenge.id} victim action`, () => {
    it('the victim action says what the admin does, in both languages', async () => {
      const { agent } = await freshSession();
      for (const level of implemented(o)) {
        for (const lang of ['en', 'id'] as const) {
          const panel = panelOf((await agent.get(`${o.path}?level=${level}&lang=${lang}`)).text);
          expect(panel, `${level} ${lang}`).toContain(o.description[lang]);
          const label = o.label?.[lang];
          if (label !== undefined) expect(panel, `${level} ${lang}`).toContain(label);
        }
      }
    });
  });
}

/** One lab cookie for describeLabCookies. */
export interface LabCookieSpec {
  /** Its name at `level`: one name per level (levels share the lab path). */
  readonly name: (level: Level) => string;
  /** A request that sets it, sent to `base`: the lab path in upper case, so the cookie must still get the canonical path. */
  readonly set: (agent: Agent, level: Level, base: string) => PromiseLike<request.Response>;
  /** Whether it must be HttpOnly (default true: a session id). */
  readonly httpOnly?: boolean;
}

/** Every lab cookie is named per level, on the canonical lab path (from an upper-case URL), and HttpOnly unless said. */
export function describeLabCookies(o: VictimLabSpec & { readonly cookies: readonly LabCookieSpec[] }): void {
  describe(`${o.challenge.id} lab cookies`, () => {
    it('cookies are named per level, on the canonical lab path, HttpOnly', async () => {
      const { agent } = await freshSession();
      const levels = implemented(o);
      for (const c of o.cookies) {
        expect(new Set(levels.map(c.name)).size, c.name(levels[0])).toBe(levels.length);
        for (const level of levels) {
          const line = setCookieHeader(await c.set(agent, level, o.path.toUpperCase()), c.name(level));
          expect(line, `${level} ${c.name(level)}`).toBeDefined();
          expect(line, level).toMatch(new RegExp(`; Path=${escapeRe(o.path)}(;|$)`));
          if (c.httpOnly ?? true) expect(line, level).toMatch(/; HttpOnly/i);
          else expect(line, level).not.toMatch(/; HttpOnly/i);
        }
      }
    });
  });
}

/** Odd request bodies (JSON objects, arrays, nested values) for the forms besides the front page's. */
export const ODD_BODIES: readonly unknown[] = Object.freeze([
  { email: { toString: 1 }, token: ['a'], password: { a: 1 } }, { username: { toString: 1 }, password: ['a'] }, [1, 2], {},
]);

/**
 * Odd bodies on a lab's other forms (`forms`: paths below the lab, e.g. '/forgot') are a failed request at every level:
 * one of `statuses` (default 200; add 303 for a form that redirects), never a 500 or a flag.
 */
export function describeOddBodies(o: VictimLabSpec & { readonly forms: readonly string[]; readonly statuses?: readonly number[]; readonly bodies?: readonly unknown[] }): void {
  const statuses = o.statuses ?? [200];
  describe(`${o.challenge.id} odd bodies`, () => {
    it(`odd bodies on the ${o.forms.join(' and ')} forms are a failed request, never a 500 or a flag`, async () => {
      const { agent } = await freshSession();
      for (const level of implemented(o)) {
        for (const form of o.forms) {
          for (const body of o.bodies ?? ODD_BODIES) {
            const res = await agent.post(`${o.path}${form}?level=${level}`).send(body as object);
            expect(statuses, `${level} ${form} ${JSON.stringify(body)}`).toContain(res.status);
            expect(res.text ?? '', `${level} ${form}`).not.toMatch(FLAG_RE);
          }
        }
      }
    });
  });
}
