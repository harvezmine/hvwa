// challenge.ts — GK-06 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { defineChallenge, register } from '../../../core/registry.js';
import { tryDb } from '../../../core/lab.js';
import { challengeDir } from '../../../core/source.js';
import { mountJwtPortal } from '../_shared/jwt-lab.js';
import { ROBOTS_TXT, impl, issueToken, labFor } from './model.js';

const dir = challengeDir(import.meta.url);

export const GK06 = register(defineChallenge({
  id: 'GK-06', district: 'gatekeeper', slug: 'jwt-kid-injection', dir,
  title: { id: 'JWT: Injeksi kid', en: 'JWT: kid Injection' },
  summary: {
    id: 'Server mencari kunci tanda tangan lewat kolom kid di header token. Arahkan pencarian itu ke kunci yang kamu kenal, lalu buka brankas sebagai admin.',
    en: 'The server finds the signing key through the kid field in the token header. Steer that lookup to a key you know, then open the vault as admin.',
  },
  maps: ['A07:2025', 'CWE-22', 'CWE-89'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Bandingkan kid di tokenmu dengan tempat kunci disimpan. Apa yang terjadi bila kamu menulis nilai lain, dan siapa yang membatasi ke mana nilai itu menunjuk?', en: 'Compare the kid in your token with where the keys are kept. What happens when you write another value, and who limits where that value can point?' } },
    { id: 2, cost: 20, text: { id: 'Kalau nilai itu dipakai sebagai nama berkas, tanyakan apa yang berhenti di batas folder kunci, dan apakah penyaring yang menghapus sesuatu cukup kalau hanya dijalankan sekali. Berkas apa yang isinya kamu ketahui?', en: 'If the value is used as a file name, ask what stops it at the key folder, and whether a filter that removes something is enough when it runs only once. Which files have contents you already know?' } },
    { id: 3, cost: 40, text: { id: 'Kalau tidak ada lagi berkas, di mana kunci disimpan? Apa yang terjadi pada pencarian bila nilai kid berisi tanda kutip, dan bisakah pencarian itu mengembalikan baris yang kamu tulis sendiri?', en: 'If there are no files any more, where are the keys kept? What happens to the lookup when the kid contains a quote, and can that lookup return a row you wrote yourself?' } },
  ],
  mount: (router) => {
    mountJwtPortal(router, {
      challenge: () => GK06,
      blurb: 'Every token names its signing key in the header field kid, and the server looks that key up. Signing keys live under /keys/; the public web root (served from /srv/www on the archive host) is published too:',
      links: [{ path: '/robots.txt', text: 'robots.txt' }],
      issue: (req) => issueToken(req, { sub: 'pilgrim', role: 'user' }),
      // tryDb is the guard: a database error is shown below Divine only
      verify: (req, token) => impl.for(req.level).verify(labFor(req), token, (fn) => tryDb(req, fn)),
    });

    // The archive's public web root: a file whose contents everyone knows (it is also /srv/www/robots.txt).
    router.get('/robots.txt', (_req, res) => { res.type('text/plain').send(ROBOTS_TXT); });
  },
}));
