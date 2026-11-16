// model.ts — FP-10's database, per-player state and the contract every levels/<level>.ts implements.
// Not served: View Source shows only levels/*.ts, and nothing here takes attacker input into SQL except through the level.
import { randomBytes } from 'node:crypto';
import { challengeDb, type ChallengeDb } from '../../../core/challenge-db.js';
import { perSession } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import { ADMIN_NAME, ARCHIVIST, PLAYER } from '../_shared/forum.js';

/** A result row as the database returns it. */
export type Row = Record<string, unknown>;

/** The longest username the forum stores (platform bound, every level). */
export const MAX_NAME = 64;
/** At most this many rows of a result are shown, and at most this many columns of a row (rule (g): cap what is read). */
export const MAX_ROWS = 20;
export const MAX_COLUMNS = 8;
/** The tables stay small however many names a player registers: members and activity are trimmed after each registration. */
const MEMBER_CAP = 50;
const ACTIVITY_CAP = 100;
/** The seeded members (ids 1..3) and their seeded activity rows are never trimmed. */
const SEEDED_MEMBERS = 3;
const SEEDED_ACTIVITY = 6;

/** What every levels/<level>.ts exports (checked by byLevel<SqliLevel> in challenge.ts). */
export interface SqliLevel {
  /** Registration: a message when this name is refused before anything is stored, or undefined. */
  checkName(username: string): string | undefined;
  /** Registration: store the member, parameterized at EVERY level. The new member's id, or undefined when the name is taken. */
  register(db: ChallengeDb, username: string, at: number): number | undefined;
  /** The SECOND use of the stored name, the activity page: its rows (at most MAX_ROWS + 1 are read). */
  activity(db: ChallengeDb, username: string): Row[];
  /** The SECOND use of the stored name, the report page: its rows (at most MAX_ROWS + 1 are read). */
  report(db: ChallengeDb, username: string): Row[];
}

const SCHEMA = `
CREATE TABLE members (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL);
CREATE TABLE activity (id INTEGER PRIMARY KEY, member TEXT NOT NULL, action TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE vault (id INTEGER PRIMARY KEY, label TEXT NOT NULL, secret TEXT NOT NULL);
`;

/** One player's lab at one level: the database, the vault's canary, and who they registered as (a member id). */
export interface LabState { readonly db: ChallengeDb; readonly canary: string; current: number | undefined }

/**
 * Per player AND per level: the registered names and the vault are mutated by play, and a canary read at one level must
 * not open another. Each state is a small in-memory SQLite database (about 140 KiB of process memory with the tables
 * filled to their caps, measured as RSS growth over 300 of them), so 300 entries are about 42 MB, where the default
 * 5000 would be about 700 MB against the container's 512 MB. Eviction is a reset (register again): nothing here is a
 * limiter.
 */
const labs = perSession((): LabState => {
  const canary = randomBytes(16).toString('hex');
  const db = challengeDb(SCHEMA, (raw) => {
    const member = raw.prepare('INSERT INTO members (username) VALUES (?)');
    for (const name of [ADMIN_NAME, PLAYER.username, ARCHIVIST]) member.run(name);
    const act = raw.prepare('INSERT INTO activity (member, action, at) VALUES (?, ?, ?)');
    act.run(ADMIN_NAME, 'posted "Welcome to the Forum of Pilgrims"', 1);
    act.run(ADMIN_NAME, 'pinned a thread', 2);
    act.run(PLAYER.username, 'posted "Where do the lanterns come from?"', 3);
    act.run(PLAYER.username, 'replied to a thread', 4);
    act.run(ARCHIVIST, 'posted "Reading the old scrolls"', 5);
    act.run(ARCHIVIST, 'edited a post', 6);
    raw.prepare('INSERT INTO vault (label, secret) VALUES (?, ?)').run('treasury seal', canary);
  });
  return { db, canary, current: undefined };
}, { maxEntries: 300 });

export const labFor = (req: { sessionId: string; level: Level }): LabState => labs.for(req);
/** Test seam: the vault's canary of session `sessionId` at `level`. */
export const canaryFor = (sessionId: string, level: Level): string => labs.for({ sessionId, level }).canary;
/**
 * Test seam: make `username` this player's stored name WITHOUT registration's checks (what a name that got past a
 * validation would be), to prove a level's second uses never trust it.
 */
export function forceName(sessionId: string, level: Level, username: string): void {
  const s = labs.for({ sessionId, level });
  s.db.prepare('INSERT OR IGNORE INTO members (username) VALUES (?)').run(username);
  const row = s.db.prepare('SELECT id FROM members WHERE username = ?').get(username) as { id: number };
  s.current = row.id;
}

/** The registered name, READ BACK from the database: this is the stored data that the second use then trusts. */
export function storedName(state: LabState): string | undefined {
  if (state.current === undefined) return undefined;
  const row = state.db.prepare('SELECT username FROM members WHERE id = ?').get(state.current) as { username: string } | undefined;
  return row?.username;
}

/** Keep the tables bounded: drop the oldest registrations beyond the caps (static SQL, no input). */
export function trimTables(db: ChallengeDb): void {
  db.prepare(`DELETE FROM members WHERE id > ${SEEDED_MEMBERS} AND id NOT IN (SELECT id FROM members ORDER BY id DESC LIMIT ${MEMBER_CAP})`).run();
  db.prepare(`DELETE FROM activity WHERE id > ${SEEDED_ACTIVITY} AND id NOT IN (SELECT id FROM activity ORDER BY id DESC LIMIT ${ACTIVITY_CAP})`).run();
}
