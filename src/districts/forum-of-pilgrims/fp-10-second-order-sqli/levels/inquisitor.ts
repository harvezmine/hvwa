import type { ChallengeDb } from '../../../../core/challenge-db.js';
import { firstRows } from '../../../_shared/sql.js';
import { MAX_ROWS, type Row } from '../model.js';

// INQUISITOR — the lesson from Acolyte was learned: registration binds the name, and so does the activity query. But a
// bound parameter can only be a VALUE, never a name, and the report page labels its one column with the member's handle
// ("<your name>: 7 actions"). An identifier cannot be a parameter, so the stored name is quoted by hand into the SQL
// text, and a double quote inside it closes that quoting and carries the rest of the name into the query.
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
  return firstRows(db.prepare('SELECT action, at FROM activity WHERE member = ? ORDER BY id DESC'), MAX_ROWS + 1, username);
}

export function report(db: ChallengeDb, username: string): Row[] {
  return firstRows(db.prepare(`SELECT COUNT(*) AS "${username}" FROM activity WHERE member = ?`), MAX_ROWS + 1, username);
}
