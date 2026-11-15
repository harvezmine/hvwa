// challenge.ts — GK-05 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { defineChallenge, register } from '../../../core/registry.js';
import { byLevel } from '../../../core/lab.js';
import { challengeDir } from '../../../core/source.js';
import { mountJwtPortal } from '../_shared/jwt-lab.js';
import { issueToken, labFor, type JwtLevel } from './model.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

const dir = challengeDir(import.meta.url);
const impl = byLevel<JwtLevel>({ acolyte, templar, inquisitor, divine });

export const GK05 = register(defineChallenge({
  id: 'GK-05', district: 'gatekeeper', slug: 'jwt-key-confusion', dir,
  title: { id: 'JWT: Kebingungan Kunci', en: 'JWT: Key Confusion' },
  summary: {
    id: 'Token JWT diverifikasi dengan kunci publik citadel. Buat server memakai kunci yang salah, lalu buka brankas sebagai admin.',
    en: 'JWTs are verified with the citadel public key. Make the server use the wrong key, then open the vault as admin.',
  },
  maps: ['A07:2025', 'CWE-347', 'CWE-327'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Kunci publik itu memang untuk dibagikan. Tanyakan: algoritma apa yang bisa memakai teks kunci itu, dan siapa yang memilih algoritmanya?', en: 'A public key is meant to be shared. Ask which kind of algorithm could use that very text, and who chooses the algorithm.' } },
    { id: 2, cost: 20, text: { id: 'Kalau satu nama algoritma diblokir, tanyakan apakah daftar hitam itu menutup seluruh keluarganya atau hanya satu anggotanya.', en: 'If one algorithm name is blocked, ask whether the blacklist covers the whole family or just one member.' } },
    { id: 3, cost: 40, text: { id: 'Kalau hanya keluarga RS yang diterima, dari mana server mengambil kunci untuk memeriksa? Adakah bagian token yang menawarkan kuncinya sendiri?', en: 'If only the RS family is accepted, where does the server get the key to check with? Does any part of the token offer its own?' } },
  ],
  mount: (router) => {
    mountJwtPortal(router, {
      challenge: () => GK05,
      blurb: 'Tokens are RS256, verified with the citadel public key, which is published as:',
      links: [{ path: '/public.pem', text: 'public.pem' }],
      issue: (req) => issueToken(labFor(req), { sub: 'pilgrim', role: 'user' }),
      verify: (req, token) => impl.for(req.level).verify(labFor(req), token),
    });

    // The public key, published as exactly the text the verifier holds (an attacker needs the exact bytes).
    router.get('/public.pem', (req, res) => { res.type('text/plain').send(labFor(req).publicPem); });
  },
}));
