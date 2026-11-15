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
  // The simulated-victim panel (core/sim.ts, core/views/sim-panel.ejs). {name} placeholders are filled by sim.ts.
  'sim.heading': { id: 'Korban tersimulasi', en: 'Simulated victim' },
  'sim.hosts': {
    id: 'Peramban korban hanya mengenal dua situs: {citadel} (lab ini: {citadel}/<path> adalah {lab}/<path>) dan {attacker} (server Anda, termasuk subdomainnya). Tidak ada jaringan sungguhan.',
    en: 'The victim\'s browser knows only two sites: {citadel} (this lab: {citadel}/<path> is {lab}/<path>) and {attacker} (your server, subdomains included). No real network is used.',
  },
  'sim.link': { id: 'Tautan', en: 'Link' },
  'sim.action.check_mail': { id: 'Minta admin memeriksa email', en: 'Ask the admin to check mail' },
  'sim.action.send_link': { id: 'Kirim tautan ke admin', en: 'Send link to the admin' },
  'sim.report': { id: 'Yang dilakukan peramban korban', en: 'What the victim\'s browser did' },
  'sim.opened_nothing': { id: 'Peramban korban tidak membuka apa pun.', en: 'The victim\'s browser opened nothing.' },
  'sim.visit': { id: 'Kunjungan {n}: {requests} permintaan; {outcome}.', en: 'Visit {n}: {requests} request(s); {outcome}.' },
  'sim.outcome.page': { id: 'berakhir di halaman citadel.test (HTTP {status})', en: 'ended on a citadel.test page (HTTP {status})' },
  'sim.outcome.attacker': { id: 'sampai di server Anda (attacker.test)', en: 'reached your server (attacker.test)' },
  'sim.outcome.unreachable': { id: 'berhenti: {reason}', en: 'stopped: {reason}' },
  'sim.outcome.too-many-redirects': { id: 'berhenti: lebih dari {n} pengalihan', en: 'stopped: more than {n} redirects' },
  'sim.outcome.loop': { id: 'berhenti: pengalihan berputar-putar', en: 'stopped: redirect loop' },
  'sim.reason.invalid': { id: 'bukan URL absolut yang valid', en: 'not a valid absolute URL' },
  'sim.reason.too-long': { id: 'URL terlalu panjang', en: 'the URL is too long' },
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
  'diff.vulnerable': { id: 'Rentan', en: 'Vulnerable' },
  'diff.secure': { id: 'Aman (Divine)', en: 'Secure (Divine)' },
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
