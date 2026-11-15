// tests/helpers.ts — shared test utilities.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { LEVELS, type Level } from '../src/core/levels.js';
import type { Challenge } from '../src/core/registry.js';

/** Flag secret used by tests that pass one explicitly (>= 16 chars, like FLAG_SECRET). */
export const TEST_SECRET = 'hvwa-test-flag-secret';

/** A flag as issueFlag() formats it. */
export const FLAG_RE = /HVWA\{[0-9a-f]{32}\}/;

/** Text that betrays a database error (tryDb's message below Divine, or raw SQLite wording). */
export const DB_ERROR_RE = /Database error|syntax error|unrecognized token|SQLITE_/i;

function setCookieLines(res: request.Response): string[] {
  const raw: unknown = res.headers['set-cookie'];
  if (Array.isArray(raw)) return raw.map(String);
  return typeof raw === 'string' ? [raw] : [];
}

/** Full Set-Cookie line for cookie `name`, or undefined if the response did not set it. */
export function setCookieHeader(res: request.Response, name: string): string | undefined {
  return setCookieLines(res).find((line) => line.startsWith(`${name}=`));
}

/** Decoded value of cookie `name` from the response's Set-Cookie headers. */
export function setCookieValue(res: request.Response, name: string): string | undefined {
  const line = setCookieHeader(res, name);
  return line === undefined ? undefined : decodeURIComponent(line.slice(name.length + 1).split(';')[0]);
}

/**
 * A supertest agent on `app` (default: a fresh app with TEST_SECRET) whose
 * session is established by its first request; the sid is read from the
 * hvwa_sid cookie by name.
 */
export async function freshSession(app: Express = createApp({ flagSecret: TEST_SECRET })) {
  const agent = request.agent(app);
  const res = await agent.get('/healthz');
  const sid = setCookieValue(res, 'hvwa_sid');
  if (!sid) throw new Error('first response did not set hvwa_sid');
  return { app, agent, sid };
}

/**
 * Requests that carry ONLY the session cookie (plus `extraCookies`, e.g. 'lab_sid=abc'), like curl
 * without a cookie jar: nothing the lab previously set is replayed. (The agent's jar always wins
 * over a Cookie header set by hand, so use this to send a cookie the lab did not give you.)
 */
export function bare(app: Express, sid: string, extraCookies = '') {
  const cookie = extraCookies === '' ? `hvwa_sid=${sid}` : `hvwa_sid=${sid}; ${extraCookies}`;
  return {
    get: (url: string) => request(app).get(url).set('Cookie', cookie),
    post: (url: string) => request(app).post(url).set('Cookie', cookie),
  };
}

/** A supertest agent with an established session (from freshSession). */
export type Agent = Awaited<ReturnType<typeof freshSession>>['agent'];
/** Expected response text: a substring, or a pattern. */
export type Expectation = string | RegExp;
/** A level that can be exploited (and so issues a flag). */
export type ExploitLevel = Exclude<Level, 'divine'>;

/**
 * The exploit matrix every challenge spec declares (see docs/RECIPES.md).
 * `I` is whatever one submission is for this lab (e.g. { username, password }).
 */
export interface ExploitMatrix<I> {
  /** The registered challenge; its implemented levels drive the matrix. Must implement Divine. */
  readonly challenge: Pick<Challenge, 'id' | 'levels'>;
  /** The lab's base path, e.g. '/d/gatekeeper/sqli-login'. */
  readonly path: string;
  /**
   * Submit `input` to the lab at `level`. `url` is `${path}?level=${level}`; `ctx.sid` is the
   * session id of this case's fresh session (for per-session test seams such as a secret) and
   * `ctx.app` its app (for `bare(ctx.app, ctx.sid)` requests that carry no other cookie).
   * May send several requests (a scenario) and return the last response.
   */
  readonly send: (
    agent: Agent, level: Level, input: I, url: string, ctx: { readonly sid: string; readonly app: Express },
  ) => PromiseLike<request.Response>;
  /** One working exploit per exploitable level: keys must equal the challenge's non-Divine levels. */
  readonly exploits: { readonly [L in ExploitLevel]?: I };
  /**
   * What Divine answers to every exploit (proves it resisted, not just withheld the flag).
   * One value for all exploits, or a map keyed by the EXPLOIT's level when Divine's
   * answer differs per exploit (every exploitable level needs an entry then).
   */
  readonly resisted: Expectation | { readonly [L in ExploitLevel]?: Expectation };
  /** Ordinary use: works at every level, never shows a flag. At least one. */
  readonly legit: readonly { readonly name: string; readonly input: I; readonly expect: Expectation }[];
  /** Inputs that break the query: a DB error at each listed level, none at Divine. [] if not applicable. */
  readonly malformed: readonly { readonly name: string; readonly input: I; readonly levels: readonly ExploitLevel[] }[];
  /** A real privileged login at Divine: works, never a flag. null if the lab has no such identity. */
  readonly privileged: { readonly name: string; readonly input: I; readonly expect: Expectation } | null;
  /**
   * Levels where the exploits from below legitimately still work, so the
   * step-up case (g) is skipped for them. Explicit and rare: say why in the spec.
   */
  readonly cumulative?: readonly ExploitLevel[];
  /** What counts as leaked error text in (c) and (d). Default DB_ERROR_RE (e.g. /Parser error/ for XML labs). */
  readonly errorRe?: RegExp;
}

/** One generated test case: a name that says the level, and its body. */
export interface MatrixCase { readonly name: string; readonly run: () => Promise<void> }

function expectText(text: string, e: Expectation, label: string): void {
  if (typeof e === 'string') expect(text, label).toContain(e);
  else expect(text, label).toMatch(e);
}

/**
 * The cases describeExploitMatrix() registers, as plain data (so the helper
 * itself can be tested). Throws if the matrix cannot be run meaningfully.
 *  (a) exploits cover exactly the non-Divine levels
 *  (b) each exploit at its level shows a flag that /api/submit credits at exactly that level
 *  (c) Divine answers every exploit with 200, the `resisted` text (for that exploit's level),
 *      no flag, no DB-error text
 *  (d) each malformed input shows DB-error text at its levels, and none (200, no flag) at Divine
 *  (e) each legit input works at every level: 200, expected text, no flag
 *  (f) the privileged input works at Divine: 200, expected text, no flag
 *  (g) step-up: the exploit for level L is resisted (no flag) at EVERY implemented
 *      exploitable level above L, unless that level is listed in `cumulative`
 *      (Divine is already covered by (c))
 * "Error text" means `errorRe` (default DB_ERROR_RE).
 */
export function exploitMatrixCases<I>(m: ExploitMatrix<I>): MatrixCase[] {
  const { challenge: c } = m;
  const at = `exploit matrix ${c.id}`;
  if (!c.levels.includes('divine')) throw new Error(`${at}: the challenge has no Divine level to prove resistance against`);
  if (m.legit.length === 0) throw new Error(`${at}: needs at least one legit case`);
  const exploitable = LEVELS.filter((l): l is ExploitLevel => l !== 'divine' && c.levels.includes(l));
  for (const mc of m.malformed) {
    if (mc.levels.length === 0 || mc.levels.some((l) => !exploitable.includes(l))) {
      throw new Error(`${at}: malformed "${mc.name}" must list implemented non-Divine levels (got ${mc.levels.join(', ') || 'none'})`);
    }
  }
  const cumulative = m.cumulative ?? [];
  for (const l of cumulative) {
    if (exploitable.indexOf(l) < 1) {
      throw new Error(`${at}: cumulative "${l}" must be an implemented non-Divine level with an exploitable level below it`);
    }
  }
  const errorRe = m.errorRe ?? DB_ERROR_RE;
  const isMap = typeof m.resisted === 'object' && !(m.resisted instanceof RegExp);
  const resistedFor = (level: ExploitLevel): Expectation => {
    if (!isMap) return m.resisted as Expectation;
    const e = (m.resisted as { readonly [L in ExploitLevel]?: Expectation })[level];
    if (e === undefined) throw new Error(`${at}: resisted has no entry for the ${level} exploit`);
    return e;
  };
  if (isMap) for (const l of exploitable) resistedFor(l);
  const implemented = LEVELS.filter((l) => c.levels.includes(l));
  const send = async (level: Level, input: I) => {
    const { agent, sid, app } = await freshSession();
    const res = await m.send(agent, level, input, `${m.path}?level=${level}`, { sid, app });
    return { agent, res, text: res.text ?? '' };
  };
  const cases: MatrixCase[] = [];
  const add = (name: string, run: () => Promise<void>) => { cases.push({ name, run }); };

  add(`exploits cover exactly the exploitable levels (${exploitable.join(', ')})`, async () => {
    const keys = LEVELS.filter((l) => Object.hasOwn(m.exploits, l));
    expect(keys).toEqual(exploitable);
  });

  for (const level of exploitable) {
    const input = m.exploits[level];
    if (input === undefined) continue; // reported by the coverage case
    add(`${level}: exploit reveals a flag credited at ${level}`, async () => {
      const { agent, text } = await send(level, input);
      const flag = FLAG_RE.exec(text)?.[0];
      expect(flag, `no flag in the ${level} response`).toBeDefined();
      const submit = await agent.post('/api/submit').send({ challengeId: c.id, submission: flag });
      expect(submit.body, `flag shown at ${level} must be credited at ${level}`).toMatchObject({ solved: true, level });
    });
    add(`divine resists the ${level} exploit`, async () => {
      const { res, text } = await send('divine', input);
      expect(res.status).toBe(200);
      expect(text, 'divine showed a flag').not.toMatch(FLAG_RE);
      expect(text, 'divine showed error text').not.toMatch(errorRe);
      expectText(text, resistedFor(level), 'divine did not answer with the resisted text');
    });
    for (const higher of exploitable.slice(exploitable.indexOf(level) + 1)) {
      if (cumulative.includes(higher)) continue;
      add(`${higher} resists the ${level} exploit (step-up)`, async () => {
        const { text } = await send(higher, input);
        expect(text, `${higher} accepted the ${level} exploit (showed a flag): it is no harder than ${level}`)
          .not.toMatch(FLAG_RE);
      });
    }
  }

  for (const mc of m.malformed) {
    for (const level of exploitable.filter((l) => mc.levels.includes(l))) {
      add(`${level}: malformed "${mc.name}" shows error text`, async () => {
        const { text } = await send(level, mc.input);
        expect(text, `no error text at ${level}`).toMatch(errorRe);
      });
    }
    add(`divine: malformed "${mc.name}" shows no error text`, async () => {
      const { res, text } = await send('divine', mc.input);
      expect(res.status).toBe(200);
      expect(text, 'divine leaked error text').not.toMatch(errorRe);
      expect(text, 'divine showed a flag').not.toMatch(FLAG_RE);
    });
  }

  for (const lc of m.legit) {
    for (const level of implemented) {
      add(`${level}: legit "${lc.name}" works without a flag`, async () => {
        const { res, text } = await send(level, lc.input);
        expect(res.status).toBe(200);
        expect(text, `legit use showed a flag at ${level}`).not.toMatch(FLAG_RE);
        expectText(text, lc.expect, `legit "${lc.name}" at ${level}`);
      });
    }
  }

  const p = m.privileged;
  if (p) {
    add(`divine: privileged "${p.name}" works without a flag`, async () => {
      const { res, text } = await send('divine', p.input);
      expect(res.status).toBe(200);
      expect(text, 'divine issued a flag').not.toMatch(FLAG_RE);
      expectText(text, p.expect, `privileged "${p.name}" at divine`);
    });
  }
  return cases;
}

/**
 * Register a challenge's exploit matrix as named vitest cases (see
 * exploitMatrixCases for what each one proves). Each case runs in a fresh
 * session on a fresh app, so a failure names exactly one level and input.
 */
export function describeExploitMatrix<I>(m: ExploitMatrix<I>): void {
  const cases = exploitMatrixCases(m);
  describe(`${m.challenge.id} exploit matrix`, () => {
    for (const c of cases) it(c.name, c.run);
  });
}

/** What describeLabView() needs to know about a lab. */
export interface LabViewSpec {
  readonly challenge: Pick<Challenge, 'id' | 'levels'>;
  readonly path: string;
  /** Matches the notice that tells the player their own account. */
  readonly account: RegExp;
  /** The text field a typed payload is kept in after a POST, and extra form fields that make that POST meaningful. */
  readonly echoField: string;
  readonly extra?: Readonly<Record<string, string>>;
  /** Odd request bodies (JSON): each must answer 200 with no flag at every level. */
  readonly oddBodies: readonly unknown[];
  /** A request that succeeds / fails, to check the success and error message classes. */
  readonly ok: (agent: Agent, level: Level, sid: string) => PromiseLike<request.Response>;
  readonly bad: (agent: Agent, level: Level, sid: string) => PromiseLike<request.Response>;
}

/**
 * The view basics every lab shares: the player's own account is told, no type="password" input, forms
 * post back with no action, a typed payload is kept escaped, odd bodies are not a 500, and success and
 * error messages carry the lab-success / lab-error classes.
 */
export function describeLabView(v: LabViewSpec): void {
  const levels = LEVELS.filter((l) => v.challenge.levels.includes(l));
  describe(`${v.challenge.id} lab view`, () => {
    it('tells the player their account; no password-type inputs; forms post back with no action', async () => {
      const { agent } = await freshSession();
      for (const level of levels) {
        const res = await agent.get(`${v.path}?level=${level}`);
        expect(res.status, level).toBe(200);
        expect(res.text, level).toMatch(v.account);
        expect(res.text, level).not.toMatch(/type="password"/);
        const forms = [...res.text.matchAll(/<form[^>]*>/g)].map((m) => m[0]).filter((f) => !f.includes('lab-restart'));
        expect(forms.length, level).toBeGreaterThan(0);
        for (const f of forms) expect(f, level).not.toMatch(/\saction=/);
      }
    });

    it('keeps a typed payload escaped in its field', async () => {
      const { agent } = await freshSession();
      const res = await agent.post(`${v.path}?level=${levels[0]}`).type('form')
        .send({ ...v.extra, [v.echoField]: '"><script>alert(1)</script>', password: 'x' });
      expect(res.text).toContain('value="&#34;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
      expect(res.text).not.toContain('<script>alert(1)');
    });

    it('odd bodies (objects, arrays, nested values) are a failed request, never a 500 or a flag', async () => {
      const { agent } = await freshSession();
      for (const level of levels) {
        for (const body of v.oddBodies) {
          const res = await agent.post(`${v.path}?level=${level}`).send(body as object);
          expect(res.status, `${level} ${JSON.stringify(body)}`).toBe(200);
          expect(res.text, level).not.toMatch(FLAG_RE);
        }
      }
    });

    it('marks success and failure messages for styling', async () => {
      const a = await freshSession();
      expect((await v.ok(a.agent, 'templar', a.sid)).text).toMatch(/class="lab-message lab-success"/);
      const b = await freshSession();
      expect((await v.bad(b.agent, 'templar', b.sid)).text).toMatch(/class="lab-message lab-error"/);
    });

    it('upper-case request URLs still link and set cookies under the canonical lab path', async () => {
      const { agent } = await freshSession();
      const res = await agent.get(`${v.path.toUpperCase()}?level=${levels[0]}`);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain(v.path.toUpperCase());
      for (const line of [res.headers['set-cookie'] ?? []].flat()) {
        if (line.startsWith('hvwa_')) continue;
        expect(line).toContain(`Path=${v.path}`);
      }
    });
  });
}

/** Text-source extensions the hygiene checks apply to. */
const TEXT_EXT = /\.(ts|mts|mjs|js|ejs|css|sql|json|md)$/i;

/**
 * Repo-hygiene scan: relative paths (under `dirs` of `root`) of text-source
 * files that are not valid UTF-8, or that contain control characters other
 * than tab/LF/CR. Convention: labs put deliberately binary or malformed files
 * under `<challenge>/fixtures/`; any path segment named `fixtures` is exempt,
 * as are all non-text extensions.
 */
export function hygieneProblems(root: string, dirs: string[]): { badUtf8: string[]; control: string[] } {
  const badUtf8: string[] = [];
  const control: string[] = [];
  for (const dir of dirs) {
    for (const rel of readdirSync(join(root, dir), { recursive: true }).map(String)) {
      if (!TEXT_EXT.test(rel) || rel.split(/[\\/]/).includes('fixtures')) continue;
      const p = join(root, dir, rel);
      if (!statSync(p).isFile()) continue;
      const bytes = readFileSync(p);
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { badUtf8.push(`${dir}/${rel}`); }
      if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(bytes.toString('latin1'))) control.push(`${dir}/${rel}`);
    }
  }
  return { badUtf8, control };
}
