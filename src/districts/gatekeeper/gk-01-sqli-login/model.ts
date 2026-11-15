// model.ts — GK-01's data and the contract every levels/<level>.ts implements.
// Not served: View Source shows only levels/*.ts, and nothing here has a route.
import { randomBytes } from 'node:crypto';
import { challengeDb, type ChallengeDb } from '../../../core/challenge-db.js';
import { perLevel } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';

export interface UserRow { username: string; role: string }

/** What every levels/<level>.ts exports (checked by byLevel<LoginLevel> in challenge.ts). */
export interface LoginLevel {
  findUser(db: ChallengeDb, username: string, password: string): UserRow | undefined;
}

/** The player's own (unprivileged) account, shown on the lab page. */
export const PLAYER = Object.freeze({ username: 'pilgrim', password: 'pilgrim' });

const SCHEMA = `CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL, role TEXT NOT NULL)`;

// One users DB per level, each with its own random admin password: a password
// extracted by SQLi at Acolyte must not log in at Templar, Inquisitor or Divine.
// Random so that guessing it is never the solve.
const users = perLevel(() => {
  const adminPassword = randomBytes(16).toString('hex');
  const db = challengeDb(SCHEMA, (raw) => {
    const ins = raw.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)');
    ins.run('citadel_admin', adminPassword, 'admin');
    ins.run(PLAYER.username, PLAYER.password, 'user');
  });
  return { db, adminPassword };
});

/** The users DB serving `level`. */
export function usersDb(level: Level): ChallengeDb {
  return users.for(level).db;
}

/** Test seam: the real citadel_admin password at `level`. */
export function adminPassword(level: Level): string {
  return users.for(level).adminPassword;
}
