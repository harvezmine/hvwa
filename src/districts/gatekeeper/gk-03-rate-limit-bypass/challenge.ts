// challenge.ts — GK-03 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import type { Request } from 'express';
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel, field } from '../../../core/lab.js';
import { flagFor } from '../../../core/mount.js';
import { sendPage } from '../../../core/render.js';
import { challengeDir } from '../../../core/source.js';
import { ADMIN_NAME, PLAYER, labFor, leakedList, type Account, type Attempt, type LimitLevel } from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const view = join(dir, 'views', 'login.ejs');
const impl = byLevel<LimitLevel>({ acolyte, templar, inquisitor, divine });

/** The lab's message: ok selects the success/error style. */
interface Result { ok: boolean; text: string }

function welcome(req: Request, account: Account): Result {
  const hello = `Welcome, ${account.username} (role: ${account.role}).`;
  if (account.role !== 'admin') return { ok: true, text: `${hello} Only the citadel admin holds the flag.` };
  if (req.level === 'divine') return { ok: true, text: hello }; // Divine never issues a flag
  return { ok: true, text: `${hello} Flag: ${flagFor(req, GK03)}` };
}

const header = (req: Request, name: string): string | undefined => {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
};

export const GK03 = register(defineChallenge({
  id: 'GK-03', district: 'gatekeeper', slug: 'rate-limit-bypass', dir,
  title: { id: 'Membobol Pembatas Laju', en: 'Rate-Limit Bypass' },
  summary: {
    id: 'Login dibatasi 5 percobaan per menit. Tebak kata sandi citadel_admin dari daftar bocor dengan menembus pembatasnya.',
    en: 'Login is limited to 5 attempts a minute. Guess the citadel_admin password from the leaked list by getting past the limiter.',
  },
  maps: ['A07:2025', 'CWE-307', 'CWE-348'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Pembatas harus tahu siapa kamu. Dari mana ia mendapat identitas klien?', en: 'A limiter has to know who you are. Where does it get the client identity from?' } },
    { id: 2, cost: 20, text: { id: 'Header yang ditulis klien bisa diisi apa saja. Kalau satu header tidak dipercaya, mungkin header lain masih.', en: 'A header the client writes can say anything. If one header is not trusted, another one may still be.' } },
    { id: 3, cost: 40, text: { id: 'Kalau identitas klien sudah benar, hitung apa yang dihitung: percobaan, atau permintaan? Lihat apa saja yang diterima endpoint.', en: 'If the client identity is sound, look at what is counted: attempts, or requests? Check what shapes of body the endpoint accepts.' } },
  ],
  mount: (router) => {
    const page = (req: Request, res: Parameters<typeof sendPage>[0], result: Result | null, username: string, password: string) =>
      sendPage(res, view, { base: req.baseUrl, account: PLAYER, target: ADMIN_NAME, result, username, password });
    router.get('/', (req, res) => page(req, res, null, '', ''));
    router.get('/leaked.txt', (_req, res) => { res.type('text/plain').send(`${leakedList().join('\n')}\n`); });
    router.post('/', async (req, res) => {
      const attempt: Attempt = {
        body: req.body as unknown,
        forwardedFor: header(req, 'x-forwarded-for'),
        realIp: header(req, 'x-real-ip'),
        socketAddress: req.socket.remoteAddress ?? 'unknown',
      };
      const outcome = impl.for(req.level).login(labFor(req), attempt);
      const result: Result = outcome.ok ? welcome(req, outcome.account) : { ok: false, text: outcome.message };
      await page(req, res, result, field(req, 'username'), field(req, 'password'));
    });
  },
}));
