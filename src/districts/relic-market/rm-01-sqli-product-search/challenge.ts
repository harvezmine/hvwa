// challenge.ts — RM-01 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, field, tryDb } from '../../../core/lab.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import { curlFor } from '../../_shared/curl.js';
import type { Result } from '../../_shared/result.js';
import { flagLine } from '../_shared/shop-lab.js';
import { NO_MAX, catalogDb, cellsOf, proves, type SearchLevel } from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const view = join(dir, 'views', 'search.ejs');
const impl = byLevel<SearchLevel>({ acolyte, templar, inquisitor, divine });

async function page(req: Request, res: Response, q: string, max: string, searched: boolean): Promise<void> {
  let result: Result | null = null;
  let rows: string[][] = [];
  if (searched) {
    // An empty max field means "no limit": the shared plumbing, so every level starts from the same value.
    const found = tryDb(req, () => impl.for(req.level).search(catalogDb(req.level), q, max === '' ? NO_MAX : max));
    if (!found.ok) result = { ok: false, text: found.message };
    else if (typeof found.value === 'string') result = { ok: false, text: found.value };
    else {
      rows = found.value.map(cellsOf);
      if (rows.length === 0) result = { ok: false, text: 'No relics match your search.' };
      else {
        const n = rows.length;
        // flagFor stays outside tryDb; the proof is a rendered result cell, never the echoed search term.
        const flag = proves(rows, req.level) ? flagLine(req, RM01) : '';
        result = { ok: true, text: `${n} relic${n === 1 ? '' : 's'} found.${flag === '' ? '' : ` ${flag}`}` };
      }
    }
  }
  await sendPage(res, view, { q, max, result, rows, curl: curlFor(req, res, { path: '/', form: { q: 'chalice', max: '1000' }, signIn: false }) });
}

export const RM01 = register(defineChallenge({
  id: 'RM-01', district: 'relic-market', slug: 'sqli-product-search', dir,
  title: { id: 'SQLi Pencarian Produk (UNION)', en: 'Product Search SQLi (UNION)' },
  summary: {
    id: 'Munculkan kunci brankas toko dari tabel secrets di hasil pencarian katalog.',
    en: "Make the shop's vault key from the secrets table show up in the catalog search results.",
  },
  maps: ['A05:2025', 'CWE-89'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Kata pencarianmu masuk ke query SQL. Berapa kolom yang dikembalikan query itu, dan bisakah kamu menambahkan baris dari tabel lain?', en: 'Your search term ends up in an SQL query. How many columns does it return, and could you add rows from another table?' } },
    { id: 2, cost: 20, text: { id: 'Kalau kata kunci tertentu dihapus dari inputmu, apa yang tersisa sesudah penghapusan? Apakah filter itu berjalan lebih dari sekali?', en: 'If certain keywords are removed from your input, what is left after the removal? Does the filter run more than once?' } },
    { id: 3, cost: 40, text: { id: 'Di Inquisitor kotak pencarian sudah aman. Field lain mana yang masih masuk ke query, dan apa yang sebenarnya dibuktikan oleh pemeriksaan "apakah ini angka"?', en: 'At Inquisitor the search box is safe. Which other field still reaches the query, and what does its "is this a number?" check really prove?' } },
  ],
  // No Restart: nothing here mutates (an injected SELECT cannot write), so there is no state to get stuck in.
  mount: (router) => {
    router.get('/', async (req, res) => { await page(req, res, '', '', false); });
    router.post('/', async (req, res) => { await page(req, res, field(req, 'q'), field(req, 'max'), true); });
  },
}));
