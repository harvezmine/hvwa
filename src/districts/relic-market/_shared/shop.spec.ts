// src/districts/relic-market/_shared/shop.spec.ts — unit tests of the Relic Market shop shell's pure plumbing:
// the catalog, cart bounds, orders, money, the injectable clock, the race primitives and the SQL helpers.
import { afterEach, describe, it, expect, vi } from 'vitest';
import { challengeDb } from '../../../core/challenge-db.js';
import {
  CUSTOMER, LIMITS, OUT_OF_RANGE, cartTotal, catalogOf, exactValue, formatMoney, insufficientFunds, newShop, orderLines,
  placeOrder, pushOrder, setLine, type Order, type ShopState,
} from './shop.js';
import { MAX_WAIT_MS, realClock, setClockForTests, type LabClock } from './clock.js';
import { KeyedMutex, waitGate } from './race.js';
import { clip, firstRows } from './sql.js';
import { barrierGate, useFakeClock, useInstantWaits } from './shop-lab.testkit.js';

const CATALOG = catalogOf([
  { sku: 'RELIQUARY', name: 'Reliquary', price: 100000, blurb: 'A relic.' },
  { sku: 'ROSARY', name: "Pilgrim's Rosary", price: 4000, blurb: 'Beads.' },
  { sku: 'CANDLE', name: 'Votive Candle', price: 250, blurb: 'Wax.' },
]);
const shop = (wallet = 5000): ShopState => newShop({ catalog: CATALOG, wallet });
const order = (no: number): Order => ({
  no, owner: CUSTOMER.id, lines: [], discounts: [], subtotal: 0, total: 0, charged: 0, status: 'paid', at: 0,
});

describe('catalogOf', () => {
  it('looks products up by SKU in a Map, never through an object index', () => {
    expect(CATALOG.get('ROSARY')?.price).toBe(4000);
    for (const sku of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'rosary', '']) {
      expect(CATALOG.get(sku), sku).toBeUndefined();
    }
    expect(CATALOG.products.map((p) => p.sku)).toEqual(['RELIQUARY', 'ROSARY', 'CANDLE']);
  });

  it('is frozen, products included', () => {
    expect(Object.isFrozen(CATALOG)).toBe(true);
    expect(Object.isFrozen(CATALOG.products)).toBe(true);
    for (const p of CATALOG.products) expect(Object.isFrozen(p), p.sku).toBe(true);
  });

  it('refuses a duplicate SKU, a malformed SKU and a price that is not whole, safe, non-negative cents', () => {
    const p = { sku: 'A', name: 'A', price: 1, blurb: '' };
    expect(() => catalogOf([p, p])).toThrow(/duplicate SKU A/);
    expect(() => catalogOf([{ ...p, sku: 'a b' }])).toThrow(/SKU/);
    for (const price of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      expect(() => catalogOf([{ ...p, price }]), String(price)).toThrow(/price/);
    }
  });
});

describe('newShop', () => {
  it('starts with the wallet, an empty cart, no discounts or orders, order #1 next and the real clock', () => {
    const s = shop(2500);
    expect(s).toMatchObject({ startWallet: 2500, wallet: 2500, cart: [], discounts: [], orders: [], nextOrderNo: 1 });
    expect(s.clock).toBe(realClock);
    expect(s.catalog).toBe(CATALOG);
  });

  it('refuses a wallet that is not a safe integer', () => {
    expect(() => newShop({ catalog: CATALOG, wallet: 1.5 })).toThrow(/wallet/);
  });

  it('each shop is its own: two shops share no cart or order list', () => {
    const a = shop();
    const b = shop();
    setLine(a, { sku: 'CANDLE', qty: 1, unitPrice: 250 });
    expect(b.cart).toEqual([]);
  });
});

describe('setLine', () => {
  it('sets the quantity of the SKU\'s line (no adding up), and 0 removes it', () => {
    const s = shop();
    expect(setLine(s, { sku: 'CANDLE', qty: 2, unitPrice: 250 })).toEqual({ ok: true, text: 'Cart updated: Votive Candle × 2.' });
    setLine(s, { sku: 'CANDLE', qty: 5, unitPrice: 250 });
    expect(s.cart).toEqual([{ sku: 'CANDLE', qty: 5, unitPrice: 250 }]);
    expect(setLine(s, { sku: 'CANDLE', qty: 0, unitPrice: 250 })).toEqual({ ok: true, text: 'Removed Votive Candle from your cart.' });
    expect(s.cart).toEqual([]);
    expect(setLine(s, { sku: 'CANDLE', qty: -0, unitPrice: 250 }).ok).toBe(true); // -0 is 0
    expect(s.cart).toEqual([]);
  });

  it('keeps a return line apart from the purchase line of the same SKU', () => {
    const s = shop();
    setLine(s, { sku: 'ROSARY', qty: 1, unitPrice: 4000 });
    expect(setLine(s, { sku: 'ROSARY', qty: -3, unitPrice: 4000, kind: 'return' }).text).toBe("Cart updated: Pilgrim's Rosary (return) × -3.");
    expect(s.cart).toEqual([
      { sku: 'ROSARY', qty: 1, unitPrice: 4000 },
      { sku: 'ROSARY', qty: -3, unitPrice: 4000, kind: 'return' },
    ]);
  });

  it('stores what the level decided without judging it: negative quantities and prices are kept as given', () => {
    const s = shop();
    setLine(s, { sku: 'ROSARY', qty: -25, unitPrice: 4000 });
    setLine(s, { sku: 'CANDLE', qty: 1, unitPrice: -1 });
    expect(s.cart).toEqual([{ sku: 'ROSARY', qty: -25, unitPrice: 4000 }, { sku: 'CANDLE', qty: 1, unitPrice: -1 }]);
  });

  it('platform safety: |qty| up to 9 999 999 999 is stored, anything beyond (or not a number) is refused', () => {
    const s = shop();
    expect(LIMITS.qty).toBe(9_999_999_999);
    expect(setLine(s, { sku: 'CANDLE', qty: 9_999_999_999, unitPrice: 250 }).ok).toBe(true);
    expect(setLine(s, { sku: 'ROSARY', qty: -9_999_999_999, unitPrice: 4000 }).ok).toBe(true);
    for (const qty of [10_000_000_000, -10_000_000_000, Infinity, -Infinity, Number.NaN]) {
      expect(setLine(s, { sku: 'RELIQUARY', qty, unitPrice: 100000 }), String(qty)).toEqual({ ok: false, text: 'Quantity too large for this shop.' });
    }
    expect(s.cart).toHaveLength(2);
  });

  it('a fractional quantity or an unsafe unit price is a programming error, not a cart line', () => {
    const s = shop();
    expect(() => setLine(s, { sku: 'CANDLE', qty: 1.5, unitPrice: 250 })).toThrow(TypeError);
    expect(() => setLine(s, { sku: 'CANDLE', qty: 1, unitPrice: 2 ** 53 })).toThrow(TypeError);
    expect(s.cart).toEqual([]);
  });

  it('platform safety: a 21st line is refused, while a line already in a full cart can still change', () => {
    const s = shop();
    for (let i = 0; i < LIMITS.cartLines; i++) s.cart.push({ sku: 'RELIQUARY', qty: 1, unitPrice: 100000 });
    expect(setLine(s, { sku: 'CANDLE', qty: 1, unitPrice: 250 })).toEqual({ ok: false, text: 'Your cart is full (20 lines).' });
    expect(s.cart).toHaveLength(20);
    expect(setLine(s, { sku: 'RELIQUARY', qty: 2, unitPrice: 100000 }).ok).toBe(true);
    expect(setLine(s, { sku: 'RELIQUARY', qty: 0, unitPrice: 100000 }).ok).toBe(true);
    expect(s.cart).toHaveLength(19);
    expect(setLine(s, { sku: 'CANDLE', qty: 1, unitPrice: 250 }).ok).toBe(true);
  });

  it('stores a copy: changing the object passed in later changes nothing', () => {
    const s = shop();
    const line = { sku: 'CANDLE', qty: 1, unitPrice: 250 };
    setLine(s, line);
    line.qty = 99;
    expect(s.cart[0].qty).toBe(1);
  });
});

describe('orders', () => {
  it('placeOrder snapshots the cart, debits the charge, clears cart and discounts and numbers orders from 1', () => {
    let t = 1_700_000_000_000;
    const s = shop();
    s.clock = { now: () => t, wait: async () => {} };
    setLine(s, { sku: 'CANDLE', qty: 2, unitPrice: 250 });
    s.discounts.push({ code: 'X', amount: 0 });
    const first = placeOrder(s, { lines: orderLines(s), subtotal: 500, total: 500, charged: 500 });
    expect(first).toMatchObject({
      no: 1, owner: 'C-1042', status: 'paid', subtotal: 500, total: 500, charged: 500, at: t,
      lines: [{ sku: 'CANDLE', name: 'Votive Candle', qty: 2, unitPrice: 250, listPrice: 250 }],
      discounts: [{ code: 'X', amount: 0 }],
    });
    expect(s).toMatchObject({ wallet: 4500, cart: [], discounts: [], nextOrderNo: 2 });
    t += 1;
    setLine(s, { sku: 'ROSARY', qty: -1, unitPrice: 4000, kind: 'return' });
    const second = placeOrder(s, { lines: orderLines(s), subtotal: -4000, total: -4000, charged: -4000 });
    expect(second).toMatchObject({ no: 2, lines: [{ sku: 'ROSARY', qty: -1, kind: 'return' }] });
    expect(s.wallet).toBe(8500); // a negative charge credits the wallet
    expect(s.orders.map((o) => o.no)).toEqual([1, 2]);
  });

  it('an order line keeps qty, unit price and list price, so a proof never reads the current catalog', () => {
    const s = shop();
    setLine(s, { sku: 'RELIQUARY', qty: 1, unitPrice: 5 });
    const [line] = orderLines(s);
    expect(line).toEqual({ sku: 'RELIQUARY', name: 'Reliquary', qty: 1, unitPrice: 5, listPrice: 100000 });
  });

  it('platform safety: a charge or a wallet that would leave the safe integers is refused and changes nothing', () => {
    const s = shop(Number.MAX_SAFE_INTEGER - 10);
    setLine(s, { sku: 'CANDLE', qty: 1, unitPrice: 250 });
    expect(placeOrder(s, { lines: orderLines(s), subtotal: 0, total: 0, charged: -11 })).toBe(OUT_OF_RANGE);
    expect(placeOrder(s, { lines: orderLines(s), subtotal: 0, total: 0, charged: 2 ** 53 })).toBe(OUT_OF_RANGE);
    expect(s.orders).toEqual([]);
    expect(s.cart).toHaveLength(1);
    expect(s.wallet).toBe(Number.MAX_SAFE_INTEGER - 10);
  });

  it('platform safety: pushOrder keeps the newest 30 orders', () => {
    const s = shop();
    for (let no = 1; no <= 31; no++) pushOrder(s, order(no));
    expect(LIMITS.orders).toBe(30);
    expect(s.orders.map((o) => o.no)).toEqual(Array.from({ length: 30 }, (_, i) => i + 2));
  });
});

describe('money', () => {
  it('formatMoney: US dollars from integer cents, negatives as -$, exact for every safe integer', () => {
    const cases: [number, string][] = [
      [5000, '$50.00'], [0, '$0.00'], [-0, '$0.00'], [1, '$0.01'], [-5, '-$0.05'], [-1000, '-$10.00'],
      [100000, '$1,000.00'], [100_000_000, '$1,000,000.00'], [-1_295_267_296, '-$12,952,672.96'],
      [Number.MAX_SAFE_INTEGER, '$90,071,992,547,409.91'], [-Number.MAX_SAFE_INTEGER, '-$90,071,992,547,409.91'],
    ];
    for (const [cents, text] of cases) expect(formatMoney(cents), String(cents)).toBe(text);
  });

  it('insufficientFunds names the total and the wallet through formatMoney', () => {
    expect(insufficientFunds(100000, 5000)).toBe('Insufficient funds: the total is $1,000.00 and your wallet holds $50.00.');
  });

  it('cartTotal: exact sum of qty x unit price, undefined when it leaves the safe integers', () => {
    expect(cartTotal([])).toBe(0);
    expect(cartTotal([{ sku: 'RELIQUARY', qty: 1, unitPrice: 100000 }, { sku: 'ROSARY', qty: -25, unitPrice: 4000 }])).toBe(0);
    expect(cartTotal([{ sku: 'CANDLE', qty: 99, unitPrice: Number.MAX_SAFE_INTEGER }])).toBeUndefined();
  });

  it('exactValue: sum of list price x qty in BigInt, exact beyond 2^53', () => {
    expect(exactValue([])).toBe(0n);
    expect(exactValue([{ qty: 1, listPrice: 999900 }, { qty: 4293967496, listPrice: 1 }])).toBe(4294967396n);
    expect(exactValue([{ qty: 9_999_999_999, listPrice: 19_999_999 }])).toBe(199_999_989_980_000_001n);
  });

  it('the shopper is pilgrim, customer C-1042', () => {
    expect(CUSTOMER).toEqual({ username: 'pilgrim', id: 'C-1042', email: 'pilgrim@relic-market.test' });
    expect(Object.isFrozen(CUSTOMER)).toBe(true);
    expect(LIMITS).toMatchObject({ cartLines: 20, orders: 30, discounts: 10, history: 30, text: 100 });
  });
});

describe('clock', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('realClock.now is Date.now by default', () => {
    const before = Date.now();
    const now = realClock.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it('realClock.wait is a real timer, clamped to 0 .. 5000 ms', async () => {
    vi.useFakeTimers();
    expect(MAX_WAIT_MS).toBe(5000);
    let done = false;
    void realClock.wait(60_000).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(4999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    for (const ms of [-1, Number.NaN, 0]) {
      let ok = false;
      void realClock.wait(ms).then(() => { ok = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(ok, String(ms)).toBe(true);
    }
  });

  it('setClockForTests swaps now and wait (the clamp still applies) and restore puts them back', async () => {
    const waits: number[] = [];
    const restore = setClockForTests({ now: () => 42, wait: async (ms) => { waits.push(ms); } });
    expect(realClock.now()).toBe(42);
    await realClock.wait(9000);
    expect(waits).toEqual([5000]);
    const inner = setClockForTests({ now: () => 7 });
    expect(realClock.now()).toBe(7);
    await realClock.wait(1);
    expect(waits).toEqual([5000, 1]); // wait kept from the outer swap
    inner();
    restore();
    expect(Math.abs(realClock.now() - Date.now())).toBeLessThan(1000);
  });
});

describe('the test kit clocks', () => {
  describe('useFakeClock', () => {
    const clock = useFakeClock();
    it('wait advances virtual time at once; now reads it', async () => {
      const t0 = clock.now();
      expect(realClock.now()).toBe(t0);
      const real = Date.now();
      await realClock.wait(2000);
      expect(clock.now() - t0).toBe(2000);
      await realClock.wait(9000); // clamped before the clock sees it
      expect(clock.now() - t0).toBe(7000);
      expect(Date.now() - real).toBeLessThan(1000);
    });
  });

  describe('useInstantWaits', () => {
    useInstantWaits();
    it('waits resolve at once, without moving now', async () => {
      const real = Date.now();
      await realClock.wait(5000);
      expect(Date.now() - real).toBeLessThan(1000);
    });
  });

  it('both restore the real clock after their block', async () => {
    vi.useFakeTimers();
    let done = false;
    void realClock.wait(10).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(9);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    vi.useRealTimers();
  });
});

describe('race primitives', () => {
  it('waitGate: arrive is a no-op and pass(ms) is the clock\'s wait', async () => {
    const waits: number[] = [];
    const clock: LabClock = { now: () => 0, wait: async (ms) => { waits.push(ms); } };
    const gate = waitGate(clock);
    gate.arrive();
    await gate.pass(1000);
    expect(waits).toEqual([1000]);
    expect(newShop({ catalog: CATALOG, wallet: 0 }).gate).toBeDefined();
  });

  it('KeyedMutex runs one key FIFO, other keys concurrently, survives a rejection and forgets idle keys', async () => {
    const m = new KeyedMutex();
    const log: string[] = [];
    let releaseFirst = () => {};
    const first = m.run('k', async () => {
      log.push('a start');
      await new Promise<void>((r) => { releaseFirst = r; });
      log.push('a end');
      return 'a';
    });
    const second = m.run('k', async () => { log.push('b'); throw new Error('b failed'); });
    const third = m.run('k', () => { log.push('c'); return 'c'; });
    const other = m.run('other', () => { log.push('other'); return 'o'; });
    await other;
    expect(log).toEqual(['a start', 'other']);
    await new Promise((r) => { setTimeout(r, 0); }); // let the settled key's bookkeeping run
    expect(m.size).toBe(1); // 'other' is idle and forgotten; 'k' still has work queued
    releaseFirst();
    expect(await first).toBe('a');
    await expect(second).rejects.toThrow('b failed');
    expect(await third).toBe('c');
    expect(log).toEqual(['a start', 'other', 'a end', 'b', 'c']);
    await new Promise((r) => { setTimeout(r, 0); });
    expect(m.size).toBe(0);
  });

  it('barrierGate releases every pass once n requests have arrived (arrivals, not passes, count)', async () => {
    const b = barrierGate(2);
    b.gate.arrive();
    let released = false;
    const p = b.gate.pass(1000).then(() => { released = true; });
    await Promise.resolve();
    expect(released).toBe(false);
    b.gate.arrive(); // a request refused before pass still counts
    await p;
    expect(b.arrived()).toBe(2);
    expect(b.timedOut()).toBe(false);
    await b.gate.pass(1000); // past the barrier: at once
  });

  it('barrierGate: every check runs before any update, whatever the order the requests reach pass', async () => {
    const b = barrierGate(2);
    const log: string[] = [];
    const request = async (name: string) => {
      b.gate.arrive();
      log.push(`${name} check`);
      await b.gate.pass(1000);
      log.push(`${name} update`);
    };
    await Promise.all([request('one'), request('two')]);
    expect(log.slice(0, 2).sort()).toEqual(['one check', 'two check']);
    expect(b.timedOut()).toBe(false);
  });

  it('barrierGate: the fallback releases a stuck pass and sets timedOut', async () => {
    const b = barrierGate(2, 20);
    b.gate.arrive();
    await b.gate.pass(1000);
    expect(b.timedOut()).toBe(true);
    expect(b.arrived()).toBe(1);
  });
});

describe('sql helpers', () => {
  const db = challengeDb('CREATE TABLE t (n INTEGER)', (raw) => {
    const ins = raw.prepare('INSERT INTO t (n) VALUES (?)');
    for (let i = 1; i <= 100; i++) ins.run(i);
  });

  it('firstRows stops reading at max (the cap where the player controls the query), with bound parameters', () => {
    const stmt = db.prepare('SELECT n FROM t WHERE n > ? ORDER BY n');
    expect(firstRows(stmt, 3, 10)).toEqual([{ n: 11 }, { n: 12 }, { n: 13 }]);
    expect(firstRows(stmt, 0, 10)).toEqual([]);
    expect(firstRows(stmt, 500, 98)).toEqual([{ n: 99 }, { n: 100 }]);
    expect(firstRows(db.prepare('SELECT n FROM t'), 50)).toHaveLength(50); // the statement is reusable after an early stop
  });

  it('clip: a cell as text, at most n characters (default 200)', () => {
    expect(clip('x'.repeat(300))).toHaveLength(200);
    expect(clip('abcdef', 3)).toBe('abc');
    expect(clip(null)).toBe('');
    expect(clip(undefined)).toBe('');
    expect(clip(42)).toBe('42');
  });
});
