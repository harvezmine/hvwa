// challenge.ts — RM-08 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, field } from '../../../core/lab.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import { clipText } from '../_shared/shop.js';
import { baseView, endpointsOf, flagLine, mountIntents, ordersView, refusal, type Intent, type Outcome } from '../_shared/shop-lab.js';
import { labFor, proves, resetLab, type UnderflowLevel } from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const view = join(dir, 'views', 'credit.ejs');
const impl = byLevel<UnderflowLevel>({ acolyte, inquisitor, divine });

/**
 * Buy the lantern. The route arrives at the gate FIRST, before any lock and before the level, with no await in
 * between (docs/RECIPES.md section 11): a request queued on a lock still counts, and arrival and the level's check
 * share one synchronous segment. Races only exist in what the level does after that.
 */
async function buy(req: Request): Promise<Outcome> {
  const state = labFor(req);
  state.gate.arrive();
  return { result: await impl.for(req.level).buy(state) };
}

/** Send a gift card. The recipient is plumbing at every level: required text, clipped; the spending is the level's. */
async function gift(req: Request): Promise<Outcome> {
  const state = labFor(req);
  state.gate.arrive();
  const to = clipText(field(req, 'to').trim());
  if (to === '') return refusal('Who is the gift for?');
  return { result: await impl.for(req.level).gift(state, to) };
}

/** The page's actions: POST / with a hidden intent, or each one's own path. */
const INTENTS: Readonly<Record<string, Intent>> = {
  buy: { path: '/wallet/buy', run: buy },
  gift: { path: '/wallet/gift', fields: ['to'], run: gift },
};

async function render(req: Request, res: Response, outcome: Outcome): Promise<void> {
  const state = labFor(req);
  await sendPage(res, view, {
    ...baseView(req, res, {
      result: outcome.result, intent: outcome.intent, wallet: state.wallet, endpoints: endpointsOf(INTENTS),
      curl: { path: '/wallet/gift', form: { to: 'friend@relic-market.test' }, signIn: false },
      extra: {
        // The proof is the balance itself, shown with its flag below Divine (never at Divine), outside any tryDb.
        flag: proves(state) ? flagLine(req, RM08) : '',
        gifts: state.gifts.map((g) => g.to),
        toKept: outcome.intent === 'gift' ? field(req, 'to') : '',
      },
    }),
    ...ordersView(req, state, { challenge: RM08, proves: () => false }),
  });
}

export const RM08 = register(defineChallenge({
  id: 'RM-08', district: 'relic-market', slug: 'race-balance-underflow', dir,
  title: { id: 'Race Condition: Saldo Minus (Single-Packet)', en: 'Race Condition: Balance Underflow (Single-Packet)' },
  summary: {
    id: 'Buat saldo kredit tokomu negatif dengan membelanjakan lebih dari yang kamu punya.',
    en: 'Make your store-credit balance go negative by spending more than you have.',
  },
  maps: ['A06:2025', 'CWE-362', 'CWE-367'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Setiap pembayaran dicatat ke buku besar dan itu butuh waktu. Apakah saldo diperiksa dan dikurangi dalam satu langkah, atau ada jeda di antaranya?', en: 'Every payment is written to the ledger, and that takes time. Is the balance checked and reduced in one step, or is there a pause in between?' } },
    { id: 2, cost: 20, text: { id: 'Permintaan baru benar-benar balapan bila tiba bersamaan. Bagaimana alat seperti Burp ("send group in parallel") atau job paralel di shell menyelaraskannya?', en: 'Requests only really race if they arrive together. How do tools like Burp ("send group in parallel") or parallel shell jobs line them up?' } },
    { id: 3, cost: 40, text: { id: 'Di Inquisitor setiap endpoint memakai kunci. Apakah kunci itu melindungi dompet, atau hanya endpoint itu sendiri? Ada berapa cara membelanjakan kredit?', en: 'At Inquisitor each endpoint takes a lock. Does the lock protect the wallet, or only that endpoint? How many ways are there to spend credit?' } },
  ],
  // Restart: a spent (or negative) balance otherwise sticks for 26 h. No limiter or budget here: a fresh shop starts
  // with exactly the $20.00 it started with, and the proof is measured against this instance.
  reset: (req) => { resetLab(req); },
  mount: (router) => {
    router.get('/', async (req, res) => { await render(req, res, { result: null }); });
    mountIntents(router, INTENTS, render);
  },
}));
