// challenge.ts — RM-03 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, field, labPath, tryDb } from '../../../core/lab.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import { curlFor } from '../../_shared/curl.js';
import { realClock } from '../_shared/clock.js';
import { endpointsOf, mountIntents, refusal, success, type Intent, type Outcome } from '../_shared/shop-lab.js';
import { clip } from '../_shared/sql.js';
import { redeemCode } from '../_shared/staff-code.js';
import { LAST_ORDER, measured, ordersDb, vaultPin, type TrackLevel } from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const view = join(dir, 'views', 'track.ejs');
const impl = byLevel<TrackLevel>({ acolyte, templar, inquisitor, divine });

/**
 * Track an order. The answer is the same for a hit, a miss and a database error (blind, at every level: decision Q4);
 * only a refused input says so. The query runs synchronously and only RECORDS the delay sleep() asked for; the shop
 * then waits that long on its clock (clamped to 5 s, instant in tests) and answers. Nothing here ever blocks.
 */
async function track(req: Request): Promise<Outcome> {
  const orderNo = field(req, 'order_no');
  const { value: found, delayMs } = measured(req.level, () => tryDb(req, () => impl.for(req.level).lookup(ordersDb(req.level), orderNo)));
  await realClock.wait(delayMs);
  if (found.ok && typeof found.value === 'string') return refusal(found.value);
  // A database error (found.ok false) is deliberately the same answer: never found.message.
  return success(`If order ${clip(orderNo, 100)} exists, its status has been emailed to the address on file.`);
}

/** Redeem the vault PIN read out through the timing oracle (no limiter, on purpose: 6 hex characters are no brute-force target). */
function redeem(req: Request): Outcome {
  return { result: redeemCode(req, RM03, vaultPin(req.level), field(req, 'code'), 'vault PIN') };
}

const INTENTS: Readonly<Record<string, Intent>> = {
  track: { path: '/track', fields: ['order_no'], run: track },
  redeem: { path: '/redeem', fields: ['code'], run: redeem },
};

async function render(req: Request, res: Response, outcome: Outcome): Promise<void> {
  const intent = outcome.intent ?? field(req, 'intent');
  await sendPage(res, view, {
    base: labPath(res), served: req.level, result: outcome.result, lastOrder: LAST_ORDER,
    orderNo: intent === 'track' ? field(req, 'order_no') : '', code: intent === 'redeem' ? field(req, 'code') : '',
    endpoints: endpointsOf(INTENTS).map((e) => ({ ...e, href: `${labPath(res)}${e.path}?level=${req.level}` })),
    curl: curlFor(req, res, { path: '/track', form: { order_no: LAST_ORDER }, signIn: false }),
  });
}

export const RM03 = register(defineChallenge({
  id: 'RM-03', district: 'relic-market', slug: 'blind-time-sqli', dir,
  title: { id: 'SQLi Buta Berbasis Waktu', en: 'Blind Time-Based SQLi' },
  summary: {
    id: 'Pelacak pesanan selalu memberi jawaban yang sama. Ukur waktu jawabannya untuk membaca PIN brankas, lalu tukarkan PIN itu.',
    en: 'The order tracker always gives the same answer. Time its replies to read the vault PIN, then redeem it.',
  },
  maps: ['A05:2025', 'CWE-89'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Kalau isi jawaban tidak pernah berubah, apa lagi yang bisa kamu ukur? Fungsi apa yang disediakan lapisan database toko ini?', en: "If the content of the answer never changes, what else can you measure? Which functions does this shop's database layer provide?" } },
    { id: 2, cost: 20, text: { id: 'Filter Templar menolak satu karakter yang biasanya ada di antara kata-kata SQL. Apa lagi yang bisa memisahkan kata dalam SQL?', en: "Templar's filter rejects one character that usually sits between SQL words. What else can separate words in SQL?" } },
    { id: 3, cost: 40, text: { id: 'Di Inquisitor input dicek dengan regex. Apa arti ^ dan $ ketika regex memakai flag m, dan apakah input harus satu baris?', en: 'At Inquisitor the input is checked with a regex. What do ^ and $ mean when the regex has the m flag, and must the input be one line?' } },
  ],
  // No Restart: nothing here mutates, and there is no limiter or budget to reset.
  mount: (router) => {
    router.get('/', async (req, res) => { await render(req, res, { result: null }); });
    mountIntents(router, INTENTS, render);
  },
}));
