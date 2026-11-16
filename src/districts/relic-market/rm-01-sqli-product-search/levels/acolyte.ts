import type { ChallengeDb } from '../../../../core/challenge-db.js';
import { firstRows } from '../../_shared/sql.js';
import { MAX_ROWS, type Row } from '../model.js';

// ACOLYTE — no defense: both fields are concatenated straight into the SQL string.
export function search(db: ChallengeDb, q: string, max: string): Row[] {
  return firstRows(db.prepare(
    `SELECT name, category, price_cents, description FROM products WHERE hidden = 0 AND name LIKE '%${q}%' AND price_cents / 100 <= ${max} ORDER BY name`,
  ), MAX_ROWS);
}
