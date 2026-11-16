// src/districts/relic-market/rm-10-currency-rounding/rm-10.spec.ts
import { describe, it, expect } from 'vitest';
import type request from 'supertest';
import { describeExploitMatrix, describeLabView, FLAG_RE } from '../../../../tests/helpers.js';
import { describeCurlExample } from '../../_shared/curl.testkit.js';
import { describeShopBasics, endpointsShown, shopClient, walletOf, ordersOf, type ShopCtx } from '../_shared/shop-lab.testkit.js';
import { RM10 } from './challenge.js'; // registers RM-10 before createApp() inside freshSession
import { labState, netWorthScaled, type Currency } from './model.js';
import * as acolyteLevel from './levels/acolyte.js';
import * as templarLevel from './levels/templar.js';
import * as inquisitorLevel from './levels/inquisitor.js';
import * as divineLevel from './levels/divine.js';

const LAB = '/d/relic-market/currency-rounding';
type Ctx = ShopCtx;
type Script = (c: Ctx) => Promise<request.Response>;

const shop = shopClient(LAB);
const { form, home, ctx, restart } = shop;
const ex = (c: Ctx, from: Currency, to: Currency, amount: string | number) => shop.post(c, '/exchange', { from, to, amount: String(amount) });
const balances = (c: Ctx) => { const s = labState(c.sid, c.level); return { usd: s.wallet, crn: s.crn, idr: s.idr }; };
const worth = (c: Ctx): bigint => netWorthScaled(labState(c.sid, c.level));
const START = 325_000n; // 1000 cents x 325
const goalLine = (html: string): string => /<p class="lab-note" data-testid="goal">([\s\S]*?)<\/p>/.exec(html)?.[1].replace(/<[^>]*>/g, '').trim() ?? '';
const message = (html: string): string => /data-testid="lab-message">([^<]*)</.exec(html)?.[1] ?? '';
const flagOf = (html: string): string | undefined => FLAG_RE.exec(goalLine(html))?.[0];

// Acolyte: no minimum and Math.round: half a crown rounds UP in the player's favour, twice: +2 crowns for $1.00.
const acolyteExploit: Script = async (c) => { await ex(c, 'USD', 'CRN', 50); await ex(c, 'USD', 'CRN', 50); return home(c); };
// Templar: a minimum of $1.00 stops the small exchange, but it is still Math.round: $1.50 gives 2 crowns, twice.
const templarExploit: Script = async (c) => { await ex(c, 'USD', 'CRN', 150); await ex(c, 'USD', 'CRN', 150); return home(c); };
// Inquisitor: every credit rounds down, but the rupiah "rate" published for buying back is not the inverse of the one
// for selling: $10.00 -> 162,500 IDR -> $16.25.
const inquisitorExploit: Script = async (c) => { await ex(c, 'USD', 'IDR', 1000); await ex(c, 'IDR', 'USD', 162500); return home(c); };

describeExploitMatrix<Script>({
  challenge: RM10,
  path: LAB,
  send: (agent, level, script, _url, { sid }) => script({ agent, level, sid }),
  exploits: { acolyte: acolyteExploit, templar: templarExploit, inquisitor: inquisitorExploit },
  resisted: /Goal not reached yet/,
  legit: [{ name: 'USD to crowns, $3.00', input: async (c) => ex(c, 'USD', 'CRN', 300), expect: /Exchanged \$3\.00 for ₡3\./ }],
  malformed: [],
  privileged: null,
});

describeShopBasics({
  challenge: RM10, path: LAB, labState, hasRestart: true, hasCart: false,
  purchase: (agent, level) => agent.post(`${LAB}/exchange?level=${level}`).type('form').send({ from: 'USD', to: 'CRN', amount: '300' }),
});

describeLabView({
  challenge: RM10,
  path: LAB,
  account: /Signed in as <code>pilgrim<\/code>/,
  echoField: 'amount',
  extra: { intent: 'exchange', from: 'USD', to: 'CRN' },
  oddBodies: [
    { intent: 'exchange', from: { a: 1 }, to: 'CRN', amount: '100' }, { intent: 'exchange', from: 'USD', to: ['CRN'], amount: '100' },
    { intent: 'exchange', from: 'USD', to: 'CRN', amount: [1] }, { intent: 'exchange', from: 'USD', to: 'CRN', amount: null },
    { intent: ['exchange'] }, { intent: 'exchange' }, { intent: 'exchange', extra: { deep: [1] } }, [],
  ],
  ok: (agent, level, sid) => form({ agent, level, sid }, { intent: 'exchange', from: 'USD', to: 'CRN', amount: '300' }),
  bad: (agent, level, sid) => form({ agent, level, sid }, { intent: 'exchange', from: 'USD', to: 'CRN', amount: 'many' }),
});

describeCurlExample({ challenge: RM10, path: LAB, curl: () => ({ path: '/exchange', form: ['from=USD', 'to=CRN', 'amount=300'] }) });

describe('RM-10 currency rounding', () => {
  it('every level: balances, rates, goal, endpoints and the API box are on the page; the curl note needs no sign-in', async () => {
    for (const level of RM10.levels) {
      const html = (await home(await ctx(level))).text;
      expect(html, level).toContain('data-testid="balance-USD" data-units="1000"');
      expect(html, level).toContain('data-testid="balance-CRN" data-units="0"');
      expect(html, level).toContain('data-testid="balance-IDR" data-units="0"');
      expect(goalLine(html), level).toBe('Goal: net worth $11.00 or more. Goal not reached yet.');
      expect(html, level).toContain('Net worth: $10.00');
      expect(html, level).toContain('exactly 325000/325 cents');
      expect(endpointsShown(html), level).toEqual([`POST ${LAB}/exchange?level=${level} (from, to, amount)`]);
      expect(html, level).toContain(`<a href="${LAB}/api/rates?level=${level}">/api/rates</a>`);
      expect(html, level).toContain('open this page in your browser, then copy');
    }
  });

  it('every level: GET /api/rates is public and serves the level\'s own exported RATES table', async () => {
    const levels = { acolyte: acolyteLevel, templar: templarLevel, inquisitor: inquisitorLevel, divine: divineLevel } as const;
    for (const level of RM10.levels) {
      const c = await ctx(level);
      const res = await c.agent.get(`${LAB}/api/rates?level=${level}`);
      expect(res.status, level).toBe(200);
      expect(res.headers['content-type'], level).toMatch(/application\/json/);
      expect(res.body, level).toEqual({ level, base: 'USD', rates: JSON.parse(JSON.stringify(levels[level].RATES)) });
    }
    const inq = (await (await ctx('inquisitor')).agent.get(`${LAB}/api/rates?level=inquisitor`)).body.rates;
    expect(inq).toEqual({ CRN: { unitsPerUsd: 1, usdPerUnitE4: 10000 }, IDR: { unitsPerUsd: 16250, usdPerUnitE4: 1 } }); // 16250 and 1/10000: not inverse
    const div = (await (await ctx('divine')).agent.get(`${LAB}/api/rates?level=divine`)).body.rates;
    expect(div).toEqual({ CRN: { num: 1, den: 100 }, IDR: { num: 325, den: 2 } });
  });

  it('the exact net worth is usd x 325 + crowns x 32 500 + rupiah x 2, in 1/325 cents, and the start is 325 000', async () => {
    const c = await ctx('acolyte');
    await home(c);
    expect(worth(c)).toBe(START);
    const s = labState(c.sid, 'acolyte');
    s.wallet = 700; s.crn = 4; s.idr = 3;
    expect(netWorthScaled(s)).toBe(700n * 325n + 4n * 32_500n + 6n);
    s.wallet = 9_000_000_000_000; s.crn = 9_000_000_000_000; s.idr = 9_000_000_000_000; // beyond Number.MAX_SAFE_INTEGER once scaled
    expect(netWorthScaled(s)).toBe(9_000_000_000_000n * (325n + 32_500n + 2n));
  });

  it('acolyte: half a crown rounds up, no minimum; the exact units are in the balances and the history', async () => {
    const c = await ctx('acolyte');
    const cases: [Currency, Currency, number, number][] = [
      ['USD', 'CRN', 49, 0], ['USD', 'CRN', 50, 1], ['USD', 'CRN', 149, 1], ['USD', 'CRN', 150, 2],
      ['USD', 'IDR', 1, 163], ['USD', 'IDR', 3, 488], // 162.5 and 487.5 round up
    ];
    for (const [from, to, n, credit] of cases) {
      const d = await ctx('acolyte');
      const res = await ex(d, from, to, n);
      expect(message(res.text), `${from}->${to} ${n}`).toMatch(/^Exchanged /);
      const b = balances(d);
      expect(to === 'CRN' ? b.crn : b.idr, `${from}->${to} ${n}`).toBe(credit);
      expect(b.usd, `${from}->${to} ${n}`).toBe(1000 - n);
    }
    // And back: crowns are $1.00 each, rupiah round to the nearest cent.
    await ex(c, 'USD', 'CRN', 300);
    await ex(c, 'CRN', 'USD', 2);
    expect(balances(c)).toEqual({ usd: 700 + 200, crn: 1, idr: 0 });
    await ex(c, 'USD', 'IDR', 200); // 32 500 IDR
    expect(balances(c).idr).toBe(32_500);
    await ex(c, 'IDR', 'USD', 8125); // exactly 50 cents
    expect(balances(c)).toEqual({ usd: 900 - 200 + 50, crn: 1, idr: 32_500 - 8125 });
    await ex(c, 'IDR', 'USD', 82); // 0.5046 cents rounds up to 1
    expect(balances(c).usd).toBe(751);
  });

  it('acolyte: the exploit is exactly +$1.00 of net worth, the goal line shows the flag, and the flag stays after later trades', async () => {
    const c = await ctx('acolyte');
    const res = await acolyteExploit(c);
    expect(balances(c)).toEqual({ usd: 900, crn: 2, idr: 0 });
    expect(worth(c)).toBe(START + 32_500n);
    expect(goalLine(res.text)).toMatch(/^Goal: net worth \$11\.00 or more\. Goal reached\. Flag: HVWA\{[0-9a-f]{32}\}$/);
    expect(res.text).toContain('Net worth: $11.00');
    const flag = flagOf(res.text);
    await ex(c, 'CRN', 'USD', 2); // trading on does not take the recorded proof away
    expect(flagOf((await home(c)).text)).toBe(flag);
    const submit = await c.agent.post('/api/submit').send({ challengeId: 'RM-10', submission: flag });
    expect(submit.body).toMatchObject({ solved: true, level: 'acolyte' });
  });

  it('templar: a minimum of $1.00 / 1 crown / 16,250 IDR in whatever is given; $1.50 still gives 2 crowns', async () => {
    const c = await ctx('templar');
    expect(message((await ex(c, 'USD', 'CRN', 99)).text)).toBe('Minimum exchange is $1.00.');
    expect(message((await ex(c, 'USD', 'IDR', 50)).text)).toBe('Minimum exchange is $1.00.');
    expect(message((await ex(c, 'CRN', 'USD', 0)).text)).toBe('Enter an amount above zero.');
    expect(message((await ex(c, 'IDR', 'USD', 1)).text)).toBe('Insufficient balance.');
    labState(c.sid, 'templar').crn = 3;
    labState(c.sid, 'templar').idr = 20_000;
    expect(message((await ex(c, 'IDR', 'USD', 16_249)).text)).toBe('Minimum exchange is IDR 16,250.');
    expect(message((await ex(c, 'IDR', 'USD', 16_250)).text)).toBe('Exchanged IDR 16,250 for $1.00.');
    expect(message((await ex(c, 'CRN', 'USD', 1)).text)).toBe('Exchanged ₡1 for $1.00.');
    expect(balances(c)).toEqual({ usd: 1000 + 100 + 100, crn: 2, idr: 3_750 });
    const d = await ctx('templar');
    await ex(d, 'USD', 'CRN', 150);
    expect(balances(d)).toEqual({ usd: 850, crn: 2, idr: 0 });
  });

  it('inquisitor: the same minimums, and every credit rounds DOWN, so half a crown is nothing', async () => {
    const c = await ctx('inquisitor');
    expect(message((await ex(c, 'USD', 'CRN', 99)).text)).toBe('Minimum exchange is $1.00.');
    await ex(c, 'USD', 'CRN', 199);
    expect(balances(c)).toEqual({ usd: 801, crn: 1, idr: 0 });
    await ex(c, 'USD', 'IDR', 150); // 24 375 IDR exactly
    expect(balances(c).idr).toBe(24_375);
    await ex(c, 'USD', 'IDR', 101); // 16 412.5 floors to 16 412
    expect(balances(c).idr).toBe(24_375 + 16_412);
    expect(worth(c)).toBeLessThan(START);
  });

  it('inquisitor: buying dollars back uses the second published rate, 1/10 000 USD per IDR, so a round trip gains 62.5%', async () => {
    const c = await ctx('inquisitor');
    const res = await inquisitorExploit(c);
    expect(balances(c)).toEqual({ usd: 1625, crn: 0, idr: 0 });
    expect(worth(c)).toBe(1625n * 325n);
    expect(res.text).toContain('Net worth: $16.25');
    expect(flagOf(res.text)).toMatch(FLAG_RE);
    expect(message((await ex(await ctx('inquisitor'), 'IDR', 'USD', 16_249)).text)).toBe('Insufficient balance.');
  });

  it('step-ups (verified by hand in the design): the acolyte exploit is refused by the minimum, the templar exploit at inquisitor is a loss', async () => {
    const a = await ctx('templar');
    expect(message((await ex(a, 'USD', 'CRN', 50)).text)).toBe('Minimum exchange is $1.00.');
    const t = await ctx('inquisitor');
    await templarExploit(t);
    expect(balances(t)).toEqual({ usd: 700, crn: 2, idr: 0 });
    expect(worth(t)).toBe(700n * 325n + 2n * 32_500n); // 292 500 < 325 000
  });

  it('divine: one exact rational per pair, units per cent: crowns 1/100, rupiah 325/2, credits always round toward the house', async () => {
    const c = await ctx('divine');
    await ex(c, 'USD', 'CRN', 199);
    expect(balances(c)).toEqual({ usd: 801, crn: 1, idr: 0 });
    await ex(c, 'USD', 'IDR', 1000 - 199 - 1); // 800 cents -> 130 000 IDR exactly
    expect(balances(c)).toEqual({ usd: 1, crn: 1, idr: 130_000 });
    await ex(c, 'IDR', 'USD', 16_250); // floor(16250 x 2 / 325) = 100
    expect(balances(c)).toEqual({ usd: 101, crn: 1, idr: 113_750 });
    await ex(c, 'IDR', 'USD', 16_251); // floor(32502 / 325) = 100: the house keeps the remainder
    expect(balances(c)).toEqual({ usd: 201, crn: 1, idr: 97_499 });
    await ex(c, 'CRN', 'USD', 1);
    expect(balances(c).usd).toBe(301);
    expect(worth(c)).toBeLessThan(START);
  });

  it('divine: a zero credit is refused before the minimum, and a credit below the minimum is refused with it', async () => {
    const c = await ctx('divine');
    const refused = async (from: Currency, to: Currency, n: number): Promise<string> => {
      const res = await ex(c, from, to, n);
      expect(res.text, 'divine showed a flag').not.toMatch(FLAG_RE);
      return message(res.text);
    };
    for (const n of [1, 50, 99]) expect(await refused('USD', 'CRN', n), String(n)).toBe('Amount too small to exchange.');
    expect(await refused('USD', 'IDR', 99)).toBe('Minimum exchange is $1.00.'); // 16 087 IDR is a credit, but below the minimum
    labState(c.sid, 'divine').idr = 100_000;
    expect(await refused('IDR', 'USD', 162)).toBe('Amount too small to exchange.'); // floor(324/325) = 0
    expect(await refused('IDR', 'USD', 163)).toBe('Minimum exchange is IDR 16,250.'); // 1 cent, below the minimum
    expect(balances(c)).toEqual({ usd: 1000, crn: 0, idr: 100_000 });
  });

  it('divine: a property test, 200 random exchanges never raise the exact net worth (seeded, over the level module)', () => {
    let seed = 0x9e3779b9;
    const rnd = (): number => { // mulberry32
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    const bal: Record<Currency, number> = { USD: 1_000_000, CRN: 5_000, IDR: 50_000_000 };
    const scaled = (): bigint => BigInt(bal.USD) * 325n + BigInt(bal.CRN) * 32_500n + BigInt(bal.IDR) * 2n;
    const pairs: [Currency, Currency][] = [['USD', 'CRN'], ['CRN', 'USD'], ['USD', 'IDR'], ['IDR', 'USD']];
    let done = 0;
    for (let i = 0; i < 600 && done < 200; i++) {
      const [from, to] = pairs[Math.floor(rnd() * pairs.length)];
      const n = 1 + Math.floor(rnd() * Math.max(1, Math.min(bal[from], rnd() < 0.5 ? 400 : 200_000)));
      if (n > bal[from]) continue;
      const r = divineLevel.convert(from, to, n);
      if (typeof r === 'string') continue;
      const before = scaled();
      bal[from] -= r.debit;
      bal[to] += r.credit;
      expect(scaled() <= before, `${from}->${to} ${n}`).toBe(true);
      done += 1;
    }
    expect(done).toBe(200);
  });

  it('the same property over the exploitable levels finds a gain (so the property test can fail)', () => {
    for (const [name, level] of [['acolyte', acolyteLevel], ['templar', templarLevel], ['inquisitor', inquisitorLevel]] as const) {
      const bal: Record<Currency, number> = { USD: 1_000_000, CRN: 0, IDR: 0 };
      const scaled = (): bigint => BigInt(bal.USD) * 325n + BigInt(bal.CRN) * 32_500n + BigInt(bal.IDR) * 2n;
      const before = scaled();
      const steps: [Currency, Currency, number][] = name === 'inquisitor' ? [['USD', 'IDR', 1000], ['IDR', 'USD', 162_500]] : [['USD', 'CRN', 150], ['USD', 'CRN', 150]];
      for (const [from, to, n] of steps) {
        const r = level.convert(from, to, n);
        if (typeof r === 'string') throw new Error(`${name}: ${r}`);
        bal[from] -= r.debit;
        bal[to] += r.credit;
      }
      expect(scaled() > before, name).toBe(true);
    }
  });

  it('every level: the route accepts only USD<->CRN and USD<->IDR, a whole number of 1 to 9 digits, within the balance', async () => {
    for (const level of RM10.levels) {
      const c = await ctx(level);
      const bad: [Record<string, string>, string][] = [
        [{ from: 'CRN', to: 'IDR', amount: '1' }, 'Exchanges are USD to crowns, or USD to rupiah, and back.'],
        [{ from: 'USD', to: 'USD', amount: '100' }, 'Exchanges are USD to crowns, or USD to rupiah, and back.'],
        [{ from: 'EUR', to: 'USD', amount: '100' }, 'Exchanges are USD to crowns, or USD to rupiah, and back.'],
        [{ from: 'constructor', to: 'USD', amount: '100' }, 'Exchanges are USD to crowns, or USD to rupiah, and back.'],
        [{ from: 'USD', to: 'CRN', amount: '-100' }, 'Amount must be a whole number of 1 to 9 digits.'],
        [{ from: 'USD', to: 'CRN', amount: '1.5' }, 'Amount must be a whole number of 1 to 9 digits.'],
        [{ from: 'USD', to: 'CRN', amount: '1e3' }, 'Amount must be a whole number of 1 to 9 digits.'],
        [{ from: 'USD', to: 'CRN', amount: ' 100' }, 'Amount must be a whole number of 1 to 9 digits.'],
        [{ from: 'USD', to: 'CRN', amount: '1234567890' }, 'Amount must be a whole number of 1 to 9 digits.'],
        [{ from: 'USD', to: 'CRN', amount: '' }, 'Amount must be a whole number of 1 to 9 digits.'],
        [{ from: 'USD', to: 'CRN', amount: '0' }, 'Enter an amount above zero.'],
        [{ from: 'USD', to: 'CRN', amount: '1001' }, 'Insufficient balance.'],
        [{ from: 'CRN', to: 'USD', amount: '1' }, 'Insufficient balance.'],
      ];
      for (const [body, text] of bad) {
        expect(message((await shop.post(c, '/exchange', body)).text), `${level} ${JSON.stringify(body)}`).toBe(text);
      }
      expect(balances(c), level).toEqual({ usd: 1000, crn: 0, idr: 0 });
      expect(labState(c.sid, level).orders, level).toEqual([]);
    }
  });

  it('every level: an exchange of the whole balance is allowed, and the history lists what each exchange did, newest first', async () => {
    for (const level of RM10.levels) {
      const c = await ctx(level);
      await ex(c, 'USD', 'CRN', 300);
      const res = await ex(c, 'USD', 'CRN', 700); // the whole rest
      expect(balances(c).usd, level).toBe(0);
      const rows = [...res.text.matchAll(/<li data-order="(\d+)" data-total="(\d+)" data-charged="(\d+)" data-status="exchanged">([\s\S]*?)<\/li>/g)];
      expect(rows.map((r) => [r[1], r[2], r[3]]), level).toEqual([['2', '700', '700'], ['1', '300', '300']]);
      expect(rows[0][4], level).toContain('Exchanged $7.00 for ₡7.');
    }
  });

  it('platform safety: a balance past 1 000 000 000 000 units is refused, the history keeps the newest 30', async () => {
    const c = await ctx('acolyte');
    const s = labState(c.sid, 'acolyte');
    s.crn = 1_000_000_000_000;
    expect(message((await ex(c, 'USD', 'CRN', 100)).text)).toBe('This amount is out of range for this shop.');
    expect(balances(c)).toEqual({ usd: 1000, crn: 1_000_000_000_000, idr: 0 });
    s.crn = 0;
    for (let i = 0; i < 32; i++) await ex(c, 'USD', 'CRN', 10);
    const nos = ordersOf((await home(c)).text).map((o) => o.no);
    expect(nos).toEqual(Array.from({ length: 30 }, (_, i) => 32 - i));
  });

  it('every level: a small exchange never shows a flag', async () => {
    for (const level of RM10.levels) {
      const c = await ctx(level);
      const res = await ex(c, 'USD', 'CRN', 30);
      expect(res.text, level).not.toMatch(FLAG_RE);
      expect(walletOf(res.text), level).toBeLessThanOrEqual(1000);
    }
  });

  it('Restart: the three balances, the history and the goal start over, and the flag can still be earned', async () => {
    const c = await ctx('acolyte');
    await acolyteExploit(c);
    expect(flagOf((await home(c)).text)).toMatch(FLAG_RE);
    expect((await restart(c)).status).toBe(303);
    const fresh = (await home(c)).text;
    expect(walletOf(fresh)).toBe(1000);
    expect(balances(c)).toEqual({ usd: 1000, crn: 0, idr: 0 });
    expect(ordersOf(fresh)).toEqual([]);
    expect(goalLine(fresh)).toBe('Goal: net worth $11.00 or more. Goal not reached yet.');
    const flag = flagOf((await acolyteExploit(c)).text);
    expect(flag).toMatch(FLAG_RE);
    const submit = await c.agent.post('/api/submit').send({ challengeId: 'RM-10', submission: flag });
    expect(submit.body).toMatchObject({ solved: true, level: 'acolyte' });
  });
});
