import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));

export function openDb(path = 'hvwa.db'): DatabaseSync { return new DatabaseSync(path); }

export type Migration = (db: DatabaseSync) => void;

// Ordered schema steps. Step N brings the database to user_version N.
// NEVER edit or reorder a shipped step: append a new one instead.
export const MIGRATIONS: readonly Migration[] = [
  // 1: initial schema (users, solves with points, hint_unlocks, events)
  (db) => db.exec(readFileSync(join(here, 'schema.sql'), 'utf8')),
];

export const SCHEMA_VERSION = MIGRATIONS.length;

function userVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

// Apply every step above the stored PRAGMA user_version in one transaction,
// then record the new version. All-or-nothing: a failing step rolls back
// every pending step and leaves the version unchanged.
export function migrate(db: DatabaseSync, steps: readonly Migration[] = MIGRATIONS): void {
  if (userVersion(db) >= steps.length) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const from = userVersion(db); // re-read under the write lock
    for (let v = from; v < steps.length; v++) steps[v](db);
    db.exec(`PRAGMA user_version = ${Math.max(from, steps.length)}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
