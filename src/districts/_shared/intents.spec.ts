// src/districts/_shared/intents.spec.ts — the intent routing every district's lab landing pages share (moved with it from
// relic-market/_shared/shop-lab.spec.ts, owner decision Q15).
import express, { Router, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { endpointsOf, mountIntents, refusal, success, type Intent, type Outcome } from './intents.js';

describe('mountIntents', () => {
  const runs: string[] = [];
  const intents: Record<string, Intent> = {
    add: { path: '/cart', run: (req) => { runs.push(`add ${String((req.body as { sku?: unknown }).sku)}`); return { result: { ok: true, text: 'Added.' } }; } },
    checkout: { path: '/checkout', run: async () => ({ result: { ok: false, text: 'Refused.' }, status: 402 }) },
  };
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  const router = Router();
  mountIntents(router, intents, async (req: Request, res: Response, o: Outcome) => { res.json({ path: req.path, result: o.result }); });
  app.use('/lab', router);

  it('POST / dispatches on the intent field; each intent also has its own path', async () => {
    const root = await request(app).post('/lab').type('form').send({ intent: 'add', sku: 'CANDLE' });
    expect(root.status).toBe(200);
    expect(root.body).toEqual({ path: '/', result: { ok: true, text: 'Added.' } });
    const named = await request(app).post('/lab/cart').type('form').send({ sku: 'ROSARY' });
    expect(named.body).toEqual({ path: '/cart', result: { ok: true, text: 'Added.' } });
    expect(runs).toEqual(['add CANDLE', 'add ROSARY']);
  });

  it('an outcome status is the response status, on both doors', async () => {
    expect((await request(app).post('/lab').type('form').send({ intent: 'checkout' })).status).toBe(402);
    expect((await request(app).post('/lab/checkout')).status).toBe(402);
  });

  it('render learns which intent ran, on both doors (none for an unknown action)', async () => {
    const seen: (string | undefined)[] = [];
    const a = express();
    a.use(express.urlencoded({ extended: true }));
    const r = Router();
    mountIntents(r, intents, async (_req, res, o) => { seen.push(o.intent); res.end(); });
    a.use('/lab', r);
    await request(a).post('/lab').type('form').send({ intent: 'add' });
    await request(a).post('/lab/checkout');
    await request(a).post('/lab').type('form').send({ intent: 'nope' });
    expect(seen).toEqual(['add', 'checkout', undefined]);
  });

  it('endpointsOf lists each intent\'s own door with its fields, and mountIntents returns the same list', () => {
    const table: Record<string, Intent> = {
      add: { path: '/cart', fields: ['sku', 'qty'], run: () => ({ result: null }) },
      checkout: { path: '/checkout', run: () => ({ result: null }) },
    };
    const want = [
      { method: 'POST', path: '/cart', intent: 'add', fields: ['sku', 'qty'] },
      { method: 'POST', path: '/checkout', intent: 'checkout', fields: [] },
    ];
    expect(endpointsOf(table)).toEqual(want);
    expect(mountIntents(Router(), table, async () => {})).toEqual(want);
  });

  it('refuses a table whose paths collide with each other, with POST / or with the engine\'s routes', () => {
    const run = () => ({ result: null });
    const bad: Record<string, Intent>[] = [
      { a: { path: '/cart', run }, b: { path: '/cart', run } },
      { a: { path: '/', run } },
      { a: { path: '/_reset', run } },
      { a: { path: '/victim/check-mail', run } },
      { a: { path: 'cart', run } },
    ];
    for (const table of bad) expect(() => mountIntents(Router(), table, async () => {}), JSON.stringify(table)).toThrow(/mountIntents/);
  });

  it('a missing, unknown, inherited or non-string intent answers 200 "Unknown action." and runs nothing', async () => {
    runs.length = 0;
    const bodies: object[] = [{}, { intent: 'nope' }, { intent: 'constructor' }, { intent: '__proto__' }, { intent: 'toString' },
      { intent: ['add'] }, { intent: { add: 1 } }, []];
    for (const body of bodies) {
      const res = await request(app).post('/lab').send(body);
      expect(res.status, JSON.stringify(body)).toBe(200);
      expect(res.body.result, JSON.stringify(body)).toEqual({ ok: false, text: 'Unknown action.' });
    }
    expect(runs).toEqual([]);
  });
});

describe('refusal and success', () => {
  it('build the two outcomes of an intent: a message, no status', () => {
    expect(refusal('No.')).toEqual({ result: { ok: false, text: 'No.' } });
    expect(success('Done.')).toEqual({ result: { ok: true, text: 'Done.' } });
  });
});
