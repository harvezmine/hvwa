// challenge.ts — GK-04 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
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

export const GK04 = register(defineChallenge({
  id: 'GK-04', district: 'gatekeeper', slug: 'jwt-alg-none', dir,
  title: { id: 'JWT: alg none', en: 'JWT: alg none' },
  summary: {
    id: 'Brankas Citadel hanya terbuka untuk admin. Palsukan token JWT-mu agar server tidak memeriksa tanda tangannya.',
    en: 'The citadel vault opens only for the admin. Forge a JWT so the server never checks its signature.',
  },
  maps: ['A07:2025', 'CWE-347'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Bongkar tokenmu: bagian pertama menyebut sesuatu tentang cara tanda tangan diperiksa. Siapa yang memutuskan cara itu, server atau pengirim?', en: 'Take your token apart: the first part says something about how the signature is checked. Who decides that, the server or the sender?' } },
    { id: 2, cost: 20, text: { id: 'Kalau satu nilai di header ditolak, tanyakan: bagaimana server membandingkannya, dan bagaimana ia memperlakukan huruf besar-kecil?', en: 'If one header value is refused, ask how the server compares it, and how it treats upper and lower case.' } },
    { id: 3, cost: 40, text: { id: 'Kalau semua ejaan ditolak, apa yang terjadi bila bagian ketiga token tidak berisi apa-apa? Apakah "kosong" sama dengan "salah"?', en: 'If every spelling is refused, what happens when the third part of the token holds nothing at all? Is "empty" treated like "wrong"?' } },
  ],
  mount: (router) => {
    mountJwtPortal(router, {
      challenge: () => GK04,
      blurb: 'Tokens are HS256: signed with a secret only the archive knows.',
      issue: (req) => issueToken(labFor(req), { sub: 'pilgrim', role: 'user' }),
      verify: (req, token) => impl.for(req.level).verify(labFor(req), token),
    });
  },
}));
