import type { ChallengeDb } from '../../../../core/challenge-db.js';
import { firstRows } from '../../_shared/sql.js';
import { MAX_ROWS, type Row } from '../model.js';

// DIVINE — secure reference: the stored name is trusted nowhere. Names are validated on input (3-24 letters, digits and
// underscores), every query that uses a name binds it as a parameter, and no identifier is ever built from data: the
// report's column label is a fixed word (an allowlist of one), the name appears on the page only as escaped text.
// Validation is defence in depth: the queries stay safe even for a name that got past it. Errors: if a query ever fails,
// the route (tryDb) shows Divine players only a generic "Invalid request.", never the database message (CWE-209).
// Out of scope here: sign-in credentials, rate limiting registrations, and moderating names.
const NAME_RE = /^[A-Za-z0-9_]{3,24}$/;

export function checkName(username: string): string | undefined {
  return NAME_RE.test(username) ? undefined : 'Usernames are 3-24 letters, digits or underscores.';
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
  return firstRows(db.prepare('SELECT COUNT(*) AS actions FROM activity WHERE member = ?'), MAX_ROWS + 1, username);
}
