// model.ts — GK-06's lab state and the contract every levels/<level>.ts implements.
// Not served: View Source shows only levels/*.ts, and nothing here has a route.
import { randomBytes } from 'node:crypto';
import { challengeDb, type ChallengeDb } from '../../../core/challenge-db.js';
import { perSession, type DbResult } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';

export type Claims = Record<string, unknown>;

/** What a level's verify answers: the claims it accepts, or why it refused (shown below Divine only). */
export type Verdict = { readonly ok: true; readonly claims: Claims } | { readonly ok: false; readonly reason: string };

/** Runs ONE synchronous key-store call so a database error is shown the way tryDb shows it (generic at Divine). */
export type Guard = <T>(fn: () => T) => DbResult<T>;

/** The public file served at ./robots.txt and stored at /srv/www/robots.txt in the simulated file system. */
export const ROBOTS_TXT = 'User-agent: *\nDisallow: /vault\nDisallow: /keys/\n';

/** One player's lab at one level. */
export interface LabState {
  /** The HS256 signing key the server uses (random; never the same in two sessions or levels). */
  readonly signingKey: string;
  /** The simulated file system: absolute path to file content. Nothing here is on the real disk. */
  readonly files: ReadonlyMap<string, string>;
  /** The key table (kid, secret), created on first use. */
  db(): ChallengeDb;
  /** The clock (ms): a test seam for `iat`. */
  now: () => number;
}

/** What every levels/<level>.ts exports (checked by byLevel<JwtLevel> in challenge.ts). */
export interface JwtLevel {
  /** The `kid` the genuine server puts into the tokens it issues at this level. */
  readonly kid: string;
  /** Decide whether `token` is acceptable. How the key is found from `kid` is the whole lesson. */
  verify(state: LabState, token: string, guard: Guard): Verdict;
}

/** The lab's token cookie. One name per level: levels share a path and must not overwrite each other. */
export function cookieName(level: Level): string {
  return `citadel_jwt_${level}`;
}

const SCHEMA = 'CREATE TABLE keys (kid TEXT PRIMARY KEY, secret TEXT NOT NULL)';

// Per player AND per level: the signing key, the files and the key table belong to one lab.
const labs = perSession((): LabState => {
  const signingKey = randomBytes(32).toString('hex');
  const files = new Map<string, string>([
    ['/keys/k1.key', signingKey],
    ['/keys/README', 'One file per signing key, named after its key id.\n'],
    ['/dev/null', ''],
    ['/etc/hostname', 'citadel-archive\n'],
    ['/srv/www/robots.txt', ROBOTS_TXT],
  ]);
  let db: ChallengeDb | undefined;
  return {
    signingKey,
    files,
    db: () => (db ??= challengeDb(SCHEMA, (raw) => {
      const ins = raw.prepare('INSERT INTO keys (kid, secret) VALUES (?, ?)');
      ins.run('k1', signingKey);
      ins.run('k0', randomBytes(32).toString('hex')); // a retired key nobody can use any more
    })),
    now: Date.now,
  };
});

export function labFor(req: { sessionId: string; level: Level }): LabState {
  return labs.for(req);
}

/** Test seam: the lab state of session `sessionId` at `level`. */
export function labState(sessionId: string, level: Level): LabState {
  return labs.for({ sessionId, level });
}
