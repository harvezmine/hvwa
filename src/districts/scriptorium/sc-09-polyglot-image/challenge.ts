// challenge.ts — SC-09 metadata and routes. The vulnerable code is in levels/*.ts (served by View Source).
import { join } from 'node:path';
import { defineChallenge, register } from '../../../core/registry.js';
import { challengeDir } from '../../../core/source.js';
import { sniffImage } from '../../../core/upload.js';
import { UPLOADS_DIR, mountDesk } from '../_shared/desk.js';
import { visible } from '../_shared/lab.js';
import { impl, labFor, resetLab } from './model.js';

const dir = challengeDir(import.meta.url);

export const SC09 = register(defineChallenge({
  id: 'SC-09', district: 'scriptorium', slug: 'polyglot-image', dir,
  title: { id: 'Unggah gambar poliglot', en: 'Upload Polyglot Image' },
  summary: {
    id: 'Meja gambar profil memeriksa bahwa setiap unggahan adalah gambar sungguhan sebelum disimpan, dan server arsip menjalankan skrip yang diberikan kepadanya saat diambil. Unggah berkas yang lolos pemeriksaan gambar tetapi membawa skrip, buat server menjalankannya, lalu baca bendera yang dicetaknya.',
    en: 'The profile-image desk checks that every upload is a real image before it stores it, and the archive server runs the scripts it is given when they are fetched. Upload a file that passes the image check yet carries a script, make the server run it, then read the flag it prints.',
  },
  maps: ['A05:2025', 'CWE-434', 'CWE-345'],
  levels: impl.levels,
  points: 100,
  hints: [
    { id: 1, cost: 10, text: { id: 'Header yang benar membuktikan awal berkas, bukan keseluruhannya. Bagian mana dari unggahanmu yang dibaca oleh pemeriksaan gambar di setiap tingkat?', en: 'A correct header proves the file\'s start, not the whole of it. Which part of your upload does the image check read at each level?' } },
    { id: 2, cost: 20, text: { id: 'Satu berkas bisa menjadi gambar yang sah dan sesuatu yang lain sekaligus. Apa yang dicari penerjemah server, dan di bagian mana berkas ia mencarinya?', en: 'One file can be a valid image and something else at once. What does the server\'s interpreter look for, and where in the file does it look?' } },
    { id: 3, cost: 40, text: { id: 'Mengubah sandi gambar menjadi piksel membuang segala sesuatu yang bukan piksel. Apakah server ini pernah melakukannya, atau menyimpan persis byte yang kamu kirim, dengan nama yang kamu pilih?', en: 'Re-encoding an image to pixels discards everything that isn\'t pixels. Does this server ever do that, or does it keep the very bytes you sent, under the name you chose?' } },
  ],
  reset: (req) => { resetLab(req); },
  mount: (router) => {
    mountDesk(router, {
      challenge: () => SC09,
      levels: impl,
      labFor,
      heading: 'Profile Image Desk',
      blurb: 'Upload a profile image for your pilgrim card; only real images are stored, and stored images are drawn below. The archive server answers fetches of stored files itself, and runs the scripts it is given (files whose name ends in .php).',
      partial: join(dir, 'views', 'verified.ejs'),
      // What an image reader (sniffImage: the header only) sees in each stored file: display, not the level's check.
      extra: (req) => ({
        images: labFor(req).fs.list(UPLOADS_DIR).map((f) => {
          const s = sniffImage(f.bytes);
          return { name: visible(f.path.slice(UPLOADS_DIR.length + 1)), header: s === null ? 'no image header' : `${s.type.toUpperCase()}, ${s.width} x ${s.height}` };
        }),
      }),
      preview: true,
    });
  },
}));
