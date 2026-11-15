// Tests for the shared test helpers: FLAG_RE, DB_ERROR_RE, describeExploitMatrix.
import { describe, it, expect, afterEach } from 'vitest';
import { register, defineChallenge } from '../src/core/registry.js';
import { flagFor } from '../src/core/mount.js';
import { issueFlag } from '../src/core/flags.js';
import { field, tryDb, DIVINE_DB_ERROR } from '../src/core/lab.js';
import type { Level } from '../src/core/levels.js';
import {
  FLAG_RE, DB_ERROR_RE, TEST_SECRET, describeExploitMatrix, exploitMatrixCases, type ExploitMatrix,
} from './helpers.js';

describe('FLAG_RE', () => {
  it('matches a real flag and nothing flag-like but malformed', () => {
    const flag = issueFlag('HM-01', 'sid', 'acolyte');
    expect(FLAG_RE.exec(`Flag: ${flag}.`)?.[0]).toBe(flag);
    for (const s of ['HVWA{}', 'HVWA{xyz}', `HVWA{${'g'.repeat(32)}}`, `HVWA{${'a'.repeat(31)}}`]) {
      expect(FLAG_RE.test(s), s).toBe(false);
    }
  });
});

describe('DB_ERROR_RE', () => {
  it.each([
    'Database error: x', 'near "x": syntax error', 'unrecognized token: "\'"', 'SQLITE_ERROR', 'sqlite_constraint',
  ])('flags %j', (s) => { expect(DB_ERROR_RE.test(s)).toBe(true); });

  it.each(['Invalid request.', 'Invalid credentials.', 'Welcome, pilgrim (role: user).'])(
    'does not flag %j', (s) => { expect(DB_ERROR_RE.test(s)).toBe(false); });

  it('does not flag what Divine shows instead of a DB error', () => {
    expect(DB_ERROR_RE.test(DIVINE_DB_ERROR)).toBe(false);
  });
});

// A 3-level fixture lab (no inquisitor). `mode` breaks it in one way at a time
// so each matrix case can be shown to go red.
const mode = { acolyteSecure: false, divineVulnerable: false, divineLeaks: false, divineFlags: false };
afterEach(() => { Object.assign(mode, { acolyteSecure: false, divineVulnerable: false, divineLeaks: false, divineFlags: false }); });

const EXPLOIT: Partial<Record<Level, string>> = { acolyte: 'A-EXPLOIT', templar: 'T-EXPLOIT' };

const HM01 = register(defineChallenge({
  id: 'HM-01', district: 'helpers-test', slug: 'matrix', dir: process.cwd(),
  title: { id: 't', en: 't' }, summary: { id: 's', en: 's' }, maps: [],
  levels: ['acolyte', 'templar', 'divine'], hints: [],
  mount: (router) => {
    router.post('/', (req, res) => {
      const q = field(req, 'q');
      const level = req.level;
      let out: string;
      if (q === 'BOOM') {
        const r = tryDb(mode.divineLeaks ? { level: 'acolyte' } : req, () => { throw new Error('near "BOOM": syntax error'); });
        out = r.ok ? 'unreachable' : r.message;
      } else if (q === 'hello') {
        out = 'Hello, guest.';
      } else if (q === 'ADMIN') {
        if (level !== 'divine') out = `Welcome admin. ${flagFor(req, HM01)}`;
        else out = mode.divineFlags ? `Welcome admin. ${issueFlag(HM01.id, req.sessionId, 'templar')}` : 'Welcome admin.';
      } else if (level === 'divine') {
        out = mode.divineVulnerable && q.endsWith('-EXPLOIT') ? 'Pwned.' : 'Denied.';
      } else if (q === EXPLOIT[level] && !(level === 'acolyte' && mode.acolyteSecure)) {
        out = `Pwned. ${flagFor(req, HM01)}`;
      } else {
        out = 'Denied.';
      }
      res.type('text').send(out);
    });
  },
}));

const MATRIX: ExploitMatrix<string> = {
  challenge: HM01,
  path: '/d/helpers-test/matrix',
  send: (agent, _level, q, url) => agent.post(url).type('form').send({ q }),
  exploits: { acolyte: 'A-EXPLOIT', templar: 'T-EXPLOIT' },
  resisted: 'Denied.',
  legit: [{ name: 'greeting', input: 'hello', expect: 'Hello, guest.' }],
  malformed: [{ name: 'unbalanced input', input: 'BOOM', levels: ['acolyte', 'templar'] }],
  privileged: { name: 'admin', input: 'ADMIN', expect: /^Welcome admin\.$/ },
};

// The generated suite itself: green against the correct fixture.
describeExploitMatrix(MATRIX);

const caseNamed = (m: ExploitMatrix<string>, name: string) => {
  const c = exploitMatrixCases(m).find((x) => x.name === name);
  if (!c) throw new Error(`no case named ${name}`);
  return c.run();
};

describe('exploitMatrixCases', () => {
  it('names every case after its level (3-level challenge: no inquisitor cases)', () => {
    expect(exploitMatrixCases(MATRIX).map((c) => c.name)).toEqual([
      'exploits cover exactly the exploitable levels (acolyte, templar)',
      'acolyte: exploit reveals a flag credited at acolyte',
      'divine resists the acolyte exploit',
      'templar: exploit reveals a flag credited at templar',
      'divine resists the templar exploit',
      'acolyte: malformed "unbalanced input" shows a database error',
      'templar: malformed "unbalanced input" shows a database error',
      'divine: malformed "unbalanced input" shows no database error',
      'acolyte: legit "greeting" works without a flag',
      'templar: legit "greeting" works without a flag',
      'divine: legit "greeting" works without a flag',
      'divine: privileged "admin" works without a flag',
    ]);
  });

  it('(a) goes red when the exploits do not match the exploitable levels', async () => {
    const name = 'exploits cover exactly the exploitable levels (acolyte, templar)';
    await expect(caseNamed({ ...MATRIX, exploits: { acolyte: 'A-EXPLOIT' } }, name)).rejects.toThrow(/deeply equal/);
    await expect(caseNamed({ ...MATRIX, exploits: { ...MATRIX.exploits, inquisitor: 'x' } }, name)).rejects.toThrow(/deeply equal/);
  });

  it('(b) goes red when a level is secure, or the exploit only works elsewhere', async () => {
    const name = 'acolyte: exploit reveals a flag credited at acolyte';
    mode.acolyteSecure = true;
    await expect(caseNamed(MATRIX, name)).rejects.toThrow(/no flag in the acolyte response/);
    mode.acolyteSecure = false;
    await expect(caseNamed({ ...MATRIX, exploits: { acolyte: 'T-EXPLOIT', templar: 'T-EXPLOIT' } }, name)).rejects.toThrow(/no flag in the acolyte response/);
    await expect(caseNamed(MATRIX, name)).resolves.toBeUndefined();
  });

  it('(c) goes red when Divine falls for an exploit, even without issuing a flag', async () => {
    mode.divineVulnerable = true;
    await expect(caseNamed(MATRIX, 'divine resists the acolyte exploit')).rejects.toThrow(/resisted text/);
    await expect(caseNamed(MATRIX, 'divine resists the templar exploit')).rejects.toThrow(/resisted text/);
  });

  it('(d) goes red when Divine leaks the DB error, or a listed level shows none', async () => {
    mode.divineLeaks = true;
    await expect(caseNamed(MATRIX, 'divine: malformed "unbalanced input" shows no database error')).rejects.toThrow(/divine leaked a database error/);
    mode.divineLeaks = false;
    const quiet = { ...MATRIX, malformed: [{ name: 'quiet', input: 'hello', levels: ['acolyte'] as const }] };
    await expect(caseNamed(quiet, 'acolyte: malformed "quiet" shows a database error')).rejects.toThrow(/no database error at acolyte/);
  });

  it('(e) goes red when legit use shows a flag or not the expected text', async () => {
    const flagging = { ...MATRIX, legit: [{ name: 'admin', input: 'ADMIN', expect: 'Welcome admin.' }] };
    await expect(caseNamed(flagging, 'acolyte: legit "admin" works without a flag')).rejects.toThrow(/legit use showed a flag at acolyte/);
    const wrong = { ...MATRIX, legit: [{ name: 'greeting', input: 'hello', expect: 'Goodbye' }] };
    await expect(caseNamed(wrong, 'templar: legit "greeting" works without a flag')).rejects.toThrow(/legit "greeting" at templar/);
  });

  it('(f) goes red when Divine issues a flag to the privileged user', async () => {
    mode.divineFlags = true;
    await expect(caseNamed(MATRIX, 'divine: privileged "admin" works without a flag')).rejects.toThrow(/divine issued a flag/);
  });

  it('privileged may be null (no privileged identity in this lab)', () => {
    expect(exploitMatrixCases({ ...MATRIX, privileged: null }).some((c) => c.name.includes('privileged'))).toBe(false);
  });

  it('rejects a matrix it cannot run meaningfully', () => {
    const noDivine = { ...HM01, levels: ['acolyte', 'templar'] as const };
    expect(() => exploitMatrixCases({ ...MATRIX, challenge: noDivine })).toThrow(/Divine/);
    expect(() => exploitMatrixCases({ ...MATRIX, legit: [] })).toThrow(/legit/);
    for (const levels of [[], ['divine'], ['inquisitor']] as const) {
      expect(() => exploitMatrixCases({ ...MATRIX, malformed: [{ name: 'm', input: 'BOOM', levels: levels as never }] }),
        JSON.stringify(levels)).toThrow(/malformed/);
    }
  });
});

it('TEST_SECRET is a valid flag secret (used by freshSession)', () => {
  expect(TEST_SECRET.length).toBeGreaterThanOrEqual(16);
});
