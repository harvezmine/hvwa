import type { ChallengeDb } from '../../../../core/challenge-db.js';
import type { UserRow } from '../model.js';

// TEMPLAR — naive filter: quotes are stripped from the username only.
// The password is still concatenated into the query.
export function findUser(db: ChallengeDb, username: string, password: string): UserRow | undefined {
  const safeUsername = username.replace(/'/g, '');
  return db.prepare(
    `SELECT username, role FROM users WHERE username = '${safeUsername}' AND password = '${password}'`,
  ).get() as UserRow | undefined;
}
