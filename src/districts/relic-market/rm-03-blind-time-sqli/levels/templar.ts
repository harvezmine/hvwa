import type { ChallengeDb } from '../../../../core/challenge-db.js';

// TEMPLAR — naive filter: input containing a space is refused. A space is one of several characters that separate SQL
// words: a block comment, a tab or a newline do the same job. The Acolyte SQL follows.
export function lookup(db: ChallengeDb, orderNo: string): void | string {
  if (orderNo.includes(' ')) return 'Invalid order number.';
  db.prepare(`SELECT status FROM orders WHERE order_no = '${orderNo}'`).get();
}
