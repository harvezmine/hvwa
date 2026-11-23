// labs/r01-mercy-clinic/app/db.mjs — the clinic's SQLite stores (node:sqlite, --experimental-sqlite). The DBs live in
// the /tmp tmpfs because the rootfs is read-only. The main clinic DB holds patients, notices and the level's flag shelf:
// Acolyte a staff-only notice, Templar a randomly named vault table named by `vault_index`, Inquisitor a randomly named
// ledger table reached through the token-gated staff route. Inquisitor's injectable search runs against a SEPARATE
// public DB that holds only the public notices and the service token, so a direct UNION cannot reach the flag — the
// token is the only useful leak, and the token-gated route returns a record number rather than the flag itself.
// The implementations are chosen by HVWA_LEVEL.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const seed = (name) => JSON.parse(readFileSync(join(here, 'seed', name), 'utf8'));

/** Build an absolute UTC timestamp from today's date plus a day offset and an HH:MM time. */
function startsAt(dayOffset, time) {
  const now = new Date();
  const [hour, minute] = String(time).split(':').map(Number);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset, hour, minute)).toISOString();
}

export function openDb(path = '/tmp/clinic.db') {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE patients (id INTEGER PRIMARY KEY, name TEXT, role TEXT, department TEXT, room TEXT,
                           extension TEXT, pronouns TEXT, bio TEXT);
    CREATE TABLE notices  (id INTEGER PRIMARY KEY, title TEXT, body TEXT, visibility TEXT NOT NULL DEFAULT 'public',
                           category TEXT, author TEXT, published_at TEXT);
    CREATE TABLE appointments (id INTEGER PRIMARY KEY, patient_label TEXT, clinician TEXT, department TEXT, room TEXT,
                               starts_at TEXT, duration_min INTEGER, status TEXT);
    -- The internal index the search can leak at Templar. It names the vault table and column; the flag itself is
    -- never here. Acolyte keeps the flag in a staff notice, Templar in the vault table, Inquisitor in the ledger.
    CREATE TABLE vault_index (id INTEGER PRIMARY KEY, table_name TEXT, column_name TEXT, label TEXT);
  `);
  const insPatient = db.prepare('INSERT INTO patients (name, role, department, room, extension, pronouns, bio) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const p of seed('patients.json')) {
    insPatient.run(p.name, p.role, p.department ?? null, p.room ?? null, p.extension ?? null, p.pronouns ?? null, p.bio ?? null);
  }
  const insNotice = db.prepare('INSERT INTO notices (title, body, visibility, category, author, published_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (const n of seed('notices.json')) {
    insNotice.run(n.title, n.body, n.visibility ?? 'public', n.category ?? null, n.author ?? null, n.published_at ?? null);
  }
  const insAppointment = db.prepare('INSERT INTO appointments (patient_label, clinician, department, room, starts_at, duration_min, status) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const a of seed('appointments.json')) {
    insAppointment.run(a.patient_label ?? null, a.clinician, a.department, a.room ?? null,
      startsAt(a.day_offset ?? 0, a.time), a.duration_min ?? 15, a.status ?? 'booked');
  }
  return db;
}

/**
 * The public search DB: only the public notices and the service token. Inquisitor's injectable search runs here, so
 * even a direct UNION over `notices` cannot reach a staff notice or the flag — the token is the only secret in this
 * file. A trailing `ATTACH DATABASE '/tmp/clinic.db' …` in an injection cannot bridge the two either: node:sqlite's
 * prepare compiles and runs only the first statement, so the public connection never gains the main DB's schema.
 */
export function openPublicDb(path = '/tmp/public.db') {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE notices (id INTEGER PRIMARY KEY, title TEXT, body TEXT, visibility TEXT NOT NULL DEFAULT 'public',
                           category TEXT, author TEXT, published_at TEXT);
    CREATE TABLE staff_tokens (id INTEGER PRIMARY KEY, token TEXT, label TEXT);
  `);
  const insNotice = db.prepare('INSERT INTO notices (title, body, visibility, category, author, published_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (const n of seed('notices.json')) {
    if ((n.visibility ?? 'public') !== 'public') continue; // staff rows and the planted flag never enter this DB
    insNotice.run(n.title, n.body, 'public', n.category ?? null, n.author ?? null, n.published_at ?? null);
  }
  // A fresh 128-bit service token at start, on every level. This is the only thing Inquisitor's search can usefully leak.
  db.prepare('INSERT INTO staff_tokens (token, label) VALUES (?, ?)')
    .run(randomBytes(16).toString('hex'), 'Mercy Clinic staff notices');
  return db;
}

/**
 * The start hook. Each tier files the flag on a different shelf and returns the ledger table the staff route uses:
 * - acolyte:    a staff-only notice in `notices`, exactly the shelf the easy UNION knows.
 * - templar:    a randomly named vault table, named by the `vault_index` row the injection can leak; the staff
 *               notice is only a decoy pointing at the index.
 * - inquisitor: a randomly named ledger table, reached through the token-gated /staff/ledger route; the staff
 *               notice only carries the record number, so the token alone is not the flag.
 * - divine:     decoys only; there is no flag to recover.
 * Decoy vault and archive tables exist at every tier, so a leaked table name is not automatically the flag table.
 */
export function plantFlag(db, level, flag) {
  const vaultTable = `vault_${randomBytes(4).toString('hex')}`;
  const archiveTable = `archive_${randomBytes(4).toString('hex')}`;
  const ledgerTable = `ledger_${randomBytes(4).toString('hex')}`;
  db.exec(`CREATE TABLE ${vaultTable} (id INTEGER PRIMARY KEY, title TEXT, payload TEXT);
           CREATE TABLE ${archiveTable} (id INTEGER PRIMARY KEY, title TEXT, payload TEXT);
           CREATE TABLE ${ledgerTable} (id INTEGER PRIMARY KEY, title TEXT, body TEXT);`);
  // Decoy shelves hold honeypot flags (decoys.ts): an injection into the wrong table rewards the player with a taunt,
  // not the flag. At Templar the vault row below is overwritten with the real flag; the archive stays a honeypot.
  db.prepare(`INSERT INTO ${vaultTable} (title, payload) VALUES (?, ?)`)
    .run('Vault record', 'HVWA{y0u_f0und_th3_d3c0y}');
  db.prepare(`INSERT INTO ${archiveTable} (title, payload) VALUES (?, ?)`)
    .run('Archive record', 'HVWA{wr0ng_sh3lf_buddy}');
  db.prepare('INSERT INTO vault_index (table_name, column_name, label) VALUES (?, ?, ?)')
    .run(vaultTable, 'payload', 'Internal vault');

  const ledgerBody = level === 'divine' || !flag ? 'No ledger is available at this level.' : flag;
  db.prepare(`INSERT INTO ${ledgerTable} (title, body) VALUES (?, ?)`).run('Vault ledger', ledgerBody);

  if (flag && level === 'acolyte') {
    db.prepare('INSERT INTO notices (title, body, visibility) VALUES (?, ?, ?)')
      .run('Internal — do not distribute', flag, 'staff');
  } else if (flag && level === 'templar') {
    db.prepare(`UPDATE ${vaultTable} SET payload = ? WHERE id = 1`).run(flag);
    db.prepare('INSERT INTO notices (title, body, visibility) VALUES (?, ?, ?)')
      .run('Internal — moved', 'The internal notice has moved to the vault index. The search still knows the shelf.', 'staff');
  } else if (flag && level === 'inquisitor') {
    db.prepare('INSERT INTO notices (title, body, visibility) VALUES (?, ?, ?)')
      .run('Internal — vault ledger',
        'The vault ledger was moved. Request record #1 from /staff/ledger/1 with the service token.', 'staff');
  } else {
    db.prepare('INSERT INTO notices (title, body, visibility) VALUES (?, ?, ?)')
      .run('Internal — do not distribute', level === 'divine'
        ? 'Divine is the secure reference: the search is parameterised, so there is no flag to recover here.'
        : 'The internal notice is no longer kept here.', 'staff');
  }
  return { ledgerTable };
}

/** One ledger record by id, for the token-gated /staff/ledger route. The table name is generated at start. */
export function getLedger(db, table, id) {
  if (!/^ledger_[a-f0-9]{8,}$/.test(table)) return undefined;
  try {
    return db.prepare(`SELECT id, title, body FROM ${table} WHERE id = ?`).get(id);
  } catch {
    return undefined;
  }
}

/** Public notices for the home page and /notices/:id (always visibility='public'; parameterised everywhere). */
export const listPublic = (db) => db.prepare("SELECT id, title, body, category, author, published_at FROM notices WHERE visibility = 'public' ORDER BY published_at DESC, id DESC").all();
export const getPublic = (db, id) => db.prepare("SELECT id, title, body, category, author, published_at FROM notices WHERE visibility = 'public' AND id = ?").get(id);
export const relatedPublic = (db, category, id) => db.prepare("SELECT id, title, body, category, author, published_at FROM notices WHERE visibility = 'public' AND category = ? AND id <> ? ORDER BY published_at DESC, id DESC LIMIT 3").all(category, id);
export const listPatients = (db) => db.prepare('SELECT name, role, department, room, extension, pronouns, bio FROM patients ORDER BY department, name').all();
export const listAppointments = (db) => db.prepare('SELECT clinician, department, room, starts_at, duration_min, status FROM appointments ORDER BY starts_at, clinician').all();

/** The service token that unlocks the staff notices (one row per process, in the public search DB). */
export const staffToken = (db) => db.prepare('SELECT token FROM staff_tokens ORDER BY id LIMIT 1').get()?.token;
/** Staff-only notices from the main clinic DB, including whatever the start hook planted. Only the token-gated route renders these. */
export const listStaff = (db) => db.prepare("SELECT id, title, body, category, author, published_at FROM notices WHERE visibility = 'staff' ORDER BY published_at DESC, id DESC").all();

/**
 * The notice search, per level. Acolyte/Templar return rows [{ id, title, body }]; Inquisitor adds a fourth
 * `visibility` column so the server can drop any injected row that does not claim to be public.
 * - acolyte:    q concatenated straight into a LIKE string literal (classic SQLi) against the main clinic DB.
 * - templar:    the keywords union/select are stripped ONCE, then the same concatenation against the main clinic DB.
 * - inquisitor: the same concatenation against the public search DB only; a UNION can reach staff_tokens there, but
 *               that DB has no staff notices or flag to read directly.
 * - divine:     a parameterised statement; q is bound data and the visibility filter is fixed.
 */
export function searchNotices(db, level, q) {
  if (level === 'divine') {
    const like = `%${q}%`;
    return db.prepare("SELECT id, title, body FROM notices WHERE visibility = 'public' AND (title LIKE ? OR body LIKE ?) ORDER BY id").all(like, like);
  }
  if (level === 'inquisitor') {
    const sql = "SELECT id, title, body, visibility FROM notices WHERE visibility = 'public' AND (title LIKE '%" + q + "%' OR body LIKE '%" + q + "%') ORDER BY id";
    try {
      return db.prepare(sql).all();
    } catch {
      return []; // a malformed injection just yields no rows, like a real app swallowing a query error
    }
  }
  const term = level === 'templar' ? q.replace(/union|select/gi, '') : q;
  const sql = "SELECT id, title, body FROM notices WHERE visibility = 'public' AND (title LIKE '%" + term + "%' OR body LIKE '%" + term + "%') ORDER BY id";
  try {
    return db.prepare(sql).all();
  } catch {
    return []; // a malformed injection just yields no rows, like a real app swallowing a query error
  }
}
