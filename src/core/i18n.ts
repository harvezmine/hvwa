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
  'challenge.result_ok': { id: 'Benar! Tantangan terpecahkan di level', en: 'Correct! Solved at level' },
  'challenge.result_bad': { id: 'Salah. Coba lagi.', en: 'Incorrect. Try again.' },
  'challenge.source': { id: 'Lihat Source', en: 'View Source' },
  'challenge.diff': { id: 'Bandingkan Rentan vs Aman', en: 'Compare Vulnerable vs Secure' },
  'challenge.back': { id: 'Kembali ke tantangan', en: 'Back to challenge' },
  'diff.vulnerable': { id: 'Rentan (Acolyte)', en: 'Vulnerable (Acolyte)' },
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
