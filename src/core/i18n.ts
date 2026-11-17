// src/core/i18n.ts
import type { RequestHandler } from 'express';
import { preference } from './cookies.js';

export const LANGS = Object.freeze(['id', 'en'] as const);
export type Lang = (typeof LANGS)[number];
export const DEFAULT_LANG: Lang = 'id';

type Entry = { id: string; en: string };

// PLATFORM strings only (nav, portal, scoreboard, diff headers, warnings).
// Challenge text stays in each challenge's metadata ({ id, en } fields).
const DICT: Readonly<Record<string, Entry>> = Object.freeze({
  'app.title': { id: 'HVWA — Kota Suci yang Rentan', en: 'HVWA — Holy Vulnerable Web App' },
  'app.tagline': { id: 'Aplikasi web yang sengaja rentan.', en: 'A deliberately vulnerable web app.' },
  'nav.home': { id: 'Beranda', en: 'Home' },
  'nav.districts': { id: 'Distrik', en: 'Districts' },
  'nav.scoreboard': { id: 'Papan Skor', en: 'Scoreboard' },
  'portal.heading': { id: 'Peta Distrik', en: 'District Map' },
  'portal.challenges': { id: 'Tantangan', en: 'Challenges' },
  'portal.no_challenges': { id: 'Belum ada tantangan terdaftar.', en: 'No challenges registered yet.' },
  'scoreboard.title': { id: 'Papan Skor', en: 'Scoreboard' },
  'scoreboard.score': { id: 'Skor', en: 'Score' },
  'scoreboard.solved': { id: 'Terpecahkan', en: 'Solved' },
  'level.acolyte': { id: 'Acolyte', en: 'Acolyte' },
  'level.templar': { id: 'Templar', en: 'Templar' },
  'level.inquisitor': { id: 'Inquisitor', en: 'Inquisitor' },
  'level.divine': { id: 'Divine', en: 'Divine' },
  'challenge.levels': { id: 'Level', en: 'Levels' },
  'challenge.solved': { id: 'Terpecahkan', en: 'Solved' },
  'challenge.unsolved': { id: 'Belum', en: 'Unsolved' },
  'challenge.open_lab': { id: 'Buka lab', en: 'Open lab' },
  'challenge.hints': { id: 'Petunjuk', en: 'Hints' },
  'challenge.hint_tier': { id: 'Petunjuk', en: 'Hint' },
  'challenge.hint_unlock': { id: 'Buka petunjuk', en: 'Unlock hint' },
  'challenge.hint_cost': { id: 'Biaya', en: 'Cost' },
  'challenge.points': { id: 'poin', en: 'points' },
  'challenge.submit_heading': { id: 'Kirim Flag', en: 'Submit Flag' },
  'challenge.submit_label': { id: 'Flag', en: 'Flag' },
  'challenge.submit_button': { id: 'Kirim', en: 'Submit' },
  'challenge.result_new_best': { id: 'Benar! Level terbaik baru:', en: 'Correct! New best level:' },
  'challenge.result_already': { id: 'Sudah terpecahkan di level', en: 'Already solved at level' },
  'challenge.result_lower': { id: 'Benar, tetapi level terbaik Anda tetap', en: 'Correct, but your best remains' },
  'challenge.hint_confirm': { id: 'Buka petunjuk ini? Skor Anda akan berkurang.', en: 'Unlock this hint? It will reduce your score.' },
  'challenge.result_bad': { id: 'Salah. Coba lagi.', en: 'Incorrect. Try again.' },
  'challenge.source': { id: 'Lihat Source', en: 'View Source' },
  'challenge.diff': { id: 'Bandingkan Rentan vs Aman', en: 'Compare Vulnerable vs Secure' },
  'challenge.divine_tab': { id: 'Divine (referensi aman)', en: 'Divine (secure reference)' },
  'challenge.err_invalid_tier': { id: 'Tingkat petunjuk tidak valid.', en: 'Invalid hint tier.' },
  'challenge.err_unknown_tier': { id: 'Petunjuk tidak tersedia.', en: 'Hint not available.' },
  'challenge.diff_title': { id: 'perbandingan', en: 'diff' },
  'challenge.back': { id: 'Kembali ke tantangan', en: 'Back to challenge' },
  'lab.bar_label': { id: 'Panduan lab', en: 'Lab guide' },
  'lab.current_level': { id: 'Level saat ini', en: 'Current level' },
  'lab.switch_level': { id: 'Ganti level', en: 'Switch level' },
  'lab.restart': { id: 'Mulai ulang lab', en: 'Restart lab' },
  'lab.restart_cooldown': { id: 'Mulai ulang sedang jeda. Coba lagi sebentar lagi.', en: 'Restart is cooling down. Try again in a moment.' },
  // The simulated-victim panel (core/victim.ts, core/views/sim-panel.ejs). {name} placeholders are filled by victim.ts.
  'sim.heading': { id: 'Korban tersimulasi', en: 'Simulated victim' },
  'sim.hosts': {
    id: 'Peramban korban hanya mengenal dua situs: {citadel} (lab ini: {citadel}/<path> adalah {lab}/<path>) dan {attacker} (server Anda, termasuk subdomainnya). Tidak ada jaringan sungguhan.',
    en: 'The victim\'s browser knows only two sites: {citadel} (this lab: {citadel}/<path> is {lab}/<path>) and {attacker} (your server, subdomains included). No real network is used.',
  },
  'sim.link': { id: 'Tautan', en: 'Link' },
  'sim.action.check_mail': { id: 'Minta admin memeriksa email', en: 'Ask the admin to check mail' },
  'sim.action.send_link': { id: 'Kirim tautan ke admin', en: 'Send link to the admin' },
  'sim.describe.check_mail': { id: 'membuka surat terbaru dan mengklik tautan pertamanya', en: 'opens the newest mail and clicks its first link' },
  'sim.describe.check_mail_link': { id: 'membuka surat terbaru dan mengklik tautan ke-{n}', en: 'opens the newest mail and clicks link {n} in it' },
  'sim.describe.send_link': { id: 'membuka tautan apa pun yang Anda kirim', en: 'opens any link you send' },
  'sim.note.mailbox_empty': { id: 'Kotak surat korban kosong.', en: "The victim's mailbox is empty." },
  'sim.note.no_link': { id: 'Surat terbaru korban tidak punya tautan ke-{n}.', en: "The victim's newest mail has no link {n}." },
  // The cross-site presets (engine task E1): the attacker's page, its fetch() and its frame.
  'sim.action.visit_page': { id: 'Minta admin membuka halaman Anda', en: 'Ask the admin to open your page' },
  'sim.action.send_page': { id: 'Kirim tautan halaman Anda ke admin', en: 'Send the admin a link to your page' },
  'sim.action.frame_click': { id: 'Minta admin membuka halaman pembingkai Anda', en: 'Ask the admin to open your framing page' },
  'sim.describe.visit_page': {
    id: 'membuka halaman Anda di attacker.test, yang melakukan apa yang Anda tulis di sana',
    en: 'opens your page on attacker.test, which does what you wrote on it',
  },
  'sim.describe.send_page': {
    id: 'membuka tautan ke halaman Anda di attacker.test yang Anda kirim; halaman itu melakukan apa yang Anda tulis di sana',
    en: 'opens the link to your page on attacker.test that you send; the page does what you wrote on it',
  },
  'sim.describe.frame_click': {
    id: 'membuka halaman Anda, yang membingkai tautan citadel.test yang Anda kirim, lalu mengklik tombol umpan Anda',
    en: 'opens your page, which frames the citadel.test link you send, and clicks your decoy button',
  },
  'sim.note.no_page': { id: 'Anda belum menulis halaman penyerang Anda.', en: 'You have not written your attacker page yet.' },
  'sim.note.not_your_server': {
    id: 'Tautan itu tidak berada di server Anda (attacker.test); admin tidak membukanya.',
    en: 'That link is not on your server (attacker.test); the admin does not open it.',
  },
  'sim.note.fetch_read': { id: 'Halaman Anda membaca jawabannya dan mengirimkannya ke server Anda.', en: 'Your page read the answer and sent it to your server.' },
  'sim.note.fetch_preflight': {
    id: 'fetch() di halaman Anda memerlukan preflight CORS (metode atau header yang tidak dimiliki permintaan sederhana); server ini tidak menyetujui satu pun, jadi peramban tidak mengirimnya.',
    en: "Your page's fetch() needs a CORS preflight (a method or header a simple request cannot have); this server approves none, so the browser did not send it.",
  },
  'sim.note.fetch_invalid': {
    id: 'fetch() di halaman Anda gagal sebelum terkirim (GET dengan body, atau header yang tidak bisa dibawanya).',
    en: "Your page's fetch() threw before sending (a GET with a body, or a header it cannot carry).",
  },
  'sim.note.fetch_no_answer': { id: 'fetch() di halaman Anda tidak mendapat jawaban citadel.test untuk dibaca.', en: "Your page's fetch() got no citadel.test answer to read." },
  'sim.note.cors_no_allow_origin': {
    id: 'Peramban mengirim permintaannya, tetapi tidak membiarkan halaman Anda membaca jawabannya: tidak ada Access-Control-Allow-Origin.',
    en: 'The browser sent the request but did not let your page read the answer: it has no Access-Control-Allow-Origin.',
  },
  'sim.note.cors_origin_mismatch': {
    id: 'Peramban mengirim permintaannya, tetapi tidak membiarkan halaman Anda membaca jawabannya: Access-Control-Allow-Origin tidak menyebut asal halaman Anda.',
    en: "The browser sent the request but did not let your page read the answer: Access-Control-Allow-Origin does not name your page's origin.",
  },
  'sim.note.cors_wildcard_credentials': {
    id: 'Peramban mengirim permintaannya, tetapi tidak membiarkan halaman Anda membaca jawabannya: Access-Control-Allow-Origin: * tidak pernah berlaku untuk permintaan dengan kredensial.',
    en: 'The browser sent the request but did not let your page read the answer: Access-Control-Allow-Origin: * never allows a request with credentials.',
  },
  'sim.note.cors_no_allow_credentials': {
    id: 'Peramban mengirim permintaannya, tetapi tidak membiarkan halaman Anda membaca jawabannya: permintaan dengan kredensial juga memerlukan Access-Control-Allow-Credentials: true.',
    en: 'The browser sent the request but did not let your page read the answer: a request with credentials also needs Access-Control-Allow-Credentials: true.',
  },
  'sim.note.frame_x_frame_options': {
    id: 'Peramban menolak menampilkan halaman itu di bingkai Anda: X-Frame-Options.',
    en: 'The browser refused to show that page in your frame: X-Frame-Options.',
  },
  'sim.note.frame_frame_ancestors': {
    id: 'Peramban menolak menampilkan halaman itu di bingkai Anda: Content-Security-Policy frame-ancestors.',
    en: 'The browser refused to show that page in your frame: Content-Security-Policy frame-ancestors.',
  },
  'sim.note.frame_not_loaded': { id: 'Bingkai Anda tidak menampilkan halaman citadel.test.', en: 'Your frame shows no citadel.test page.' },
  'sim.note.nothing_to_click': {
    id: 'Halaman yang dibingkai tidak punya tombol di bawah umpan Anda: klik itu tidak melakukan apa pun.',
    en: 'The framed page has no button under your decoy: the click did nothing.',
  },
  'sim.report': { id: 'Yang dilakukan peramban korban', en: 'What the victim\'s browser did' },
  'sim.opened_nothing': { id: 'Peramban korban tidak membuka apa pun.', en: 'The victim\'s browser opened nothing.' },
  'sim.failed': { id: 'Aksi korban gagal (galat di lab).', en: "The victim's action failed (an error in the lab)." },
  'sim.visits_dropped': { id: '{n} kunjungan sebelumnya tidak ditampilkan.', en: '{n} earlier visit(s) not shown.' },
  'sim.visit': { id: 'Kunjungan {n}: {requests} permintaan; {outcome}.', en: 'Visit {n}: {requests} request(s); {outcome}.' },
  'sim.outcome.page': { id: 'berakhir di halaman citadel.test (HTTP {status})', en: 'ended on a citadel.test page (HTTP {status})' },
  'sim.outcome.attacker': { id: 'sampai di server Anda (attacker.test)', en: 'reached your server (attacker.test)' },
  'sim.outcome.unreachable': { id: 'berhenti: {reason}', en: 'stopped: {reason}' },
  'sim.outcome.too_many_redirects': { id: 'berhenti: lebih dari {n} pengalihan', en: 'stopped: more than {n} redirects' },
  'sim.outcome.loop': { id: 'berhenti: pengalihan berputar-putar', en: 'stopped: redirect loop' },
  'sim.reason.invalid': { id: 'bukan URL absolut yang valid', en: 'not a valid absolute URL' },
  'sim.reason.too_long': { id: 'URL terlalu panjang', en: 'the URL is too long' },
  'sim.reason.scheme': { id: 'hanya tautan http(s) yang diikuti', en: 'only http(s) links are followed' },
  'sim.reason.ip': { id: 'alamat IP tidak dapat dijangkau dalam simulasi', en: 'IP addresses are unreachable in the simulation' },
  'sim.reason.port': { id: 'tidak ada layanan di port citadel.test itu', en: 'nothing listens on that citadel.test port' },
  'sim.reason.host': { id: 'host tidak dikenal (hanya citadel.test dan attacker.test yang ada)', en: 'unknown host (only citadel.test and attacker.test exist)' },
  'sim.mailbox': { id: 'Kotak surat Anda ({address})', en: 'Your mailbox ({address})' },
  'sim.mailbox_empty': { id: 'Belum ada surat.', en: 'No mail yet.' },
  'sim.mail_from': { id: 'Dari', en: 'From' },
  'sim.open_in_lab': { id: 'buka di lab', en: 'open in lab' },
  'sim.log': { id: 'Server Anda (attacker.test) menerima…', en: 'Your server (attacker.test) received…' },
  'sim.log_empty': { id: 'Belum ada permintaan.', en: 'No requests yet.' },
  'sim.body': { id: 'Isi', en: 'Body' },
  'sim.away.heading': { id: 'Peramban Anda tetap di lab', en: 'Your browser stays in the lab' },
  'sim.away.none': {
    id: 'Pengalihan ini tidak punya tujuan (Location kosong), jadi peramban Anda tetap di halaman ini.',
    en: 'This redirect has no target (an empty Location), so your browser stays on this page.',
  },
  'sim.away.lead': { id: 'Peramban Anda sekarang akan menuju:', en: 'Your browser would now go to:' },
  'sim.away.why': {
    id: 'Di lab ini, peramban korban tersimulasi yang pergi ke sana, bukan peramban Anda: pantau log server Anda (attacker.test).',
    en: 'In this lab the simulated victim\'s browser goes there, not yours: watch your server\'s log (attacker.test).',
  },
  // core/twin.ts forwardNote: a page that moves the browser on by itself, shown to the player's real browser instead.
  'sim.forward.lead': { id: 'Halaman ini memindahkan peramban dengan sendirinya ke:', en: 'This page moves the browser on by itself to:' },
  'sim.forward.in_lab': { id: 'Lanjutkan ke sana di lab', en: 'Continue there in the lab' },
  'sim.forward.away': {
    id: 'Peramban Anda tetap di lab; hanya peramban korban tersimulasi yang benar-benar pergi ke sana.',
    en: 'Your browser stays in the lab; only the simulated victim\'s browser really goes there.',
  },
  'diff.vulnerable': { id: 'Rentan', en: 'Vulnerable' },
  'diff.secure': { id: 'Aman (Divine)', en: 'Secure (Divine)' },
  // The platform login (src/auth). One message for every failed sign-in, whatever the cause.
  'auth.login_heading': { id: 'Masuk', en: 'Log in' },
  'auth.login_intro': {
    id: 'HVWA memerlukan login. Akun bawaan dan cara mengganti kata sandinya ada di README.',
    en: 'HVWA requires a login. The default account, and how to change its password, are in the README.',
  },
  'auth.username': { id: 'Nama pengguna', en: 'Username' },
  'auth.password': { id: 'Kata sandi', en: 'Password' },
  'auth.login_button': { id: 'Masuk', en: 'Log in' },
  'auth.login_failed': {
    id: 'Gagal masuk: nama pengguna atau kata sandi salah, atau terlalu banyak percobaan. Coba lagi sebentar lagi.',
    en: 'Login failed: wrong username or password, or too many attempts. Try again in a moment.',
  },
  'auth.csrf_heading': { id: 'Permintaan ditolak', en: 'Request refused' },
  'auth.csrf_failed': {
    id: 'Formulir ini kedaluwarsa atau dikirim dari situs lain. Muat ulang halaman lalu coba lagi.',
    en: 'This form expired or was sent from another site. Reload the page and try again.',
  },
  'auth.csrf_back': { id: 'Kembali', en: 'Go back' },
  'auth.signed_in_as': { id: 'Masuk sebagai', en: 'Signed in as' },
  'auth.logout': { id: 'Keluar', en: 'Log out' },
  'auth.change_password': { id: 'Ganti kata sandi', en: 'Change password' },
  'auth.default_banner': {
    id: 'Anda masih memakai kata sandi bawaan — segera ganti.',
    en: "You're using the default password — change it.",
  },
  'auth.pw_heading': { id: 'Ganti Kata Sandi', en: 'Change Password' },
  'auth.pw_rules': {
    id: 'Minimal 8 karakter, berbeda dari kata sandi saat ini dan dari kata sandi bawaan. Setelah diganti, semua sesi lain keluar.',
    en: 'At least 8 characters, different from the current one and from the default. Changing it signs every other session out.',
  },
  'auth.pw_current': { id: 'Kata sandi saat ini', en: 'Current password' },
  'auth.pw_new': { id: 'Kata sandi baru', en: 'New password' },
  'auth.pw_confirm': { id: 'Ulangi kata sandi baru', en: 'Repeat the new password' },
  'auth.pw_button': { id: 'Ganti kata sandi', en: 'Change password' },
  'auth.pw_changed': { id: 'Kata sandi diganti. Semua sesi lain telah keluar.', en: 'Password changed. Every other session was signed out.' },
  'auth.pw_err_current': {
    id: 'Kata sandi saat ini salah, atau terlalu banyak percobaan. Coba lagi sebentar lagi.',
    en: 'The current password is wrong, or there were too many attempts. Try again in a moment.',
  },
  'auth.pw_err_too_short': { id: 'Kata sandi baru minimal 8 karakter.', en: 'The new password needs at least 8 characters.' },
  'auth.pw_err_too_long': { id: 'Kata sandi baru maksimal 1024 karakter.', en: 'The new password can have at most 1024 characters.' },
  'auth.pw_err_control': { id: 'Kata sandi baru tidak boleh berisi karakter kontrol.', en: 'The new password cannot contain control characters.' },
  'auth.pw_err_mismatch': { id: 'Kedua kata sandi baru tidak sama.', en: 'The two new passwords do not match.' },
  'auth.pw_err_same': { id: 'Kata sandi baru harus berbeda dari yang sekarang.', en: 'The new password must differ from the current one.' },
  'auth.pw_err_default': { id: 'Kata sandi baru tidak boleh kata sandi bawaan.', en: 'The new password cannot be the default password.' },
  'safety.warning': {
    id: 'PERINGATAN: Aplikasi ini sengaja rentan. Jangan pernah mengeksposnya ke jaringan yang tidak tepercaya.',
    en: 'WARNING: This app is deliberately vulnerable. Never expose it to an untrusted network.',
  },
});

export function isLang(x: unknown): x is Lang {
  return typeof x === 'string' && (LANGS as readonly string[]).includes(x);
}

// Translate a key; unknown keys echo themselves so missing strings are visible.
// Object.hasOwn so inherited names ('toString', '__proto__', ...) are unknown.
export function t(key: string, lang: Lang = DEFAULT_LANG): string {
  return Object.hasOwn(DICT, key) ? DICT[key][lang] : key;
}

// lang = valid ?lang= → valid hvwa_lang cookie → DEFAULT_LANG.
// Exposes req.lang + res.locals.{lang,t}.
export function langMiddleware(): RequestHandler {
  return (req, res, next) => {
    const lang = preference(req, res, { query: 'lang', cookie: 'hvwa_lang', isValid: isLang, fallback: DEFAULT_LANG });
    req.lang = lang;
    res.locals.lang = lang;
    res.locals.t = (key: string) => t(key, lang);
    next();
  };
}
