import type { ChallengeDb } from '../../../../core/challenge-db.js';
import { firstRows } from '../../../_shared/sql.js';
import { MAX_ROWS, type Row } from '../model.js';

// TEMPLAR — naive filter: the keywords UNION and SELECT are removed from both fields, once. The removal is not
// repeated, so what the removal leaves behind can form a keyword again. The Acolyte SQL follows.
const strip = (x: string): string => x.replace(/union|select/gi, '');

export function search(db: ChallengeDb, q: string, max: string): Row[] {
  return firstRows(db.prepare(
    `SELECT name, category, price_cents, description FROM products WHERE hidden = 0 AND name LIKE '%${strip(q)}%' AND price_cents / 100 <= ${strip(max)} ORDER BY name`,
  ), MAX_ROWS);
}
