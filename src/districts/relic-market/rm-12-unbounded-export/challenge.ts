// challenge.ts — RM-12 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, field } from '../../../core/lab.js';
import { flagFor } from '../../../core/mount.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import { baseView, endpointsOf, mountIntents, type Intent, type Outcome } from '../_shared/shop-lab.js';
import {
  COST_SHOWN_UP_TO, EXPAND_LIMITS, PREVIEW, TOTAL_ROWS, cursorOf, offsetOf, previewRows, proves, walkExpand,
  type ExportLevel,
} from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const view = join(dir, 'views', 'export.ejs');
const impl = byLevel<ExportLevel>({ acolyte, templar, inquisitor, divine });

/** The request's parameters: each absent (undefined) or given once as text. */
interface Params { readonly limit?: string; readonly cursor?: string; readonly expand?: string }

/** One export's answer: a status and a JSON body (an error is `{ error }`). */
interface Answer { readonly status: number; readonly body: Record<string, unknown> }

const refuse = (status: number, error: string): Answer => ({ status, body: { error } });

/**
 * One export, for both doors (the API and the Try it form): the level plans it, the graph prices it, and the lab
 * answers with the cost it COMPUTED and a preview of at most PREVIEW.rows rows. Nothing here loops to the planned rows.
 */
function exportFor(req: Request, p: Params): Answer {
  if ((p.expand ?? '').length > EXPAND_LIMITS.length) return refuse(400, `expand is too long (at most ${EXPAND_LIMITS.length} characters).`);
  const offset = p.cursor === undefined ? 0 : offsetOf(p.cursor);
  if (offset === undefined) return refuse(400, 'Invalid cursor.');
  const level = impl.for(req.level);
  const plan = level.plan({ limit: p.limit, offset, expand: p.expand });
  if ('status' in plan) return refuse(plan.status, plan.error);
  const walked = walkExpand(plan.expand);
  if ('error' in walked) return refuse(400, walked.error);
  // Platform safety, not the lesson: whatever a level plans, the ledger has TOTAL_ROWS - offset rows and no fewer than 0.
  const rows = Math.max(0, Math.min(Math.floor(plan.rows), TOTAL_ROWS - offset));
  const cost = rows * walked.multiplier; // arithmetic in Numbers: nothing is built per planned row
  const over = level.overBudget(cost);
  if (over !== undefined) return refuse(413, over);
  const data = previewRows(offset, rows, plan.expand);
  const costText = cost >= COST_SHOWN_UP_TO ? '>= 10^15' : String(cost);
  const flag = req.level !== 'divine' && proves(cost) ? flagFor(req, RM12) : undefined;
  return {
    status: 200,
    body: {
      rows, cost: cost >= COST_SHOWN_UP_TO ? costText : cost, returned: data.length,
      next: rows > 0 && offset + rows < TOTAL_ROWS ? cursorOf(offset + rows) : null, data,
      note: cost > data.length
        ? `Truncated by the lab: the real server would have built ${costText} rows.`
        : 'Nothing was truncated: the preview is the whole answer.',
      ...(flag === undefined ? {} : { flag }),
    },
  };
}

/** The parameters of the query: absent or one string each; a repeated or nested value is not an answer (400). */
function queryParams(req: Request): Params | string {
  const out: { limit?: string; cursor?: string; expand?: string } = {};
  for (const name of ['limit', 'cursor', 'expand'] as const) {
    const v: unknown = req.query[name];
    if (v === undefined) continue;
    if (typeof v !== 'string') return `Give ${name} once.`;
    out[name] = v;
  }
  return out;
}

/** What the Try it form made of its fields (a blank field is an absent one), for the render that follows. */
const tried = new WeakMap<Response, Answer>();

function tryIt(req: Request, res: Response): Outcome {
  const params: { limit?: string; expand?: string } = {};
  const limit = field(req, 'limit');
  const expand = field(req, 'expand');
  if (limit !== '') params.limit = limit;
  if (expand !== '') params.expand = expand;
  const answer = exportFor(req, params);
  tried.set(res, answer);
  return { result: { ok: answer.status === 200, text: answer.status === 200 ? 'Export planned.' : String(answer.body.error) }, status: answer.status };
}

const INTENTS: Readonly<Record<string, Intent>> = {
  export: { path: '/export', fields: ['limit', 'expand'], run: tryIt },
};

async function render(req: Request, res: Response, outcome: Outcome): Promise<void> {
  const answer = tried.get(res);
  await sendPage(res, view, {
    ...baseView(req, res, {
      result: outcome.result, intent: outcome.intent, endpoints: endpointsOf(INTENTS),
      curl: { path: '/api/export', signIn: false },
      api: [{
        path: '/api/export?limit=&cursor=&expand=', example: '/api/export?limit=10&expand=product',
        description: 'the sales ledger as JSON: a planned export and a preview of it',
      }],
    }),
    heading: 'Relic Market: sales ledger export',
    totalRows: TOTAL_ROWS, previewRows: PREVIEW.rows,
    limitValue: outcome.intent === 'export' ? field(req, 'limit') : '', expandValue: outcome.intent === 'export' ? field(req, 'expand') : '',
    answer: answer === undefined ? null : JSON.stringify(answer.body, null, 2),
  });
}

export const RM12 = register(defineChallenge({
  id: 'RM-12', district: 'relic-market', slug: 'unbounded-export', dir,
  title: { id: 'Ekspor Massal Tanpa Batas (API4)', en: 'Unbounded Bulk Export (API4)' },
  summary: {
    id: 'Buat API ekspor membangun jauh lebih banyak data daripada yang pantas dilayani satu permintaan.',
    en: 'Make the export API build far more data than one request should ever be served.',
  },
  maps: ['API4:2023', 'CWE-770'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Parameter mana yang menentukan berapa baris yang dibangun server, dan berapa nilai terbesar yang diterimanya?', en: 'Which parameter decides how many rows the server builds, and what is the largest value it accepts?' } },
    { id: 2, cost: 20, text: { id: 'Sekarang ada batas atas. Apa arti nol atau angka negatif bagi kode lama itu?', en: 'There is an upper cap now. What do zero or a negative number mean to that legacy code?' } },
    { id: 3, cost: 40, text: { id: 'Di Inquisitor ukuran halaman sudah dibatasi. Apa yang melipatgandakan pekerjaan per baris, dan apakah kedalamannya dibatasi?', en: 'At Inquisitor the page size is capped. What multiplies the work per row, and is its depth limited?' } },
  ],
  // No Restart: the lab keeps no state (the ledger is derived from the row number).
  mount: (router) => {
    router.get('/', async (req, res) => { await render(req, res, { result: null }); });
    router.get('/api/export', (req, res) => {
      const params = queryParams(req);
      const answer = typeof params === 'string' ? refuse(400, params) : exportFor(req, params);
      res.status(answer.status).json(answer.body);
    });
    mountIntents(router, INTENTS, render);
  },
}));
