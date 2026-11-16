// src/districts/relic-market/_shared/shop-lab.testkit.ts — what the Relic Market shop specs share: deterministic race
// windows and clocks, readers for the shop page's machine-readable hooks, and describeShopBasics().
// A test kit (docs/RECIPES.md section 1): `*.testkit.ts` is never collected as a spec and never reaches dist/.
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import type request from 'supertest';
import type { Express } from 'express';
import { FLAG_RE, freshSession, unescapeHtml, type Agent } from '../../../../tests/helpers.js';
import { LEVELS, type Level } from '../../../core/levels.js';
import type { Challenge } from '../../../core/registry.js';
import { setClockForTests } from './clock.js';
import type { Gate } from './race.js';
import { LIMITS, formatMoney, type ShopState } from './shop.js';

// --- Races and clocks ---------------------------------------------------------------------------------------------

/** A gate for one race in a spec: see barrierGate. */
export interface Barrier {
  readonly gate: Gate;
  /** True once the fallback had to release a pass: a regression (a request never arrived). Specs assert false. */
  timedOut(): boolean;
  /** Requests that arrived so far. */
  arrived(): number;
}

/**
 * A deterministic race window: every `pass()` resolves once `n` requests have ARRIVED (gate.arrive(), the route's
 * first statement), not once n reached pass: a Divine request refused before pass still counts, so the barrier never
 * deadlocks. Released waiters resume as microtasks after the current synchronous segment, so with
 * `Promise.all([post, post])` every request has done its check before any request does its update. Install it on one
 * session's state (`labState(sid, level).gate = barrierGate(2).gate`). A pass still waiting after `fallbackMs` is
 * released and timedOut() turns true.
 */
export function barrierGate(n: number, fallbackMs = 2000): Barrier {
  let count = 0;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waiters: (() => void)[] = [];
  const release = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    for (const w of waiters.splice(0)) w();
  };
  const gate: Gate = {
    arrive: () => {
      count += 1;
      if (count >= n) release();
    },
    pass: () => {
      if (count >= n) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
        timer ??= setTimeout(() => { timedOut = true; release(); }, fallbackMs);
      });
    },
  };
  return { gate, timedOut: () => timedOut, arrived: () => count };
}

/** For the enclosing block: every realClock.wait resolves at once (legit cases of race labs never wait real time). */
export function useInstantWaits(): void {
  let restore: (() => void) | undefined;
  beforeAll(() => { restore = setClockForTests({ wait: async () => {} }); });
  afterAll(() => { restore?.(); });
}

/**
 * For the enclosing block: virtual time. realClock.wait(ms) advances it by ms (after the 5000 ms clamp) and resolves at
 * once; realClock.now() and the returned now() read it. An exploit script measures now() before and after a request:
 * the delay is exact and the test instant.
 */
export function useFakeClock(): { now(): number } {
  let t = 1_700_000_000_000;
  let restore: (() => void) | undefined;
  beforeAll(() => { restore = setClockForTests({ now: () => t, wait: async (ms) => { t += ms; } }); });
  afterAll(() => { restore?.(); });
  return { now: () => t };
}

// --- Reading a shop page ------------------------------------------------------------------------------------------

/** The wallet in cents (the header's data-cents hook). */
export function walletOf(html: string): number {
  const m = /data-testid="wallet" data-cents="(-?\d+)"/.exec(html);
  if (m === null) throw new Error('walletOf: the page shows no wallet');
  return Number(m[1]);
}

/** An order as the page lists it (newest first). `flag` is set only when the order row carries one. */
export interface ShownOrder {
  readonly no: number;
  readonly total: number;
  readonly charged: number;
  readonly status: string;
  readonly flag?: string;
}

export function ordersOf(html: string): ShownOrder[] {
  const re = /<li data-order="(\d+)" data-total="(-?\d+)" data-charged="(-?\d+)" data-status="([^"]*)">([\s\S]*?)<\/li>/g;
  return [...html.matchAll(re)].map(([, no, total, charged, status, inner]): ShownOrder => {
    const flag = FLAG_RE.exec(inner)?.[0];
    return { no: Number(no), total: Number(total), charged: Number(charged), status, ...(flag === undefined ? {} : { flag }) };
  });
}

/** A cart line as the page shows it: `line` is its total in cents, null when the lab could not price it. */
export interface ShownLine { readonly sku: string; readonly qty: number; readonly line: number | null; readonly kind: string }

export function cartOf(html: string): ShownLine[] {
  const re = /<tr data-sku="([^"]*)" data-qty="(-?\d+)" data-line="(-?\d*)" data-kind="([^"]*)">/g;
  return [...html.matchAll(re)].map(([, sku, qty, line, kind]) => ({ sku, qty: Number(qty), line: line === '' ? null : Number(line), kind }));
}

/** Every field of a product's add-to-cart form (hidden ones and the quantity), values unescaped: what a browser posts. */
export function productForm(html: string, sku: string): Record<string, string> {
  const item = [...html.matchAll(/<li data-product="([^"]*)"[^>]*>([\s\S]*?)<\/li>/g)].find((m) => unescapeHtml(m[1]) === sku);
  const form = item === undefined ? undefined : /<form[^>]*>([\s\S]*?)<\/form>/.exec(item[2])?.[1];
  if (form === undefined) throw new Error(`productForm: no add-to-cart form for ${sku}`);
  const fields: Record<string, string> = {};
  for (const [tag] of form.matchAll(/<input[^>]*>/g)) {
    const name = /\bname="([^"]*)"/.exec(tag)?.[1];
    if (name !== undefined) fields[unescapeHtml(name)] = unescapeHtml(/\bvalue="([^"]*)"/.exec(tag)?.[1] ?? '');
  }
  return fields;
}

/** The page's endpoint list (views/endpoints), one entry per door: 'POST <href>', plus ' (fields)' when it names any. */
export function endpointsShown(html: string): string[] {
  const line = /<p class="lab-note" data-testid="endpoints">Endpoints: ([\s\S]*?)\. The forms on this page/.exec(html)?.[1];
  return line === undefined ? [] : line.split('; ').map((e) => unescapeHtml(e.replace(/<\/?code>/g, '')));
}

/** The catalog's SKUs with their prices in cents, as the page lists them. */
export function pricesOf(html: string): { readonly sku: string; readonly price: number }[] {
  return [...html.matchAll(/<li data-product="([^"]*)" data-price="(-?\d+)">/g)].map(([, sku, price]) => ({ sku: unescapeHtml(sku), price: Number(price) }));
}

// --- A shop lab's requests, as its specs send them -----------------------------------------------------------------

/** One player's session at one level (the matrix's send also hands over the app). */
export interface ShopCtx { readonly agent: Agent; readonly level: Level; readonly sid: string; readonly app?: Express }

/**
 * The requests every shop spec sends, for the lab at `path`: `ctx(level)` (a fresh session), `home(c)` (GET the page),
 * `form(c, body)` (a page form: POST / with the body's hidden intent), `post(c, sub, body?)` (a named path, e.g.
 * '/cart/return'), `add(c, sku, qty, extra?)` (POST /cart), `checkout(c)` (POST /checkout), `restart(c)` (POST /_reset).
 */
export function shopClient(path: string) {
  const url = (c: Pick<ShopCtx, 'level'>, sub = '') => `${path}${sub}?level=${c.level}`;
  const post = (c: ShopCtx, sub: string, body: Readonly<Record<string, string>> = {}) => c.agent.post(url(c, sub)).type('form').send({ ...body });
  return {
    ctx: async (level: Level): Promise<ShopCtx> => {
      const { agent, sid, app } = await freshSession();
      return { agent, level, sid, app };
    },
    home: (c: ShopCtx) => c.agent.get(url(c)),
    form: (c: ShopCtx, body: Readonly<Record<string, string>>) => post(c, '', body),
    post,
    add: (c: ShopCtx, sku: string, qty: string, extra: Readonly<Record<string, string>> = {}) => post(c, '/cart', { ...extra, sku, qty }),
    checkout: (c: ShopCtx) => post(c, '/checkout'),
    restart: (c: ShopCtx) => c.agent.post(url(c, '/_reset')),
  };
}

// --- describeShopBasics -------------------------------------------------------------------------------------------

export interface ShopBasicsSpec {
  readonly challenge: Pick<Challenge, 'id' | 'levels'>;
  /** The lab's base path, e.g. '/d/relic-market/negative-quantity'. */
  readonly path: string;
  /** The lab's test seam: the state of session `sid` at `level`. */
  readonly labState: (sessionId: string, level: Level) => ShopState;
  /** Whether the lab has Restart (POST <lab>/_reset); without it the route must be 404. */
  readonly hasRestart: boolean;
  /**
   * One ordinary purchase that places an order and spends from the wallet (default: the cheapest product bought with
   * its own add-to-cart form, then the page's checkout). A lab without a cart passes its own (a store-credit buy).
   */
  readonly purchase?: (agent: Agent, level: Level) => Promise<request.Response>;
  /** false for a lab without a cart: the cart checks (21st line, Restart empties the cart) are skipped. Default true. */
  readonly hasCart?: boolean;
}

/**
 * What every shop lab shares, through the real pages: GET / at every level, per-player and per-level isolation of a
 * purchase, Restart (start wallet, empty cart and orders, the cooldown answers 429) or no Restart (404), the 21st cart
 * line refused, orders trimmed to the newest 30, and money formatted as US dollars, negatives included.
 */
export function describeShopBasics(o: ShopBasicsSpec): void {
  const levels = LEVELS.filter((l) => o.challenge.levels.includes(l));
  const first = levels[0];
  const hasCart = o.hasCart ?? true;
  const url = (level: Level) => `${o.path}?level=${level}`;
  const page = async (agent: Agent, level: Level) => (await agent.get(url(level))).text;
  const post = (agent: Agent, level: Level, body: Record<string, string>) => agent.post(url(level)).type('form').send(body);
  const byPrice = (html: string) => [...pricesOf(html)].sort((a, b) => a.price - b.price);
  /** The cheapest product's own add-to-cart form, quantity 1. */
  const cheapestForm = (html: string) => ({ ...productForm(html, byPrice(html)[0].sku), qty: '1' });
  const buy = o.purchase ?? (async (agent: Agent, level: Level): Promise<request.Response> => {
    await post(agent, level, cheapestForm(await page(agent, level)));
    return post(agent, level, { intent: 'checkout' });
  });

  describe(`${o.challenge.id} shop basics`, () => {
    it('GET / answers 200 at every level, signed in as pilgrim, with the start wallet', async () => {
      for (const level of levels) {
        const { agent, sid } = await freshSession();
        const res = await agent.get(url(level));
        expect(res.status, level).toBe(200);
        expect(res.text, level).toContain('Signed in as <code>pilgrim</code>');
        const start = o.labState(sid, level).startWallet;
        expect(walletOf(res.text), level).toBe(start);
        expect(res.text, level).toContain(formatMoney(start));
        expect(ordersOf(res.text), level).toEqual([]);
        expect(cartOf(res.text), level).toEqual([]);
      }
    });

    it('a purchase changes only this player\'s shop: another session keeps its wallet and has no orders', async () => {
      const a = await freshSession();
      const b = await freshSession();
      const res = await buy(a.agent, first);
      expect(res.status).toBe(200);
      expect(res.text).not.toMatch(FLAG_RE);
      expect(ordersOf(res.text)).toHaveLength(1);
      const start = o.labState(a.sid, first).startWallet;
      expect(walletOf(res.text)).toBeLessThan(start);
      const other = await page(b.agent, first);
      expect(walletOf(other)).toBe(start);
      expect(ordersOf(other)).toEqual([]);
    });

    it('levels are isolated: a purchase at one level leaves every other level as it started', async () => {
      const { agent, sid } = await freshSession();
      await buy(agent, first);
      for (const level of levels.filter((l) => l !== first)) {
        const html = await page(agent, level);
        expect(walletOf(html), level).toBe(o.labState(sid, level).startWallet);
        expect(ordersOf(html), level).toEqual([]);
      }
    });

    if (o.hasRestart) {
      it('Restart lab restores the start wallet and empties the cart and the orders; the cooldown answers 429', async () => {
        const { agent, sid } = await freshSession();
        const start = o.labState(sid, first).startWallet;
        await buy(agent, first);
        if (hasCart) await post(agent, first, cheapestForm(await page(agent, first)));
        const before = await page(agent, first);
        expect(ordersOf(before)).toHaveLength(1);
        expect(cartOf(before)).toHaveLength(hasCart ? 1 : 0);
        const res = await agent.post(`${o.path}/_reset?level=${first}`);
        expect(res.status).toBe(303);
        expect(res.headers.location).toBe(url(first));
        const after = await page(agent, first);
        expect(walletOf(after)).toBe(start);
        expect(cartOf(after)).toEqual([]);
        expect(ordersOf(after)).toEqual([]);
        expect(o.labState(sid, first).nextOrderNo).toBe(1);
        expect((await agent.post(`${o.path}/_reset?level=${first}`)).status).toBe(429);
      });
    } else {
      it('has no Restart: POST <lab>/_reset is 404', async () => {
        const { agent } = await freshSession();
        expect((await agent.post(`${o.path}/_reset?level=${first}`)).status).toBe(404);
      });
    }

    if (hasCart) {
      it('platform safety: a 21st cart line is refused', async () => {
        const { agent, sid } = await freshSession();
        const html = await page(agent, first);
        const priciest = byPrice(html).at(-1);
        if (priciest === undefined) throw new Error('the catalog is empty');
        const state = o.labState(sid, first);
        // A full cart through the seam (a shop of a few SKUs cannot fill one through its forms).
        for (let i = 0; i < LIMITS.cartLines; i++) state.cart.push({ sku: priciest.sku, qty: 1, unitPrice: priciest.price });
        const res = await post(agent, first, cheapestForm(html));
        expect(res.status).toBe(200);
        expect(res.text).toContain('Your cart is full (20 lines).');
        expect(cartOf(res.text)).toHaveLength(LIMITS.cartLines);
      });
    }

    it('platform safety: the order list keeps the newest 30', async () => {
      const { agent, sid } = await freshSession();
      await page(agent, first);
      o.labState(sid, first).wallet = 10_000_000;
      let last: request.Response | undefined;
      for (let i = 0; i < LIMITS.orders + 1; i++) last = await buy(agent, first);
      const nos = ordersOf(last?.text ?? '').map((x) => x.no);
      expect(nos).toEqual(Array.from({ length: LIMITS.orders }, (_, i) => LIMITS.orders + 1 - i));
    });

    it('money is US dollars from integer cents, negatives as -$', async () => {
      const { agent, sid } = await freshSession();
      await page(agent, first);
      const state = o.labState(sid, first);
      for (const [cents, text] of [[-1050, '-$10.50'], [123456, '$1,234.56'], [0, '$0.00']] as const) {
        state.wallet = cents;
        const html = await page(agent, first);
        expect(walletOf(html)).toBe(cents);
        expect(html).toContain(`data-cents="${cents}">${text}</strong>`);
      }
    });
  });
}
