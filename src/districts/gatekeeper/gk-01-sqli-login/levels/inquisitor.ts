import type { ChallengeDb } from '../../../../core/challenge-db.js';
import type { UserRow } from '../challenge.js';

// INQUISITOR — real defense, subtly wrong: fully parameterized, but the password
// is compared with LIKE, so SQL wildcards in the input are not escaped.
export function findUser(db: ChallengeDb, username: string, password: string): UserRow | undefined {
  return db.prepare('SELECT username, role FROM users WHERE username = ? AND password LIKE ?')
    .get(username, password) as UserRow | undefined;
}
