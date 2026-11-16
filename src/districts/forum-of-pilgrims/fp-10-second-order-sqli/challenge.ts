// challenge.ts — FP-10 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, field, labPath, tryDb } from '../../../core/lab.js';
import { flagFor } from '../../../core/mount.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import { curlFor, type Result } from '../_shared/forum.js';
import { cell } from '../../_shared/sql.js';
import { MAX_COLUMNS, MAX_NAME, MAX_ROWS, labFor, storedName, trimTables, type Row, type SqliLevel } from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const homeView = join(dir, 'views', 'home.ejs');
const rowsView = join(dir, 'views', 'rows.ejs');
const impl = byLevel<SqliLevel>({ acolyte, inquisitor, divine });

export const FP10 = register(defineChallenge({
  id: 'FP-10', district: 'forum-of-pilgrims', slug: 'second-order-sqli', dir,
  title: { id: 'SQLi Orde Kedua lewat Username', en: 'Second-Order SQLi via Username' },
  summary: {
    id: 'Daftarkan username yang aman saat disimpan, tetapi menjadi SQL saat dipakai kembali, lalu baca brankas forum.',
    en: 'Register a username that is harmless when stored but becomes SQL when it is used again, and read the forum\'s vault.',
  },
  maps: ['A05:2025', 'CWE-89', 'CWE-564'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Pendaftaran mungkin aman, tetapi di mana lagi nama Anda dipakai?', en: 'Registration may be safe, but where else is your name used?' } },
    { id: 2, cost: 20, text: { id: 'Tidak setiap bagian query bisa diparametrisasi — nama kolom, misalnya.', en: 'Not every part of a query can be parameterized — a column name, for instance.' } },
    { id: 3, cost: 40, text: { id: 'Data yang tersimpan hari ini bisa menjadi kode besok.', en: 'Data stored today can become code tomorrow.' } },
  ],
  mount: (router) => {
    const home = (req: Request, res: Response, result: Result | null, username: string) => sendPage(res, homeView, {
      base: labPath(res), result, username, current: storedName(labFor(req)) ?? null,
      curl: curlFor(req, res, { path: '', form: { username: 'river_pilgrim' }, signIn: false }),
    });

    router.get('/', (req, res) => home(req, res, null, ''));

    // Registration: the INSERT is parameterized at every level. The flaw is not here but in what later reads the name.
    router.post('/', (req, res) => {
      const username = field(req, 'username');
      const level = impl.for(req.level);
      const state = labFor(req);
      const refuse = (text: string) => home(req, res, { ok: false, text }, username);
      if (username === '') return refuse('Choose a username.');
      if (username.length > MAX_NAME) return refuse(`Usernames are at most ${MAX_NAME} characters.`);
      const bad = level.checkName(username);
      if (bad !== undefined) return refuse(bad);
      const made = tryDb(req, () => {
        const id = level.register(state.db, username, Date.now());
        trimTables(state.db);
        return id;
      });
      if (!made.ok) return refuse(made.message);
      if (made.value === undefined) return refuse('That name is taken.');
      state.current = made.value;
      return home(req, res, { ok: true, text: `Registered as ${username}. You are signed in; open your activity or your report.` }, username);
    });

    /** A second use of the stored name: read it back, run the level's query, show at most MAX_ROWS rows. */
    async function secondUse(req: Request, res: Response, heading: string, run: (l: SqliLevel, name: string) => Row[]): Promise<void> {
      const state = labFor(req);
      const name = storedName(state);
      const page = (data: Record<string, unknown>) => sendPage(res, rowsView, {
        base: labPath(res), heading, name: name ?? '', columns: [], rows: [], more: false, result: null, ...data,
      });
      if (name === undefined) return page({ result: { ok: false, text: 'You have not registered yet.' } });
      const found = tryDb(req, () => run(impl.for(req.level), name));
      if (!found.ok) return page({ result: { ok: false, text: found.message } });
      const all = found.value;
      const shown = all.slice(0, MAX_ROWS);
      const columns = shown.length === 0 ? [] : Object.keys(shown[0]).slice(0, MAX_COLUMNS);
      // The proof: the vault's canary came back through a query. Divine never issues a flag (flagFor stays OUTSIDE tryDb).
      const leaked = req.level !== 'divine' && shown.some((r) => Object.values(r).some((v) => String(v ?? '').includes(state.canary)));
      const result: Result | null = leaked ? { ok: true, text: `The vault answered through your name. Flag: ${flagFor(req, FP10)}` } : null;
      return page({
        columns, result, more: all.length > MAX_ROWS,
        rows: shown.map((r) => columns.map((c) => cell(r[c]))),
      });
    }

    router.get('/activity', (req, res) => secondUse(req, res, 'Activity of', (l, name) => l.activity(labFor(req).db, name)));
    router.get('/report', (req, res) => secondUse(req, res, 'Report for', (l, name) => l.report(labFor(req).db, name)));
  },
}));
