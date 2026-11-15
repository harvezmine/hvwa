// model.ts — GK-12's records, per-player sign-in state and the contract every levels/<level>.ts implements.
// Not served: View Source shows only levels/*.ts.
import { randomUUID } from 'node:crypto';
import { perSession } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import { ADMIN_NAME, PLAYER } from '../_shared/lab.js';

export interface Profile { readonly id: string; readonly username: string; readonly note: string }

/** What a level decides about one request for one record. */
export interface Access {
  /** Through which door the record is asked for. */
  readonly channel: 'page' | 'api';
  /** The signed-in user's id (from the session). */
  readonly viewerId: string;
  /** The record's owner. */
  readonly ownerId: string;
  /** The client-supplied X-User-Id header, if any (never an identity; only a flawed level reads it). */
  readonly claimedId: string | undefined;
}

export interface RecordsLevel {
  /** How record ids look: sequential numbers or UUIDs. */
  readonly idStyle: 'numeric' | 'uuid';
  /** Whether the public team directory prints the ids. */
  readonly directoryShowsIds: boolean;
  /** Whether a refusal is the same answer as a missing record. */
  readonly uniformNotFound: boolean;
  /** May this request read the record? */
  canRead(a: Access): boolean;
}

export const ADMIN_NOTE = 'Treasury vault ledger: the seal numbers are kept in the third drawer.';
export const PLAYER_NOTE = 'Remember to keep the lantern oil dry.';

/** Both records at `level`, built once per level (at most 4 entries); the level module picks the id style. */
export interface Records { readonly admin: Profile; readonly pilgrim: Profile }
const made = new Map<Level, Records>();
export function recordsFor(level: Level, style: RecordsLevel['idStyle']): Records {
  let r = made.get(level);
  if (r === undefined) {
    const uuid = style === 'uuid';
    r = {
      admin: { id: uuid ? randomUUID() : '1', username: ADMIN_NAME, note: ADMIN_NOTE },
      pilgrim: { id: uuid ? randomUUID() : '2', username: PLAYER.username, note: PLAYER_NOTE },
    };
    made.set(level, r);
  }
  return r;
}
/** Test seam: the ids at a level (the style is read from the level module the lab serves). */
export const idsFor = (level: Level): { admin: string; pilgrim: string } => {
  const r = made.get(level);
  if (r === undefined) throw new Error(`idsFor: ${level} not started yet`);
  return { admin: r.admin.id, pilgrim: r.pilgrim.id };
};

/** One player's lab at one level: whether they signed in as pilgrim. */
export interface LabState { signedIn: boolean }
const labs = perSession((): LabState => ({ signedIn: false }));
export const labFor = (req: { sessionId: string; level: Level }): LabState => labs.for(req);

/** Lookup of a record by the id string from the URL (compared, never used as an object key). */
export function findProfile(r: Records, id: string): Profile | undefined {
  return id === r.admin.id ? r.admin : id === r.pilgrim.id ? r.pilgrim : undefined;
}
