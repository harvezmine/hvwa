import type { ChallengeDb } from '../../../../core/challenge-db.js';
import { firstRows } from '../../_shared/sql.js';
import { MAX_ROWS, type Row } from '../model.js';

// ACOLYTE — registration is SAFE: the name is bound as a parameter, so a quote in it is just data and a direct injection
// at the sign-up form goes nowhere. But the name is now STORED, and the activity page trusts what it stored: it builds its
// query by concatenating the name read back from the database. A name like  x' UNION SELECT ...  fires on the second use.
export function checkName(_username: string): string | undefined {
  return undefined;
}

export function register(db: ChallengeDb, username: string, at: number): number | undefined {
  const made = db.prepare('INSERT OR IGNORE INTO members (username) VALUES (?)').run(username);
  if (made.changes === 0) return undefined;
  db.prepare("INSERT INTO activity (member, action, at) VALUES (?, 'registered', ?)").run(username, at);
  return Number(made.lastInsertRowid);
}

export function activity(db: ChallengeDb, username: string): Row[] {
  return firstRows(db.prepare(`SELECT action, at FROM activity WHERE member = '${username}' ORDER BY id DESC`), MAX_ROWS + 1);
}

export function report(db: ChallengeDb, username: string): Row[] {
  return firstRows(db.prepare('SELECT COUNT(*) AS actions FROM activity WHERE member = ?'), MAX_ROWS + 1, username);
}
