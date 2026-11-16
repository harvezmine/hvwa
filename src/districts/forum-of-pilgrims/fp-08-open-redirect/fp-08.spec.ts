// src/districts/forum-of-pilgrims/fp-08-open-redirect/fp-08.spec.ts
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import {
  FLAG_RE, attackerHits, describeExploitMatrix, describeLabView, freshSession, type Agent,
} from '../../../../tests/helpers.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import { describeCurlExample } from '../../_shared/curl.testkit.js';
import {
  describeVictimAction, expectAwayPage, expectInLab, expectNoWayOut, victimClient,
} from '../../_shared/victim-lab.testkit.js';
import { FP08 } from './challenge.js'; // registers FP-08 before createApp() inside freshSession
import { labState } from './model.js';

const LAB = '/d/forum-of-pilgrims/open-redirect';
const { sendLink } = victimClient(LAB);

type Script = (agent: Agent, level: Level) => Promise<request.Response>;

const home = (a: Agent, l: Level) => a.get(`${LAB}?level=${l}`);
/** The share link as the admin gets it: a citadel.test URL whose `next` is yours. */
const shareLink = (next: string): string => `http://citadel.test/go?next=${encodeURIComponent(next)}`;
const compose = (a: Agent, l: Level, next: string) => a.post(`${LAB}?level=${l}`).type('form').send({ next });
/** The admin opens your share link; you read your own page. */
const shareVia = (next: string): Script => async (a, l) => { await sendLink(a, l, shareLink(next)); return home(a, l); };

// Acolyte: next is followed verbatim.
const acolyteExploit = shareVia('http://attacker.test/x');
// Templar: next must start with "/", and "//host" is protocol-relative.
const templarExploit = shareVia('//attacker.test/x');
// Inquisitor: the host of an absolute URL must merely contain citadel.test: a host of your own can.
const inquisitorExploit = shareVia('http://citadel.test.attacker.test/x');

const NOTHING = 'Nothing has reached your server through a share link yet.';

describeExploitMatrix<Script>({
  challenge: FP08,
  path: LAB,
  send: (agent, level, script) => script(agent, level),
  exploits: { acolyte: acolyteExploit, templar: templarExploit, inquisitor: inquisitorExploit },
  // Matrix case (c) cannot fail here by itself: Divine's refusal is guarded by the per-level table in "where each level lets
  // a share link go" below (every off-lab spelling, including //localhost/x and a dotless //x, is refused at Divine and the
  // admin's browser never leaves). Mutants that weaken Divine's allowNext die there, not in (c).
  resisted: NOTHING,
  legit: [
    { name: 'compose a share link', input: (a, l) => compose(a, l, '/thread/1'), expect: 'Share link: http://citadel.test/go?next=%2Fthread%2F1' },
    { name: 'the admin opens an honest share link: nothing reaches your server', input: shareVia('/thread/1'), expect: NOTHING },
  ],
  malformed: [], // no query, no parser: nothing that can raise a database error
  privileged: null, // the admin is the victim, never signed in by the player
});

describeLabView({
  challenge: FP08, path: LAB, account: /Your target: <code>citadel_admin<\/code>/, echoField: 'next',
  oddBodies: [{ next: { a: 1 } }, { next: ['x'] }, [1, 2], {}],
  ok: (a, l) => compose(a, l, '/thread/1'),
  bad: (a, l) => compose(a, l, ''),
});
describeVictimAction({
  challenge: FP08, path: LAB,
  description: { en: 'opens any share link you send', id: 'membuka tautan berbagi apa pun yang Anda kirim' },
});
describeCurlExample({ challenge: FP08, path: LAB, curl: () => ({ path: '', form: ['next=/thread/1'] }) });

/** Where the admin's browser went the last time it was sent a link (the simulated trace). */
const lastVisit = (sid: string, level: Level) => labState(sid, level).world.visits.at(-1)!;

describe('FP-08 where each level lets a share link go', () => {
  const OFF: readonly string[] = [
    'http://attacker.test/x', '//attacker.test/x', '/\\attacker.test/x', 'http://citadel.test.attacker.test/x',
    'http://citadel.test@attacker.test/x', 'http://attacker.test\\@citadel.test/x', 'http://attacker.test/?x=citadel.test',
    'javascript:alert(1)', 'http://127.0.0.1/', '//localhost/x', '//x', '/\\x', '/a\\b', '/\t/attacker.test/x', '/\n/attacker.test/x', '/\r/attacker.test/x',
  ];
  // [level, next, where the ADMIN's browser ends up]
  const cases: [Level, string, 'attacker' | 'refused' | 'citadel' | 'unreachable'][] = [
    ['acolyte', 'http://attacker.test/x', 'attacker'],
    ['acolyte', '/thread/1', 'citadel'],
    ['acolyte', 'javascript:alert(1)', 'unreachable'],
    ['templar', 'http://attacker.test/x', 'refused'],
    ['templar', '//attacker.test/x', 'attacker'],
    ['templar', '/\\attacker.test/x', 'attacker'],
    ['templar', '/thread/1', 'citadel'],
    ['inquisitor', 'http://attacker.test/x', 'refused'],
    ['inquisitor', '//attacker.test/x', 'refused'],
    ['inquisitor', '/\\attacker.test/x', 'refused'],
    ['inquisitor', 'http://attacker.test/?x=citadel.test', 'refused'],
    // WHATWG deletes tab, CR and LF anywhere in a URL, so "/<TAB>/host" IS "//host": Templar's trick must not pass here.
    ['inquisitor', '/\t/attacker.test/x', 'refused'],
    ['inquisitor', '/\n/attacker.test/x', 'refused'],
    ['inquisitor', '/\r/attacker.test/x', 'refused'],
    ['inquisitor', '/\t\\attacker.test/x', 'refused'],
    ['inquisitor', 'ht\ttp://attacker.test/x', 'refused'],
    ['templar', '/\t/attacker.test/x', 'attacker'],
    ['inquisitor', 'http://citadel.test.attacker.test/x', 'attacker'],
    ['inquisitor', 'http://attacker.test\\@citadel.test/x', 'attacker'],
    ['inquisitor', 'http://citadel.test/thread/2', 'citadel'],
    ['inquisitor', '/thread/1', 'citadel'],
    ...OFF.map((next): [Level, string, 'refused'] => ['divine', next, 'refused']),
    ['divine', '/thread/1', 'citadel'],
    ['divine', '/', 'citadel'],
  ];
  it.each(cases)('%s, next %s: the admin ends %s', async (level, next, where) => {
    const { agent, sid } = await freshSession();
    await sendLink(agent, level, shareLink(next));
    const visit = lastVisit(sid, level);
    if (where === 'attacker') {
      expect(visit.outcome).toBe('attacker');
      expect(attackerHits((await home(agent, level)).text)).toHaveLength(1);
    } else if (where === 'refused') {
      expect(visit.page).toMatchObject({ status: 400 });
      expect(visit.page?.body).toContain('Refused');
      expect(visit.hops).toHaveLength(1);
      expect(attackerHits((await home(agent, level)).text)).toEqual([]);
    } else if (where === 'citadel') {
      expect(visit.outcome).toBe('page');
      expect(visit.page?.status).toBe(200);
      expect(attackerHits((await home(agent, level)).text)).toEqual([]);
    } else {
      expect(visit.outcome).toBe('unreachable');
      expect(attackerHits((await home(agent, level)).text)).toEqual([]);
    }
  });

  it('the flag appears only when the admin\'s browser really arrived at your server THROUGH the share link', async () => {
    for (const level of ['acolyte', 'templar', 'inquisitor'] as const) {
      const { agent } = await freshSession();
      // A direct link to your server is no open redirect: it hits your log, proves nothing.
      await sendLink(agent, level, 'http://attacker.test/direct');
      const page = (await home(agent, level)).text;
      expect(attackerHits(page), level).toHaveLength(1);
      expect(page, level).not.toMatch(FLAG_RE);
      expect(page, level).toContain(NOTHING);
    }
  });

  /** A chain of `n` share links, each continuing to the next, the last continuing to your server (Acolyte lets all through). */
  const chain = (n: number): string => {
    let next = 'http://attacker.test/x';
    for (let i = 0; i < n; i++) next = `/go?next=${encodeURIComponent(next)}`;
    return `http://citadel.test${next}`;
  };

  it('the flag needs a REAL arrival: a chain too long for the browser ends in too-many-redirects, no hit, no flag', async () => {
    const { agent, sid } = await freshSession();
    await sendLink(agent, 'acolyte', chain(11));
    expect(lastVisit(sid, 'acolyte').outcome).toBe('too-many-redirects');
    const page = (await home(agent, 'acolyte')).text;
    expect(attackerHits(page)).toEqual([]);
    expect(page).not.toMatch(FLAG_RE);
    expect(page).toContain(NOTHING);
  });

  it('a chain short enough to arrive (still by way of redirects) earns the flag', async () => {
    const { agent, sid } = await freshSession();
    await sendLink(agent, 'acolyte', chain(4));
    expect(lastVisit(sid, 'acolyte').outcome).toBe('attacker');
    const page = (await home(agent, 'acolyte')).text;
    expect(attackerHits(page)).toHaveLength(1);
    expect(page).toMatch(FLAG_RE);
  });

  it('the flag stays after a later honest visit, and is this player\'s only', async () => {
    const { agent } = await freshSession();
    await acolyteExploit(agent, 'acolyte');
    await sendLink(agent, 'acolyte', shareLink('/thread/1'));
    expect((await home(agent, 'acolyte')).text).toMatch(FLAG_RE);
    const other = await freshSession();
    expect((await home(other.agent, 'acolyte')).text).not.toMatch(FLAG_RE);
  });

  it('levels are isolated: an escape at acolyte shows no flag at templar', async () => {
    const { agent } = await freshSession();
    await acolyteExploit(agent, 'acolyte');
    for (const level of ['templar', 'inquisitor', 'divine'] as const) expect((await home(agent, level)).text, level).not.toMatch(FLAG_RE);
  });
});

describe('FP-08 your real browser never leaves the lab', () => {
  const NEXTS = [
    'http://attacker.test/x', '//attacker.test/x', '/\\attacker.test/x', 'http://citadel.test.attacker.test/x',
    'http://citadel.test@attacker.test/x', 'https://example.com/', 'javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd',
    'http://127.0.0.1:8080/', '', '   ', '/thread/1', '/', 'http://citadel.test/thread/2', 'http://citadel.test/..//attacker.test',
    '%2F%2Fattacker.test', 'x'.repeat(3000),
  ];
  const go = (a: Agent, l: Level, next: string) => a.get(`${LAB}/go?next=${encodeURIComponent(next)}&level=${l}`).redirects(0);

  it('no Location is ever off the lab, and no Refresh, for any level or any next', async () => {
    const { agent } = await freshSession();
    for (const level of LEVELS) {
      for (const next of NEXTS) {
        const res = await go(agent, level, next);
        const label = `${level} ${next.slice(0, 40)}`;
        expect(res.headers.refresh, label).toBeUndefined();
        const location = res.headers.location as string | undefined;
        if (location !== undefined) {
          expect(location.startsWith(`${LAB}/`) || location.startsWith(`${LAB}?`), `${label} -> ${location}`).toBe(true);
          // Under the lab's own absolute path, so never protocol-relative and never another host (a lab path may carry
          // text of the player's, like "//attacker.test", but only AFTER the lab path).
          expect(location, label).toMatch(/^\/d\/forum-of-pilgrims\/open-redirect[/?]/);
        }
        expect(res.status, label).toBeLessThan(500);
      }
    }
  });

  it('a target inside the lab is a redirect to the same place in the lab, at the served level', async () => {
    const { agent } = await freshSession();
    for (const level of ['acolyte', 'templar', 'inquisitor', 'divine'] as const) {
      const res = await go(agent, level, '/thread/1');
      const at = expectInLab(res, LAB, level, level);
      expect(at).toContain(`${LAB}/thread/1`);
      expect((await agent.get(at)).status, level).toBe(200);
    }
  });

  it('a target outside the lab is a page that says where the admin\'s browser would go: text, no link', async () => {
    const { agent } = await freshSession();
    const cases: [Level, string][] = [
      ['acolyte', 'http://attacker.test/x'], ['templar', '//attacker.test/x'], ['templar', '/\\attacker.test/x'],
      ['inquisitor', 'http://citadel.test.attacker.test/x'],
    ];
    for (const [level, next] of cases) {
      const res = await go(agent, level, next);
      expect(expectAwayPage(res, `${level} ${next}`)).toContain('attacker.test');
    }
  });

  it('divine refuses an outside target in its own page (400), and never redirects', async () => {
    const { agent } = await freshSession();
    for (const next of ['http://attacker.test/x', '//attacker.test/x', '/\\attacker.test/x', 'http://citadel.test/thread/1']) {
      const res = await go(agent, 'divine', next);
      expect(res.status, next).toBe(400);
      expect(res.headers.location, next).toBeUndefined();
      expect(res.headers.refresh, next).toBeUndefined();
      expect(res.text, next).toContain('Refused');
    }
  });

  it('no next at all continues to the forum front page; the front page and a thread are 200 at every level', async () => {
    const { agent } = await freshSession();
    for (const level of LEVELS) {
      expectInLab(await agent.get(`${LAB}/go?level=${level}`).redirects(0), LAB, level, level);
      expect((await home(agent, level)).status, level).toBe(200);
      expect((await agent.get(`${LAB}/thread/1?level=${level}`)).status, level).toBe(200);
      expect((await agent.get(`${LAB}/thread/99?level=${level}`)).status, level).toBe(404);
    }
  });

  it('a long or repeated next, and an array-style key, are handled (never a 500, never a flag)', async () => {
    const { agent } = await freshSession();
    for (const level of LEVELS) {
      for (const q of ['next=a&next=http://attacker.test/', 'next[]=http://attacker.test/', `next=${'/a'.repeat(5000)}`]) {
        const res = await agent.get(`${LAB}/go?${q}&level=${level}`).redirects(0);
        expect(res.status, `${level} ${q.slice(0, 30)}`).toBeLessThan(500);
        expect(res.text ?? '', level).not.toMatch(FLAG_RE);
      }
    }
  });
});

describe('FP-08 page', () => {
  it('shows the share link you composed (escaped) and a link to try it in your own browser, which stays in the lab', async () => {
    const { agent } = await freshSession();
    const res = await compose(agent, 'acolyte', '"><script>alert(1)</script>');
    expect(res.text).not.toContain('<script>alert(1)');
    expect(res.text).toContain(`href="${LAB}/go?next=`);
  });

  it('lists the forum threads with absolute share links built from labPath', async () => {
    const { agent } = await freshSession();
    const res = await agent.get(`${LAB.toUpperCase()}?level=acolyte`);
    expect(res.text).toContain(`${LAB}/thread/1?level=acolyte`);
    expect(res.text).not.toContain(LAB.toUpperCase());
  });

  it('the front page itself never answers with a way out', async () => {
    const { agent } = await freshSession();
    for (const level of LEVELS) expectNoWayOut(await home(agent, level), level);
  });
});

describe('FP-08 thread page', () => {
  it('does not replace the page title with the thread title (the lab bar default stays)', async () => {
    const { agent } = await freshSession();
    const res = await agent.get(`${LAB}/thread/1?level=acolyte`);
    expect(res.text).toMatch(/<title>FP-08/);
    expect(res.text).toContain('Welcome to the Forum of Pilgrims');
  });
});

describe('FP-08 challenge text', () => {
  it('the summary says the visit arrives at your server through the share link, in both languages', async () => {
    const { agent } = await freshSession();
    expect((await agent.get('/c/FP-08?lang=en')).text).toContain('arriving at your server through the share link');
    expect((await agent.get('/c/FP-08?lang=id')).text).toContain('tiba di servermu melalui tautan berbagi');
  });
});
