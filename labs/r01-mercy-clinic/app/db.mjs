// labs/r01-mercy-clinic/app/db.mjs — the clinic's SQLite store (node:sqlite, --experimental-sqlite). The DB lives in the
// /tmp tmpfs because the rootfs is read-only. The notice search is the vulnerable feature; its three implementations are
// chosen by HVWA_LEVEL. The flag is a staff-only notice planted by the start hook (never on a public page).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const seed = (name) => JSON.parse(readFileSync(join(here, 'seed', name), 'utf8'));

export function openDb(path = '/tmp/clinic.db') {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE patients (id INTEGER PRIMARY KEY, name TEXT, role TEXT, room TEXT);
    CREATE TABLE notices  (id INTEGER PRIMARY KEY, title TEXT, body TEXT, visibility TEXT NOT NULL DEFAULT 'public');
  `);
  const ins = db.prepare('INSERT INTO patients (name, role, room) VALUES (?, ?, ?)');
  for (const p of seed('patients.json')) ins.run(p.name, p.role, p.room);
  const insN = db.prepare('INSERT INTO notices (title, body, visibility) VALUES (?, ?, ?)');
  for (const n of seed('notices.json')) insN.run(n.title, n.body, 'public');
  return db;
}

/** The start hook: plant the flag (or a Divine decoy) as a staff-only notice, invisible to the public pages. */
export function plantFlag(db, level, flag) {
  const body = level === 'divine' || !flag
    ? 'Divine is the secure reference: the search is parameterised, so there is no flag to recover here.'
    : flag;
  db.prepare('INSERT INTO notices (title, body, visibility) VALUES (?, ?, ?)')
    .run('Internal — do not distribute', body, 'staff');
}

/** Public notices for the home page and /notices/:id (always visibility='public'; parameterised everywhere). */
export const listPublic = (db) => db.prepare("SELECT id, title, body FROM notices WHERE visibility = 'public' ORDER BY id").all();
export const getPublic = (db, id) => db.prepare("SELECT id, title, body FROM notices WHERE visibility = 'public' AND id = ?").get(id);
export const listPatients = (db) => db.prepare('SELECT name, role, room FROM patients ORDER BY id').all();

/**
 * The notice search, per level. Returns rows [{ id, title, body }].
 * - acolyte: q concatenated straight into a LIKE string literal (classic SQLi).
 * - templar: the keywords union/select are stripped ONCE, then the same concatenation (a single-pass blacklist).
 * - divine:  a parameterised statement; q is bound data and the visibility filter is fixed.
 */
export function searchNotices(db, level, q) {
  if (level === 'divine') {
    const like = `%${q}%`;
    return db.prepare("SELECT id, title, body FROM notices WHERE visibility = 'public' AND (title LIKE ? OR body LIKE ?) ORDER BY id").all(like, like);
  }
  const term = level === 'templar' ? q.replace(/union|select/gi, '') : q;
  const sql = "SELECT id, title, body FROM notices WHERE visibility = 'public' AND (title LIKE '%" + term + "%' OR body LIKE '%" + term + "%') ORDER BY id";
  try {
    return db.prepare(sql).all();
  } catch {
    return []; // a malformed injection just yields no rows, like a real app swallowing a query error
  }
}
