// challenge.ts — SC-08 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { defineChallenge, register } from '../../../core/registry.js';
import { challengeDir } from '../../../core/source.js';
import { mountDesk } from '../_shared/desk.js';
import { impl, labFor, resetLab } from './model.js';

const dir = challengeDir(import.meta.url);

export const SC08 = register(defineChallenge({
  id: 'SC-08', district: 'scriptorium', slug: 'upload-double-ext', dir,
  title: { id: 'Unggah ekstensi ganda', en: 'Upload Double Extension' },
  summary: {
    id: 'Meja potret peziarah menyaring nama berkas, tetapi server arsip memahami nama itu dengan cara lain. Selipkan ekstensi kedua atau nama yang disandikan, buat server menjalankan berkasmu, lalu baca bendera yang dicetaknya.',
    en: 'The pilgrim portrait desk filters file names, but the archive server reads those names another way. Slip in a second extension or an encoded name, make the server run your file, then read the flag it prints.',
  },
  maps: ['A05:2025', 'CWE-434', 'CWE-158'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Sebuah berkas bisa punya lebih dari satu ekstensi. Bagian nama yang mana yang diperiksa, dan bagian mana yang dipakai server?', en: 'A file can have more than one extension. Which part of the name is checked, and which part does the server use?' } },
    { id: 2, cost: 20, text: { id: 'Titik pertama dan titik terakhir bisa berarti hal berbeda bagi kode yang berbeda. Kode mana di sini yang memotong di tempat berbeda?', en: 'The first dot and the last dot can mean different things to different code. Which code here splits in a different place?' } },
    { id: 3, cost: 40, text: { id: 'Apa yang terjadi jika nama di-dekode satu kali sebelum diperiksa, atau setelahnya? Dan karakter apa yang dianggap kode bergaya C sebagai akhir sebuah nama?', en: 'What if the name is decoded once before it is checked, or after? And which character does C-style code treat as the end of a name?' } },
  ],
  reset: (req) => { resetLab(req); },
  mount: (router) => {
    mountDesk(router, {
      challenge: () => SC08,
      levels: impl,
      labFor,
      heading: 'Avatar Desk',
      blurb: 'Upload a portrait for your pilgrim card. Names are filtered on the way in; the archive server decides from the stored name how to serve it, and runs the files it maps to an interpreter.',
    });
  },
}));
