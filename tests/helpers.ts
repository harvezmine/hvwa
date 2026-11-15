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
  /** Submit `input` to the lab at `level`. `url` is `${path}?level=${level}`. */
  readonly send: (agent: Agent, level: Level, input: I, url: string) => PromiseLike<request.Response>;
  /** One working exploit per exploitable level: keys must equal the challenge's non-Divine levels. */
  readonly exploits: { readonly [L in ExploitLevel]?: I };
  /** What Divine answers to every exploit (proves it resisted, not just withheld the flag). */
  readonly resisted: Expectation;
  /** Ordinary use: works at every level, never shows a flag. At least one. */
  readonly legit: readonly { readonly name: string; readonly input: I; readonly expect: Expectation }[];
  /** Inputs that break the query: a DB error at each listed level, none at Divine. [] if not applicable. */
  readonly malformed: readonly { readonly name: string; readonly input: I; readonly levels: readonly ExploitLevel[] }[];
  /** A real privileged login at Divine: works, never a flag. null if the lab has no such identity. */
  readonly privileged: { readonly name: string; readonly input: I; readonly expect: Expectation } | null;
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
 *  (c) Divine answers every exploit with 200, the `resisted` text, no flag, no DB-error text
 *  (d) each malformed input shows DB-error text at its levels, and none (200, no flag) at Divine
 *  (e) each legit input works at every level: 200, expected text, no flag
 *  (f) the privileged input works at Divine: 200, expected text, no flag
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
  const implemented = LEVELS.filter((l) => c.levels.includes(l));
  const send = async (level: Level, input: I) => {
    const { agent } = await freshSession();
    const res = await m.send(agent, level, input, `${m.path}?level=${level}`);
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
      expect(text, 'divine showed a database error').not.toMatch(DB_ERROR_RE);
      expectText(text, m.resisted, 'divine did not answer with the resisted text');
    });
  }

  for (const mc of m.malformed) {
    for (const level of exploitable.filter((l) => mc.levels.includes(l))) {
      add(`${level}: malformed "${mc.name}" shows a database error`, async () => {
        const { text } = await send(level, mc.input);
        expect(text, `no database error at ${level}`).toMatch(DB_ERROR_RE);
      });
    }
    add(`divine: malformed "${mc.name}" shows no database error`, async () => {
      const { res, text } = await send('divine', mc.input);
      expect(res.status).toBe(200);
      expect(text, 'divine leaked a database error').not.toMatch(DB_ERROR_RE);
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
