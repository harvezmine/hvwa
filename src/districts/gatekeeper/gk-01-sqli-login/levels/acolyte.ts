import type { ChallengeDb } from '../../../../core/challenge-db.js';
import type { UserRow } from '../challenge.js';

// ACOLYTE — no defense: both fields are concatenated straight into the SQL string.
export function findUser(db: ChallengeDb, username: string, password: string): UserRow | undefined {
  return db.prepare(
    `SELECT username, role FROM users WHERE username = '${username}' AND password = '${password}'`,
  ).get() as UserRow | undefined;
}
