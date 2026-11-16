// src/districts/relic-market/rm-08-race-balance-underflow/rm-08.spec.ts
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import type { Level } from '../../../core/levels.js';
import { describeExploitMatrix, describeLabView, FLAG_RE } from '../../../../tests/helpers.js';
import { describeCurlExample } from '../../_shared/curl.testkit.js';
import type { Gate } from '../_shared/race.js';
import {
  barrierGate, describeShopBasics, endpointsShown, ordersOf, shopClient, useFakeClock, useInstantWaits, walletOf, type ShopCtx,
} from '../_shared/shop-lab.testkit.js';
import { RM08 } from './challenge.js'; // registers RM-08 before createApp() inside freshSession
import { SPEND, labState } from './model.js';
import * as divineLevel from './levels/divine.js';

const LAB = '/d/relic-market/race-balance-underflow';
type Ctx = ShopCtx;
type Script = (c: Ctx) => Promise<request.Response>;

const shop = shopClient(LAB);
const { form, home, ctx, restart } = shop;
const buy = (c: Ctx) => shop.post(c, '/wallet/buy');
const gift = (c: Ctx, to = 'friend@relic-market.test') => shop.post(c, '/wallet/gift', { to });
const giftsOf = (html: string): string[] => [...html.matchAll(/<li data-gift>([\s\S]*?)<\/li>/g)].map((m) => m[1].trim());
/** The store-credit line of the panel, as text. */
const creditLine = (html: string): string => /<p class="lab-note" data-testid="credit">([\s\S]*?)<\/p>/.exec(html)?.[1].replace(/<[^>]*>/g, '').trim() ?? '';

// Every case except the races runs with instant waits: no test waits real time. The races install a barrier instead.
useInstantWaits();

/**
 * Fire every request together and read the page afterwards. The barrier is installed right before the race (set-up
 * requests that go through a racy door would count as arrivals) and must never need its fallback.
 */
async function race(c: Ctx, doors: readonly ((c: Ctx) => Promise<request.Response>)[]): Promise<{ page: request.Response; answers: request.Response[] }> {
  const barrier = barrierGate(doors.length);
  labState(c.sid, c.level).gate = barrier.gate;
  const answers = await Promise.all(doors.map((door) => door(c)));
  expect(barrier.timedOut(), 'the barrier needed its fallback: a request never arrived').toBe(false);
  expect(barrier.arrived()).toBe(doors.length);
  return { page: await home(c), answers };
}

// Acolyte: both endpoints check, wait for the ledger, then write: two parallel debits both pass the check.
const acolyteExploit: Script = async (c) => (await race(c, [buy, buy])).page;
// Inquisitor: each endpoint has its own lock, so a buy and a gift run at the same time.
const inquisitorExploit: Script = async (c) => (await race(c, [buy, (x) => gift(x)])).page;

describeExploitMatrix<Script>({
  challenge: RM08,
  path: LAB,
  send: (agent, level, script, _url, { sid }) => script({ agent, level, sid }),
  exploits: { acolyte: acolyteExploit, inquisitor: inquisitorExploit },
  resisted: /Store credit: \$5\.00/,
  legit: [{ name: 'one lantern', input: async (c) => buy(c), expect: /Store credit: \$5\.00/ }],
  malformed: [],
  privileged: null,
});

describeShopBasics({
  challenge: RM08, path: LAB, labState, hasRestart: true, hasCart: false,
  purchase: (agent, level) => agent.post(`${LAB}/wallet/buy?level=${level}`).type('form').send({}),
});

describeLabView({
  challenge: RM08,
  path: LAB,
  account: /Signed in as <code>pilgrim<\/code>/,
  echoField: 'to',
  extra: { intent: 'gift' },
  oddBodies: [
    { intent: 'gift', to: { a: 1 } }, { intent: 'gift', to: ['a', 'b'] }, { intent: ['buy'] }, { intent: 'gift', to: null },
    { intent: 'buy', extra: { deep: [1] } }, { intent: 'gift' }, [],
  ],
  ok: (agent, level, sid) => form({ agent, level, sid }, { intent: 'buy' }),
  bad: (agent, level, sid) => form({ agent, level, sid }, { intent: 'gift', to: '' }),
});

describeCurlExample({ challenge: RM08, path: LAB, curl: () => ({ path: '/wallet/gift', form: ['to=friend@relic-market.test'] }) });

describe('RM-08 race: balance underflow', () => {
  it('every level: the page explains the ledger and single-packet sending, lists each endpoint, and the curl note needs no sign-in', async () => {
    for (const level of RM08.levels) {
      const html = (await home(await ctx(level))).text;
      expect(html, level).toContain('Every payment is written to the ledger before your balance updates.');
      expect(html, level).toContain('single-packet technique');
      expect(html, level).toContain('<em>send group in parallel</em>');
      expect(creditLine(html), level).toBe('Store credit: $20.00.');
      expect(endpointsShown(html), level).toEqual([`POST ${LAB}/wallet/buy?level=${level}`, `POST ${LAB}/wallet/gift?level=${level} (to)`]);
      expect(html, level).toContain('open this page in your browser, then copy');
    }
  });

  it('acolyte: two parallel buys take $30.00 from $20.00, the panel shows the negative credit with the flag, which stays', async () => {
    const c = await ctx('acolyte');
    const { page, answers } = await race(c, [buy, buy]);
    expect(answers.map((a) => a.text.includes('Pilgrim&#39;s Lantern bought.'))).toEqual([true, true]);
    expect(walletOf(page.text)).toBe(-1000);
    const line = creditLine(page.text);
    expect(line).toMatch(/^Store credit: -\$10\.00\. Flag: HVWA\{[0-9a-f]{32}\}$/);
    const flag = FLAG_RE.exec(line)?.[0];
    expect(ordersOf(page.text).map((o) => o.no)).toEqual([2, 1]);
    // Nothing more can be spent, and the proof stays on the page.
    expect((await buy(c)).text).toContain('Insufficient store credit.');
    expect(FLAG_RE.exec(creditLine((await home(c)).text))?.[0]).toBe(flag);
    const submit = await c.agent.post('/api/submit').send({ challengeId: 'RM-08', submission: flag });
    expect(submit.body).toMatchObject({ solved: true, level: 'acolyte' });
  });

  it('acolyte: every pair of spending doors underflows (buy+buy, gift+gift, buy+gift), and each records what it did', async () => {
    for (const doors of [[buy, buy], [(x: Ctx) => gift(x, 'a'), (x: Ctx) => gift(x, 'b')], [buy, (x: Ctx) => gift(x, 'a')]] as const) {
      const c = await ctx('acolyte');
      const { page } = await race(c, doors);
      expect(walletOf(page.text)).toBe(-1000);
      expect(page.text).toMatch(FLAG_RE);
    }
    const c = await ctx('acolyte');
    const { page } = await race(c, [(x) => gift(x, 'a'), (x) => gift(x, 'b')]);
    expect(giftsOf(page.text).sort()).toEqual(['Gift card sent to a.', 'Gift card sent to b.']);
  });

  it('every level: one spend after another has finished is refused (so the race is required), and nothing is flagged', async () => {
    for (const level of RM08.levels) {
      const c = await ctx(level);
      expect((await buy(c)).text, level).toContain('Pilgrim&#39;s Lantern bought.');
      for (const door of [buy, (x: Ctx) => gift(x)]) {
        const res = await door(c);
        expect(res.text, level).toContain('Insufficient store credit.');
        expect(res.text, level).not.toMatch(FLAG_RE);
      }
      expect(walletOf((await home(c)).text), level).toBe(500);
      expect(labState(c.sid, level).orders).toHaveLength(1);
      expect(labState(c.sid, level).gifts).toHaveLength(0);
    }
  });

  it('inquisitor: two parallel buys serialize (the lock is real: the second sees $5.00), and so do two gifts', async () => {
    for (const doors of [[buy, buy], [(x: Ctx) => gift(x, 'a'), (x: Ctx) => gift(x, 'b')]] as const) {
      const c = await ctx('inquisitor');
      const { page, answers } = await race(c, doors);
      expect(answers.filter((a) => a.text.includes('Insufficient store credit.'))).toHaveLength(1);
      expect(walletOf(page.text)).toBe(500);
      expect(page.text).not.toMatch(FLAG_RE);
      expect(labState(c.sid, 'inquisitor').locks.size).toBe(0); // idle keys are deleted
    }
  });

  it('inquisitor: a buy and a gift run concurrently, because the lock is on the ENDPOINT, not the wallet', async () => {
    const c = await ctx('inquisitor');
    const { page, answers } = await race(c, [buy, (x) => gift(x)]);
    expect(answers.every((a) => !a.text.includes('Insufficient store credit.'))).toBe(true);
    expect(walletOf(page.text)).toBe(-1000);
    expect(page.text).toMatch(FLAG_RE);
    expect(ordersOf(page.text)).toHaveLength(1);
    expect(giftsOf(page.text)).toEqual(['Gift card sent to friend@relic-market.test.']);
  });

  it('the locks belong to one player\'s shop at one level, never to the module: two shops never share one', async () => {
    const a = await ctx('inquisitor');
    const b = await ctx('inquisitor');
    await home(a);
    await home(b);
    expect(labState(a.sid, 'inquisitor').locks).not.toBe(labState(b.sid, 'inquisitor').locks);
    expect(labState(a.sid, 'inquisitor').locks).not.toBe(labState(a.sid, 'acolyte').locks);
  });

  it('divine: any set of parallel spends allows exactly one, and the wallet never goes below zero', async () => {
    const doors: [string, ((c: Ctx) => Promise<request.Response>)[]][] = [
      ['buy+buy', [buy, buy]], ['buy+gift', [buy, (x) => gift(x)]], ['gift+gift', [(x) => gift(x, 'a'), (x) => gift(x, 'b')]],
      ['buy+gift+buy', [buy, (x) => gift(x), buy]],
    ];
    for (const [name, list] of doors) {
      const c = await ctx('divine');
      const { page, answers } = await race(c, list);
      expect(answers.filter((a) => a.text.includes('Insufficient store credit.')), name).toHaveLength(list.length - 1);
      expect(walletOf(page.text), name).toBe(500);
      expect(creditLine(page.text), name).toBe('Store credit: $5.00.');
      expect(page.text, name).not.toMatch(FLAG_RE);
      for (const a of answers) expect(a.text, name).not.toMatch(FLAG_RE);
      const state = labState(c.sid, 'divine');
      expect(state.orders.length + state.gifts.length, name).toBe(1);
    }
  });

  it('divine: the credit is reserved in the check\'s own synchronous step (the balance is already $5.00 during the ledger pause)', async () => {
    for (const door of [buy, (x: Ctx) => gift(x)]) {
      const c = await ctx('divine');
      const state = labState(c.sid, 'divine');
      let during: number | undefined;
      state.gate = { arrive: () => {}, pass: async () => { during = state.wallet; } };
      await door(c);
      expect(during).toBe(500);
    }
  });

  it('divine: the level module reserves the credit in its own synchronous step (no await)', async () => {
    const c = await ctx('divine');
    const s = labState(c.sid, 'divine');
    void divineLevel.buy(s);
    expect(s.wallet).toBe(500);
    const d = await ctx('divine');
    const t = labState(d.sid, 'divine');
    void divineLevel.gift(t, 'friend');
    expect(t.wallet).toBe(500);
  });

  it('divine: a ledger write that fails refunds the reservation and records nothing', async () => {
    for (const door of [buy, (x: Ctx) => gift(x)]) {
      const c = await ctx('divine');
      const state = labState(c.sid, 'divine');
      const real = state.gate;
      const broken: Gate = { arrive: () => {}, pass: () => Promise.reject(new Error('ledger down')) };
      state.gate = broken;
      expect((await door(c)).status).toBe(500);
      expect(state.wallet).toBe(2000);
      expect(state.orders).toEqual([]);
      expect(state.gifts).toEqual([]);
      state.gate = real;
      expect((await door(c)).status).toBe(200);
      expect(state.wallet).toBe(500);
    }
  });

  it('every level: a refused request never reaches the ledger, but the route still counts it as an arrival (before any lock)', async () => {
    for (const level of RM08.levels) {
      const c = await ctx(level);
      const state = labState(c.sid, level);
      state.wallet = 0;
      const seen: string[] = [];
      state.gate = { arrive: () => { seen.push('arrive'); }, pass: async () => { seen.push('pass'); } };
      expect((await buy(c)).text, level).toContain('Insufficient store credit.');
      expect((await gift(c)).text, level).toContain('Insufficient store credit.');
      expect((await gift(c, '')).text, level).toContain('Who is the gift for?');
      expect(seen, level).toEqual(['arrive', 'arrive', 'arrive']);
    }
  });

  it('every level: the ledger pause is 1500 ms at acolyte and 400 ms at inquisitor and divine, on the shop gate', async () => {
    const want = (level: Level): number => (level === 'acolyte' ? 1500 : 400);
    for (const level of RM08.levels) {
      for (const door of [buy, (x: Ctx) => gift(x)]) {
        const c = await ctx(level);
        const seen: number[] = [];
        labState(c.sid, level).gate = { arrive: () => {}, pass: async (ms) => { seen.push(ms); } };
        await door(c);
        expect(seen, level).toEqual([want(level)]);
      }
    }
  });

  it('every level: a gift needs a recipient, kept as text of at most 100 characters; the gift list keeps the newest 10', async () => {
    for (const level of RM08.levels) {
      const c = await ctx(level);
      const state = labState(c.sid, level);
      expect((await gift(c, '')).text, level).toContain('Who is the gift for?');
      expect((await gift(c, '   ')).text, level).toContain('Who is the gift for?');
      expect((await c.agent.post(`${LAB}/wallet/gift?level=${level}`).send({ to: { a: 1 } })).text, level).toContain('Who is the gift for?');
      expect(state.wallet, level).toBe(2000);
      const long = 'x'.repeat(5000);
      expect((await gift(c, long)).text, level).toContain('Gift card sent to');
      expect(state.gifts[0].to, level).toBe('x'.repeat(100));
      for (let i = 0; i < 12; i++) { state.wallet = 2000; await gift(c, `friend-${i}`); }
      expect(state.gifts, level).toHaveLength(10);
      expect(state.gifts.at(-1)?.to, level).toBe('friend-11');
      expect(state.gifts[0].to, level).toBe('friend-2');
    }
  });

  it('every level: a gift recipient is shown escaped', async () => {
    for (const level of RM08.levels) {
      const c = await ctx(level);
      const res = await gift(c, '<img src=x onerror=alert(1)>');
      expect(res.text, level).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(res.text, level).not.toContain('<img src=x');
    }
  });

  it('every level: a purchase is one order of the lantern at $15.00, and orders are the purchase history', async () => {
    for (const level of RM08.levels) {
      const c = await ctx(level);
      const res = await buy(c);
      expect(ordersOf(res.text), level).toEqual([{ no: 1, total: SPEND, charged: SPEND, status: 'paid' }]);
      expect(res.text, level).toContain('Pilgrim&#39;s Lantern × 1 at $15.00');
    }
  });

  it('Restart: the credit, the history and the orders start over; the race can be run again with a fresh barrier', async () => {
    const c = await ctx('acolyte');
    await race(c, [buy, buy]);
    await gift(c, 'a');
    expect(walletOf((await home(c)).text)).toBe(-1000);
    expect((await restart(c)).status).toBe(303);
    const fresh = (await home(c)).text;
    expect(walletOf(fresh)).toBe(2000);
    expect(ordersOf(fresh)).toEqual([]);
    expect(giftsOf(fresh)).toEqual([]);
    expect(fresh).not.toMatch(FLAG_RE);
    // Restart built a fresh state with the real gate again: install the barrier again, right before the race.
    const { page } = await race(c, [buy, buy]);
    const flag = FLAG_RE.exec(creditLine(page.text))?.[0];
    expect(flag).toBeDefined();
    const submit = await c.agent.post('/api/submit').send({ challengeId: 'RM-08', submission: flag });
    expect(submit.body).toMatchObject({ solved: true, level: 'acolyte' });
  });
});

describe('RM-08 production window', () => {
  const clock = useFakeClock();

  it('with the shop\'s own gate each spend really waits its ledger time on the clock', async () => {
    const want = (level: Level): number => (level === 'acolyte' ? 1500 : 400);
    for (const level of RM08.levels) {
      const c = await ctx(level);
      const t0 = clock.now();
      await buy(c);
      expect(clock.now() - t0, level).toBe(want(level));
    }
  });
});
