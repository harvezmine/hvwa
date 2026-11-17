// src/core/i18n.ts
import type { RequestHandler } from 'express';
import { preference } from './cookies.js';

export const LANGS = Object.freeze(['id', 'en'] as const);
export type Lang = (typeof LANGS)[number];
export const DEFAULT_LANG: Lang = 'en';

type Entry = { id: string; en: string };

// PLATFORM strings only (nav, portal, scoreboard, diff headers, warnings).
// Challenge text stays in each challenge's metadata ({ id, en } fields).
const DICT: Readonly<Record<string, Entry>> = Object.freeze({
  'app.title': { id: 'HVWA — Kota Suci yang Rentan', en: 'HVWA — Holy Vulnerable Web App' },
  'app.tagline': { id: 'Lab latihan keamanan web yang sengaja rentan.', en: 'A deliberately vulnerable web-security training lab.' },
  'app.footer': {
    id: 'Berjalan sepenuhnya offline di mesin ini. Tidak ada permintaan yang keluar.',
    en: 'Runs fully offline on this machine. Nothing is sent anywhere.',
  },
  // The top navigation (core/views/layout.ejs).
  'nav.home': { id: 'Beranda', en: 'Home' },
  'nav.districts': { id: 'Distrik', en: 'Districts' },
  'nav.scoreboard': { id: 'Papan Skor', en: 'Scoreboard' },
  'nav.main': { id: 'Navigasi utama', en: 'Main navigation' },
  'nav.skip': { id: 'Lewati ke konten', en: 'Skip to content' },
  'nav.breadcrumb': { id: 'Jejak navigasi', en: 'Breadcrumb' },
  'nav.language': { id: 'Bahasa', en: 'Language' },
  'nav.lang_en': { id: 'Tampilkan dalam bahasa Inggris', en: 'Show in English' },
  'nav.lang_id': { id: 'Tampilkan dalam bahasa Indonesia', en: 'Show in Indonesian' },
  'nav.account': { id: 'Menu akun', en: 'Account menu' },
  'theme.to_light': { id: 'Ganti ke tema terang', en: 'Switch to light theme' },
  'theme.to_dark': { id: 'Ganti ke tema gelap', en: 'Switch to dark theme' },
  // The portal home (portal/views/index.ejs).
  'home.eyebrow': { id: 'Lab latihan keamanan web', en: 'Web security training lab' },
  'home.title': { id: 'Latih keamanan web, level demi level', en: 'Practice web security, level by level' },
  'home.lead': {
    id: 'Setiap tantangan adalah aplikasi web kecil yang sengaja dibuat rusak. Temukan celahnya, eksploitasi, ambil flag-nya, lalu pelajari perbaikan yang aman.',
    en: 'Each challenge is a small web app with a deliberate flaw. Find the flaw, exploit it, capture the flag, then study the secure fix.',
  },
  'home.next': { id: 'Lanjutkan: {id}', en: 'Continue: {id}' },
  'home.all_done': { id: 'Semua tantangan terpecahkan', en: 'Every challenge solved' },
  'home.how_link': { id: 'Cara bermain', en: 'How to play' },
  'home.progress': { id: 'Kemajuan Anda', en: 'Your progress' },
  'home.stat_solved': { id: 'Tantangan terpecahkan', en: 'Challenges solved' },
  'home.stat_score': { id: 'Skor', en: 'Score' },
  'home.stat_districts': { id: 'Distrik', en: 'Districts' },
  'home.of': { id: 'dari {n}', en: 'of {n}' },
  'portal.heading': { id: 'Peta Distrik', en: 'District Map' },
  'portal.challenges': { id: 'tantangan', en: 'challenges' },
  'portal.no_challenges': { id: 'Belum ada tantangan terdaftar.', en: 'No challenges registered yet.' },
  // Districts: platform copy for the four districts; an unknown district falls back to its id.
  'district.eyebrow': { id: 'Distrik', en: 'District' },
  'district.enter': { id: 'Masuki distrik', en: 'Enter district' },
  'district.list': { id: 'Daftar tantangan', en: 'Challenge list' },
  'district.solved_of': { id: '{solved} dari {total} terpecahkan', en: '{solved} of {total} solved' },
  'district.fallback_desc': { id: 'Tantangan di distrik ini.', en: 'Challenges in this district.' },
  'district.gatekeeper.name': { id: 'Gatekeeper', en: 'Gatekeeper' },
  'district.gatekeeper.desc': {
    id: 'Autentikasi dan kontrol akses: login, token, sesi, reset kata sandi, dan peran.',
    en: 'Authentication and access control: logins, tokens, sessions, password resets and roles.',
  },
  'district.relic_market.name': { id: 'Relic Market', en: 'Relic Market' },
  'district.relic_market.desc': {
    id: 'Sebuah toko online: injeksi, celah logika bisnis, race condition, dan akses objek yang rusak.',
    en: 'An online shop: injection, business-logic flaws, race conditions and broken object access.',
  },
  'district.scriptorium.name': { id: 'Scriptorium', en: 'Scriptorium' },
  'district.scriptorium.desc': {
    id: 'Konten dan berkas: cross-site scripting, unggahan, arsip, dan path traversal.',
    en: 'Content and files: cross-site scripting, uploads, archives and path traversal.',
  },
  'district.forum_of_pilgrims.name': { id: 'Forum of Pilgrims', en: 'Forum of Pilgrims' },
  'district.forum_of_pilgrims.desc': {
    id: 'Forum komunitas: stored XSS, open redirect, pesan pribadi, dan injeksi orde kedua.',
    en: 'A community forum: stored XSS, open redirects, private messages and second-order injection.',
  },
  'district.filter': { id: 'Saring tantangan', en: 'Filter challenges' },
  'district.filter_all': { id: 'Semua', en: 'All' },
  'district.filter_todo': { id: 'Belum terpecahkan', en: 'Not solved' },
  'district.filter_done': { id: 'Terpecahkan', en: 'Solved' },
  'district.filter_empty': { id: 'Tidak ada tantangan yang cocok dengan saringan ini.', en: 'No challenge matches this filter.' },
  'district.show_all': { id: 'Tampilkan semua', en: 'Show all' },
  'scoreboard.title': { id: 'Papan Skor', en: 'Scoreboard' },
  'scoreboard.lead': {
    id: 'Kemajuan sesi peramban ini. Petunjuk yang Anda buka mengurangi skor.',
    en: 'Progress of this browser session. Hints you unlock are taken off your score.',
  },
  'scoreboard.score': { id: 'Skor', en: 'Score' },
  'scoreboard.solved': { id: 'Terpecahkan', en: 'Solved' },
  'scoreboard.hint_cost': { id: 'Biaya petunjuk', en: 'Hint costs' },
  'scoreboard.by_district': { id: 'Per distrik', en: 'By district' },
  'scoreboard.by_level': { id: 'Per level', en: 'By level' },
  'scoreboard.col_district': { id: 'Distrik', en: 'District' },
  'scoreboard.col_solved': { id: 'Terpecahkan', en: 'Solved' },
  'scoreboard.col_points': { id: 'Poin', en: 'Points' },
  'scoreboard.col_level': { id: 'Level', en: 'Level' },
  'scoreboard.col_multiplier': { id: 'Pengali poin', en: 'Point multiplier' },
  'scoreboard.col_best': { id: 'Tantangan dengan level terbaik ini', en: 'Challenges with this best level' },
  'scoreboard.not_scored': { id: 'tidak dinilai', en: 'not scored' },
  'scoreboard.empty': { id: 'Belum ada yang terpecahkan. Pilih distrik untuk mulai.', en: 'Nothing solved yet. Pick a district to start.' },
  'level.acolyte': { id: 'Acolyte', en: 'Acolyte' },
  'level.templar': { id: 'Templar', en: 'Templar' },
  'level.inquisitor': { id: 'Inquisitor', en: 'Inquisitor' },
  'level.divine': { id: 'Divine', en: 'Divine' },
  // One line per level: what changes when you pick it (challenge page, lab bar, docs/UI.md).
  'level_meaning.acolyte': { id: 'Tanpa pertahanan. Pelajari cara celahnya bekerja.', en: 'No defences. Learn how the flaw works.' },
  'level_meaning.templar': { id: 'Pertahanan dasar yang bercelah. Temukan celahnya.', en: 'A basic, flawed defence. Find the gap.' },
  'level_meaning.inquisitor': { id: 'Pertahanan lebih kuat. Tembus dengan cermat.', en: 'A stronger defence. Bypass it with care.' },
  'level_meaning.divine': {
    id: 'Perbaikan yang aman. Tidak ada yang bisa dieksploitasi: pelajari caranya.',
    en: 'The secure fix. Nothing to exploit: study how it is done.',
  },
  'challenge.briefing': { id: 'Pengarahan', en: 'Briefing' },
  'challenge.levels': { id: 'Pilih level', en: 'Choose a level' },
  'challenge.levels_lead': {
    id: 'Setiap level membuka lab yang sama dengan pertahanan yang lebih kuat. Level lebih tinggi memberi lebih banyak poin.',
    en: 'Every level opens the same lab with a stronger defence. Higher levels are worth more points.',
  },
  'challenge.your_level': { id: 'Level Anda', en: 'Your level' },
  'challenge.solved': { id: 'Terpecahkan', en: 'Solved' },
  'challenge.unsolved': { id: 'Belum terpecahkan', en: 'Not solved' },
  'challenge.open_lab': { id: 'Buka lab', en: 'Open the lab' },
  'challenge.open_lab_at': { id: 'Buka lab di level {level}', en: 'Open the lab at {level}' },
  'challenge.lab_lead': {
    id: 'Lab terbuka di tab ini. Bilah di atasnya memungkinkan Anda ganti level, memulai ulang lab, atau kembali ke sini.',
    en: 'The lab opens in this tab. The bar at its top lets you switch level, restart the lab or come back here.',
  },
  'challenge.hints': { id: 'Petunjuk', en: 'Hints' },
  'challenge.hints_lead': {
    id: 'Buntu? Buka petunjuk satu per satu, dari yang paling umum. Setiap petunjuk mengurangi skor Anda.',
    en: 'Stuck? Unlock hints one at a time, most general first. Each one is taken off your score.',
  },
  'challenge.no_hints': { id: 'Tantangan ini tidak punya petunjuk.', en: 'This challenge has no hints.' },
  'challenge.hint_tier': { id: 'Petunjuk', en: 'Hint' },
  'challenge.hint_locked': { id: 'terkunci', en: 'locked' },
  'challenge.hint_unlocked': { id: 'terbuka', en: 'unlocked' },
  'challenge.hint_unlock': { id: 'Buka petunjuk', en: 'Unlock hint' },
  'challenge.hint_cost': { id: 'Biaya', en: 'Cost' },
  'challenge.points': { id: 'poin', en: 'points' },
  'challenge.submit_heading': { id: 'Kirim flag', en: 'Submit a flag' },
  'challenge.submit_label': { id: 'Flag', en: 'Flag' },
  'challenge.submit_help': {
    id: 'Tempel flag yang diberikan lab, misalnya HVWA{…}. Level yang Anda pecahkan dikenali dari flag-nya.',
    en: 'Paste the flag the lab gave you, such as HVWA{…}. The level you solved is read from the flag.',
  },
  'challenge.submit_button': { id: 'Kirim', en: 'Submit' },
  'challenge.result_new_best': { id: 'Benar! Level terbaik baru:', en: 'Correct! New best level:' },
  'challenge.result_already': { id: 'Sudah terpecahkan di level', en: 'Already solved at level' },
  'challenge.result_lower': { id: 'Benar, tetapi level terbaik Anda tetap', en: 'Correct, but your best remains' },
  'challenge.hint_confirm': { id: 'Buka petunjuk ini? Skor Anda akan berkurang.', en: 'Unlock this hint? It will reduce your score.' },
  'challenge.result_bad': { id: 'Salah. Periksa flag-nya lalu coba lagi.', en: 'Incorrect. Check the flag and try again.' },
  'challenge.source': { id: 'Kode sumber', en: 'Source code' },
  'challenge.source_lead': {
    id: 'Kode server tiap level boleh dibaca: itu bagian dari pelajaran.',
    en: 'You may read the server code of every level: it is part of the lesson.',
  },
  'challenge.source_level': { id: 'Kode {level}', en: '{level} code' },
  'challenge.diff': { id: 'Bandingkan Rentan vs Aman', en: 'Compare Vulnerable vs Secure' },
  'challenge.divine_tab': { id: 'Divine (referensi aman)', en: 'Divine (secure reference)' },
  'challenge.err_invalid_tier': { id: 'Tingkat petunjuk tidak valid.', en: 'Invalid hint tier.' },
  'challenge.err_unknown_tier': { id: 'Petunjuk tidak tersedia.', en: 'Hint not available.' },
  'challenge.diff_title': { id: 'perbandingan', en: 'diff' },
  'challenge.diff_lead': {
    id: 'Kiri: level rentan terendah. Kanan: Divine, perbaikan yang aman. Baris yang berubah disorot.',
    en: 'Left: the lowest vulnerable level. Right: Divine, the secure fix. Changed lines are highlighted.',
  },
  'challenge.back': { id: 'Kembali ke tantangan', en: 'Back to challenge' },
  'challenge.solved_at': { id: 'Terpecahkan di {level}', en: 'Solved at {level}' },
  // The "How to play" card (challenge page and home).
  'howto.heading': { id: 'Cara bermain', en: 'How to play' },
  'howto.step1': { id: 'Pilih level. Baru mulai? Ambil Acolyte.', en: 'Pick a level. New here? Start with Acolyte.' },
  'howto.step2': {
    id: 'Buka lab dan temukan celahnya. Membaca kode sumber diperbolehkan.',
    en: 'Open the lab and find the flaw. Reading the source code is allowed.',
  },
  'howto.step3': { id: 'Eksploitasi celahnya. Lab memberi Anda flag saat berhasil.', en: 'Exploit it. The lab gives you a flag when you succeed.' },
  'howto.step4': {
    id: 'Tempel flag di "Kirim flag", lalu bandingkan dengan Divine untuk melihat perbaikannya.',
    en: 'Paste the flag in "Submit a flag", then compare with Divine to see the fix.',
  },
  // The lab bar (core/views/layout.ejs) on every lab page.
  'lab.bar_label': { id: 'Kontrol lab', en: 'Lab controls' },
  'lab.crumb': { id: 'Lab', en: 'Lab' },
  'lab.current_level': { id: 'Level saat ini', en: 'Current level' },
  'lab.you_are_on': { id: 'Anda di level', en: 'You are on' },
  'lab.switch_level': { id: 'Ganti level', en: 'Switch level' },
  'lab.restart': { id: 'Mulai ulang lab', en: 'Restart lab' },
  'lab.restart_help': { id: 'Menghapus status lab ini untuk sesi Anda.', en: 'Clears this lab’s state for your session.' },
  'lab.restart_cooldown': { id: 'Mulai ulang sedang jeda. Coba lagi sebentar lagi.', en: 'Restart is cooling down. Try again in a moment.' },
  // Error pages (core/errors.ts).
  'error.not_found_title': { id: 'Halaman tidak ditemukan', en: 'Page not found' },
  'error.not_found_lead': {
    id: 'Halaman ini tidak ada, atau tautannya sudah usang.',
    en: 'This page does not exist, or the link is out of date.',
  },
  'error.client_title': { id: 'Permintaan ditolak', en: 'Request refused' },
  'error.client_lead': { id: 'Server tidak dapat memproses permintaan ini.', en: 'The server could not process this request.' },
  'error.server_title': { id: 'Terjadi kesalahan', en: 'Something went wrong' },
  'error.server_lead': {
    id: 'Permintaan tidak selesai. Rinciannya sengaja tidak ditampilkan.',
    en: 'The request did not complete. Its details are deliberately not shown.',
  },
  'error.home': { id: 'Kembali ke beranda', en: 'Back to home' },
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
    id: 'Masuk dengan akun admin HVWA. Akun bawaan dan cara mengganti kata sandinya dijelaskan di README.',
    en: 'Sign in with the HVWA admin account. The README explains the default account and how to change its password.',
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
    id: 'Setelah diganti, semua sesi lain akan keluar; peramban ini tetap masuk.',
    en: 'Changing it signs every other session out; this browser stays signed in.',
  },
  'auth.pw_current': { id: 'Kata sandi saat ini', en: 'Current password' },
  'auth.pw_new': { id: 'Kata sandi baru', en: 'New password' },
  'auth.pw_new_help': {
    id: 'Minimal 8 karakter, berbeda dari kata sandi saat ini dan dari kata sandi bawaan. Lebih panjang lebih kuat: frasa sandi empat kata atau lebih paling baik.',
    en: 'At least 8 characters, different from the current one and from the default. Longer is stronger: a passphrase of four or more words is best.',
  },
  'auth.pw_strength': { id: 'Kekuatan', en: 'Strength' },
  'auth.pw_strength_weak': { id: 'lemah', en: 'weak' },
  'auth.pw_strength_fair': { id: 'cukup', en: 'fair' },
  'auth.pw_strength_strong': { id: 'kuat', en: 'strong' },
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
    id: 'Lab latihan: aplikasi ini sengaja rentan. Jangan pernah mengeksposnya ke jaringan yang tidak tepercaya.',
    en: 'Training lab: this app is deliberately vulnerable. Never expose it to an untrusted network.',
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

/** A district's display name: its platform copy (district.<id>.name), else its id in title case. */
export function districtName(id: string, lang: Lang = DEFAULT_LANG): string {
  const key = `district.${id.replace(/-/g, '_')}.name`;
  const name = t(key, lang);
  return name !== key ? name : id.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** A district's one-line description (district.<id>.desc), else a generic line. */
export function districtBlurb(id: string, lang: Lang = DEFAULT_LANG): string {
  const key = `district.${id.replace(/-/g, '_')}.desc`;
  const desc = t(key, lang);
  return desc !== key ? desc : t('district.fallback_desc', lang);
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
