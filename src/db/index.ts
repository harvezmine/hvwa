import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));

/**
 * Open the PLATFORM database. `path` is required (':memory:' for tests).
 * File databases get a 5 s busy timeout and WAL journaling.
 */
export function openDb(path: string): DatabaseSync {
  if (!path) throw new Error('openDb: a database path is required');
  if (path === ':memory:') return new DatabaseSync(path);
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec('PRAGMA journal_mode=WAL');
  return db;
}

export type Migration = (db: DatabaseSync) => void;

// Ordered schema steps. Step N brings the database to user_version N.
// NEVER edit or reorder a released step: append a new one instead.
export const MIGRATIONS: readonly Migration[] = Object.freeze([
  // 1: platform schema (solves, hint_unlocks, events)
  (db: DatabaseSync) => db.exec(readFileSync(join(here, 'schema.sql'), 'utf8')),
  // 2: the platform login (auth_accounts, auth_tokens; src/auth). Created whether or not auth is on.
  (db: DatabaseSync) => db.exec(readFileSync(join(here, 'auth.sql'), 'utf8')),
]);

export const SCHEMA_VERSION = MIGRATIONS.length;

function userVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

function assertNotNewer(version: number, known: number): void {
  if (version > known) {
    throw new Error(
      `database is newer than this build (user_version ${version}, this build knows ${known}); ` +
      'upgrade HVWA or use a fresh data directory');
  }
}

// Apply every step above the stored PRAGMA user_version in one transaction,
// then record the new version. All-or-nothing: a failing step rolls back
// every pending step and leaves the version unchanged.
export function migrate(db: DatabaseSync, steps: readonly Migration[] = MIGRATIONS): void {
  const stored = userVersion(db);
  assertNotNewer(stored, steps.length);
  if (stored === steps.length) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const from = userVersion(db); // re-read under the write lock
    assertNotNewer(from, steps.length);
    for (let v = from; v < steps.length; v++) steps[v](db);
    db.exec(`PRAGMA user_version = ${steps.length}`);
    db.exec('COMMIT');
  } catch (err) {
    // Only roll back if the transaction is still open, so the original
    // error (not "no transaction is active") is what surfaces.
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}
