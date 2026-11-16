import type { ChallengeDb } from '../../../../core/challenge-db.js';
import { firstRows } from '../../_shared/sql.js';
import { MAX_ROWS, type Row } from '../model.js';

// INQUISITOR — real defense, subtly wrong: the search term is bound, and the max price is "validated" as a number.
// But parseInt reads the leading digits and ignores the rest, so the check proves the input STARTS with a number,
// and the raw string is still what gets concatenated into the SQL.
export function search(db: ChallengeDb, q: string, max: string): Row[] | string {
  if (Number.isNaN(Number.parseInt(max, 10))) return 'Max price must be a number.';
  return firstRows(db.prepare(
    `SELECT name, category, price_cents, description FROM products WHERE hidden = 0 AND name LIKE ? AND price_cents / 100 <= ${max} ORDER BY name`,
  ), MAX_ROWS, `%${q}%`);
}
