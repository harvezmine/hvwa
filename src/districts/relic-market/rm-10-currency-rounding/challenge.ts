// challenge.ts — RM-10 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, field } from '../../../core/lab.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import { OUT_OF_RANGE, formatMoney, pushHistory } from '../_shared/shop.js';
import { baseView, endpointsOf, flagLine, mountIntents, refusal, success, type Intent, type Outcome } from '../_shared/shop-lab.js';
import {
  MAX_BALANCE, balanceOf, goalScaled, isCurrency, isPair, labFor, netWorthScaled, proves, resetLab, setBalance, type Currency, type RateLevel,
} from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const view = join(dir, 'views', 'exchange.ejs');
const impl = byLevel<RateLevel>({ acolyte, templar, inquisitor, divine });

const AMOUNT = /^\d{1,9}$/;

/**
 * Exchange (plumbing at every level): only USD against crowns or rupiah, an amount of 1 to 9 digits within the
 * balance. The level decides how many units leave and arrive; the route books it and keeps the balances inside
 * MAX_BALANCE (platform safety).
 */
function exchange(req: Request): Outcome {
  const state = labFor(req);
  const from = field(req, 'from');
  const to = field(req, 'to');
  if (!isCurrency(from) || !isCurrency(to) || !isPair(from, to)) return refusal('Exchanges are USD to crowns, or USD to rupiah, and back.');
  const raw = field(req, 'amount');
  if (!AMOUNT.test(raw)) return refusal('Amount must be a whole number of 1 to 9 digits.');
  const n = Number(raw);
  if (n < 1) return refusal('Enter an amount above zero.');
  if (n > balanceOf(state, from)) return refusal('Insufficient balance.');
  const done = impl.for(req.level).convert(from, to, n);
  if (typeof done === 'string') return refusal(done);
  const left = balanceOf(state, from) - done.debit;
  const right = balanceOf(state, to) + done.credit;
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || right > MAX_BALANCE) return refusal(OUT_OF_RANGE);
  setBalance(state, from, left);
  setBalance(state, to, right);
  pushHistory(state.history, Object.freeze({ no: state.nextOrderNo, from, to, debit: done.debit, credit: done.credit }));
  state.nextOrderNo += 1;
  if (proves(state)) state.goalReached = true; // recorded: the flag stays after later trades
  return success(`Exchanged ${formatMoney(done.debit, from)} for ${formatMoney(done.credit, to)}.`);
}

/** The page's action: POST / with a hidden intent, or its own path. */
const INTENTS: Readonly<Record<string, Intent>> = {
  exchange: { path: '/exchange', fields: ['from', 'to', 'amount'], run: exchange },
};

const CURRENCY_NAMES: Readonly<Record<Currency, string>> = { USD: 'US dollars (cents)', CRN: 'Crowns', IDR: 'Rupiah' };
const CODES: readonly Currency[] = ['USD', 'CRN', 'IDR'];

async function render(req: Request, res: Response, outcome: Outcome): Promise<void> {
  const state = labFor(req);
  const scaled = netWorthScaled(state);
  const kept = outcome.intent === 'exchange';
  await sendPage(res, view, baseView(req, res, {
    result: outcome.result, intent: outcome.intent, wallet: state.wallet, endpoints: endpointsOf(INTENTS),
    curl: { path: '/exchange', form: { from: 'USD', to: 'CRN', amount: '300' }, signIn: false },
    api: [{ path: '/api/rates', description: 'the posted rates of this level (JSON)' }],
    extra: {
      balances: CODES.map((code) => ({ code, name: CURRENCY_NAMES[code], units: balanceOf(state, code), text: formatMoney(balanceOf(state, code), code) })),
      worth: { text: formatMoney(Number(scaled / 325n)), exact: `${scaled}/325 cents` },
      goal: { text: formatMoney(Number(goalScaled(state) / 325n)), reached: state.goalReached, flag: state.goalReached ? flagLine(req, RM10) : '' },
      rates: Object.entries(impl.for(req.level).RATES).map(([code, cols]) => ({ code, cols: Object.entries(cols) })),
      history: [...state.history].reverse().map((h) => ({
        no: h.no, debit: h.debit, text: `Exchanged ${formatMoney(h.debit, h.from)} for ${formatMoney(h.credit, h.to)}.`,
      })).slice(0, 30),
      choices: CODES, kept: { from: kept ? field(req, 'from') : 'USD', to: kept ? field(req, 'to') : 'CRN', amount: kept ? field(req, 'amount') : '' },
    },
  }));
}

export const RM10 = register(defineChallenge({
  id: 'RM-10', district: 'relic-market', slug: 'currency-rounding', dir,
  title: { id: 'Penyalahgunaan Pembulatan Mata Uang', en: 'Currency Rounding Abuse' },
  summary: {
    id: 'Tukar uang di money changer pasar sampai nilai bersihmu naik setidaknya $1.00 dari modal awal.',
    en: 'Trade at the market\'s money changer until your net worth is at least $1.00 above what you started with.',
  },
  maps: ['A06:2025', 'CWE-682', 'CWE-1339'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Crown hanya ada dalam satuan utuh. Ke arah mana penukaran membulatkan setengah crown, dan siapa yang diuntungkan?', en: 'Crowns only come in whole units. Which way does an exchange round half a crown, and who gains?' } },
    { id: 2, cost: 20, text: { id: 'Batas minimum menghentikan penukaran kecil. Apakah batas itu juga mengubah cara hasilnya dibulatkan?', en: 'A minimum stops tiny exchanges. Does it also change how the result is rounded?' } },
    { id: 3, cost: 40, text: { id: 'Di Inquisitor jumlah selalu dibulatkan ke bawah. Bandingkan kedua kurs IDR yang diterbitkan di /api/rates: apakah keduanya benar-benar saling berkebalikan?', en: 'At Inquisitor amounts always round down. Compare the two IDR rates published at /api/rates: are they really the inverse of each other?' } },
  ],
  // Restart: spent or lost balances otherwise stick for 26 h. No limiter or budget here, and the goal is measured
  // against this instance's own start, so a fresh shop helps no exploit.
  reset: (req) => { resetLab(req); },
  mount: (router) => {
    router.get('/', async (req, res) => { await render(req, res, { result: null }); });
    // Public at every level: whatever rates the level converts with are published, which is how the flaw is found.
    router.get('/api/rates', (req, res) => {
      res.json({ level: req.level, base: 'USD', rates: impl.for(req.level).RATES });
    });
    mountIntents(router, INTENTS, render);
  },
}));
