// challenge.ts — SC-07 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { defineChallenge, register } from '../../../core/registry.js';
import { challengeDir } from '../../../core/source.js';
import { mountDesk } from '../_shared/desk.js';
import { impl, labFor, resetLab } from './model.js';

const dir = challengeDir(import.meta.url);

export const SC07 = register(defineChallenge({
  id: 'SC-07', district: 'scriptorium', slug: 'upload-webshell', dir,
  title: { id: 'Unggah webshell (bypass ekstensi)', en: 'Upload Webshell (Extension Bypass)' },
  summary: {
    id: 'Meja Skriptorium menerima gulungan dari peziarah, dan server arsip "menjalankan" berkas yang namanya dipetakan ke sebuah penerjemah. Lolos dari penyaring unggahan, buat server menjalankan gulunganmu, lalu baca bendera yang dicetaknya.',
    en: 'The Scriptorium desk takes scrolls from pilgrims, and the archive server "runs" files whose names map to an interpreter. Get past the upload filter, make the server run your scroll, then read the flag it prints.',
  },
  maps: ['A05:2025', 'CWE-434', 'CWE-646'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Server memutuskan cara menyajikan berkas dari namanya. Nama yang mana, dan siapa yang menulisnya?', en: 'The server decides how to serve a file from its name. Which name, and who wrote it?' } },
    { id: 2, cost: 20, text: { id: 'Daftar blokir hanya menutup ejaan yang terpikir. Apa saja yang masih dipahami server sebagai skrip tetapi tidak ada di daftar itu?', en: 'A denylist only closes the spellings someone thought of. What else does the server still understand as a script that the list never names?' } },
    { id: 3, cost: 40, text: { id: 'Tipe yang kamu klaim dan ekstensi yang kamu tulis tidak harus cocok. Bagian mana dari unggahan yang diperiksa, dan bagian mana yang dipakai server saat menyajikan?', en: 'The type you claim and the extension you write need not agree. Which part of the upload is checked, and which part does the server act on when it serves?' } },
  ],
  reset: (req) => { resetLab(req); },
  mount: (router) => {
    mountDesk(router, {
      challenge: () => SC07,
      levels: impl,
      labFor,
      heading: 'Scroll Desk',
      blurb: 'Submit a scroll for the archive. The archive server answers fetches of stored scrolls itself, and runs the ones whose names it maps to an interpreter.',
    });
  },
}));
