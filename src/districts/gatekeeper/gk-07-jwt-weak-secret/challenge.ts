// challenge.ts — GK-07 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { defineChallenge, register } from '../../../core/registry.js';
import { sendLines } from '../../../core/lab.js';
import { challengeDir } from '../../../core/source.js';
import { mountJwtPortal } from '../_shared/jwt-lab.js';
import { impl, issueToken, labFor, wordlist } from './model.js';

const dir = challengeDir(import.meta.url);

export const GK07 = register(defineChallenge({
  id: 'GK-07', district: 'gatekeeper', slug: 'jwt-weak-secret', dir,
  title: { id: 'JWT: Rahasia Lemah', en: 'JWT: Weak Secret' },
  summary: {
    id: 'Token contoh ditandatangani dengan rahasia HMAC. Pecahkan rahasianya secara offline, lalu tandatangani token adminmu sendiri.',
    en: 'A sample token is signed with an HMAC secret. Crack the secret offline, then sign your own admin token.',
  },
  maps: ['A04:2025', 'A07:2025', 'CWE-521', 'CWE-326'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Tanda tangan HMAC bisa kamu periksa sendiri tanpa server. Apa yang kamu perlukan untuk mencoba satu tebakan, dan berapa banyak tebakan yang bisa dilakukan per detik?', en: 'You can check an HMAC signature yourself without the server. What do you need to try one guess, and how many guesses per second can you make?' } },
    { id: 2, cost: 20, text: { id: 'Kalau daftar kata polos tidak berhasil, tanyakan bagaimana orang biasanya membuat kata sandi "lebih kuat". Aturan sederhana apa yang bisa kamu tambahkan pada tiap kata?', en: 'If the plain wordlist fails, ask how people usually make a password "stronger". What simple rule could you add to every word?' } },
    { id: 3, cost: 40, text: { id: 'Kalau kunci sekarang kuat, apakah semua kunci lama sudah dimatikan? Adakah token lama yang beredar, dan kunci mana yang menandatanganinya?', en: 'If the current key is strong, were all the old keys switched off? Is an old token lying around somewhere, and which key signed it?' } },
  ],
  mount: (router) => {
    mountJwtPortal(router, {
      challenge: () => GK07,
      blurb: 'Tokens are HS256. Published by the archive:',
      links: [{ path: '/wordlist.txt', text: 'password wordlist' }, { path: '/release-notes.txt', text: 'release notes' }],
      sample: (req) => labFor(req).sample,
      issue: (req) => issueToken(req.level, labFor(req), { sub: 'pilgrim', role: 'user' }),
      verify: (req, token) => impl.for(req.level).verify(labFor(req), token),
    });

    // The wordlist the weak secrets are drawn from (a published fixture, like a leaked password list).
    router.get('/wordlist.txt', (_req, res) => { sendLines(res, wordlist()); });

    // Release notes: the Inquisitor lab's notes quote an old token "for regression tests" (the leak).
    router.get('/release-notes.txt', (req, res) => {
      const state = labFor(req);
      const lines = ['Citadel Archive API release notes', ''];
      if (impl.for(req.level).kid !== undefined) lines.push('2025.1  Token signing keys now carry a key id (kid) so they can be rotated.');
      lines.push('2025.1  The sign-in page now shows a sample token for each new visitor.', '2024.4  Fixed a typo in the vault welcome message.');
      if (state.legacyToken !== undefined) {
        lines.push('2024.4  Regression sample from the 2024 key era, kept for the migration tests:', `        ${state.legacyToken}`);
      }
      sendLines(res, lines);
    });
  },
}));
