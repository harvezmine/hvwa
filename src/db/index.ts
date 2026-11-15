import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
export function openDb(path = 'hvwa.db'): DatabaseSync { return new DatabaseSync(path); }
export function migrate(db: DatabaseSync): void {
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
}
