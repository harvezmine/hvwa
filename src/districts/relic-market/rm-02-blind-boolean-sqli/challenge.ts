// challenge.ts — RM-02 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, field, labPath, tryDb } from '../../../core/lab.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import { curlFor } from '../../_shared/curl.js';
import { endpointsOf, mountIntents, refusal, success, type Intent, type Outcome } from '../_shared/shop-lab.js';
import { redeemCode } from '../_shared/staff-code.js';
import { cell } from '../../_shared/sql.js';
import { DEFAULT_REGION, PRODUCTS, REGIONS, regionCookie, staffCode, stockDb, type StockLevel } from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const view = join(dir, 'views', 'stock.ejs');
const impl = byLevel<StockLevel>({ acolyte, templar, inquisitor, divine });

/** The region cookie as the browser sent it (a string, else the default: cookie-parser turns "j:{...}" into an object). */
function cookieRegion(req: Request): string {
  const v: unknown = (req.cookies as Record<string, unknown> | undefined)?.[regionCookie(req.level)];
  return typeof v === 'string' ? v : DEFAULT_REGION;
}

/** Stock check. Blind at every level: a database error is the same "Not available." as a miss (decision Q4). */
function checkStock(req: Request): Outcome {
  const level = impl.for(req.level);
  const sku = field(req, 'sku');
  const region = level.region(cookieRegion(req));
  const found = tryDb(req, () => level.inStock(stockDb(req.level), sku, region));
  if (!found.ok) return refusal('Not available.'); // never found.message: that would be an error-based oracle
  if (typeof found.value === 'string') return refusal(found.value);
  return found.value ? success(`${cell(sku, 100)}: In stock (${cell(region, 40)}).`) : refusal('Not available.');
}

/** The region setter writes only allowlisted values; a player edits the cookie directly to write anything else. */
function setRegion(req: Request, res: Response): Outcome {
  const wanted = field(req, 'region');
  const region = REGIONS.find((r) => r === wanted);
  if (region === undefined) return refusal('Unknown region.');
  res.cookie(regionCookie(req.level), region, { path: labPath(res), httpOnly: false, sameSite: 'lax' });
  res.locals.rm02Region = region; // the cookie only comes back on the next request: show the new value now
  return success(`Region set to ${region}.`);
}

/** Redeem the staff code read out through the oracle (no limiter, on purpose: 8 hex characters are no brute-force target). */
function redeem(req: Request): Outcome {
  return { result: redeemCode(req, RM02, staffCode(req.level), field(req, 'code'), 'staff code') };
}

const INTENTS: Readonly<Record<string, Intent>> = {
  check: { path: '/check', fields: ['sku'], run: checkStock },
  region: { path: '/region', fields: ['region'], run: setRegion },
  redeem: { path: '/redeem', fields: ['code'], run: redeem },
};

async function render(req: Request, res: Response, outcome: Outcome): Promise<void> {
  const shown: unknown = res.locals.rm02Region;
  const intent = outcome.intent ?? field(req, 'intent');
  await sendPage(res, view, {
    base: labPath(res), served: req.level, result: outcome.result,
    sku: intent === 'check' ? field(req, 'sku') : '', code: intent === 'redeem' ? field(req, 'code') : '',
    region: typeof shown === 'string' ? shown : cell(impl.for(req.level).region(cookieRegion(req)), 40),
    regions: REGIONS, products: PRODUCTS,
    endpoints: endpointsOf(INTENTS).map((e) => ({ ...e, href: `${labPath(res)}${e.path}?level=${req.level}` })),
    curl: curlFor(req, res, { path: '/check', form: { sku: 'RELIC-CHALICE' }, cookies: [`${regionCookie(req.level)}=eu`], signIn: false }),
  });
}

export const RM02 = register(defineChallenge({
  id: 'RM-02', district: 'relic-market', slug: 'blind-boolean-sqli', dir,
  title: { id: 'SQLi Buta Boolean', en: 'Blind Boolean SQLi' },
  summary: {
    id: 'Pemeriksa stok hanya menjawab "tersedia" atau "tidak". Gunakan jawaban itu untuk membaca kode staf (kolom code di tabel staff_codes), lalu tukarkan kodenya.',
    en: 'The stock checker only answers "in stock" or "not available". Use that answer to read the staff code (the code column of the staff_codes table), then redeem it.',
  },
  maps: ['A05:2025', 'CWE-89'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Halaman ini tidak pernah menampilkan data. Bisakah kamu membuat jawabannya bergantung pada pertanyaan benar/salah buatanmu sendiri?', en: 'The page never shows data. Can you make its answer depend on a true/false question of your own?' } },
    { id: 2, cost: 20, text: { id: 'Kalau operator logika yang biasa diblokir, cara lain apa yang dimiliki SQL untuk memilih nilai berdasarkan sebuah kondisi?', en: 'If the usual logical operators are blocked, what other ways does SQL have to pick a value depending on a condition?' } },
    { id: 3, cost: 40, text: { id: 'Di Inquisitor SKU sudah aman. Apa lagi yang dikirim browsermu ke pemeriksa stok setiap kali, tanpa kamu ketik?', en: 'At Inquisitor the SKU is safe. What else does your browser send to the stock checker every time, without you typing it?' } },
  ],
  // No Restart: nothing here mutates, and there is no limiter or budget to reset.
  mount: (router) => {
    router.get('/', async (req, res) => { await render(req, res, { result: null }); });
    mountIntents(router, INTENTS, render);
  },
}));
