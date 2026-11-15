import type { ChallengeDb } from '../../../../core/challenge-db.js';
import type { UserRow } from '../model.js';

// DIVINE — secure reference: parameterized query with exact comparison.
// (A production system would also store a slow password hash and rate-limit attempts.)
export function findUser(db: ChallengeDb, username: string, password: string): UserRow | undefined {
  return db.prepare('SELECT username, role FROM users WHERE username = ? AND password = ?')
    .get(username, password) as UserRow | undefined;
}
