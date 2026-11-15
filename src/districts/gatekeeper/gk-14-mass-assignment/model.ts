// model.ts — GK-14's user record, per-player state, the contract every levels/<level>.ts implements and the
// platform-safety helpers the levels share. Not served: View Source shows only levels/*.ts.
import { perSession } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import { PLAYER, type Result } from '../_shared/lab.js';

/** The player's account record. Levels decide which request fields may reach it. */
export interface User {
  displayName: string;
  bio: string;
  email: string;
  /** An email change waiting for verification (Divine only). */
  pendingEmail: string | null;
  role: string;
  [field: string]: unknown;
}

export interface LabState { signedIn: boolean; user: User }

const newUser = (): User => ({
  displayName: 'Pilgrim', bio: 'Newly arrived at the citadel.', email: 'pilgrim@citadel.example', pendingEmail: null, role: 'user',
});
const labs = perSession((): LabState => ({ signedIn: false, user: newUser() }));
export const labFor = (req: { sessionId: string; level: Level }): LabState => labs.for(req);
/** Test seam: the lab state of session `sessionId` at `level`. */
export const labState = (sessionId: string, level: Level): LabState => labs.for({ sessionId, level });

/** What every levels/<level>.ts exports (checked by byLevel<ProfileLevel> in challenge.ts). */
export interface ProfileLevel {
  /** Apply a profile update request body to the record and say what happened. */
  applyUpdate(user: User, body: unknown): Result;
}

// ---- Platform safety, not the lesson: prototype pollution is a different lab and must never reach the process ----

const DANGEROUS = new Set(['__proto__', 'constructor', 'prototype']);
export const isDangerousKey = (k: string): boolean => DANGEROUS.has(k);
export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const MAX_FIELDS_PER_REQUEST = 50;
const MAX_FIELDS_ON_USER = 60;
const MAX_TEXT = 500;

/** The request's entries: plain objects only, at most 50, short safe keys (never __proto__, constructor, prototype). */
export function fieldsOf(body: unknown): [string, unknown][] {
  if (!isPlainObject(body)) return [];
  return Object.keys(body).filter((k) => k.length <= 64 && !isDangerousKey(k)).slice(0, MAX_FIELDS_PER_REQUEST)
    .map((k): [string, unknown] => [k, body[k]]);
}

/** Store one scalar field on the record, bounded (a vulnerable level still cannot grow the record without limit). */
export function setField(user: User, key: string, value: unknown): void {
  if (isDangerousKey(key) || key.length > 64) return;
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return;
  if (!Object.hasOwn(user, key) && Object.keys(user).length >= MAX_FIELDS_ON_USER) return;
  user[key] = typeof value === 'string' ? value.slice(0, MAX_TEXT) : value;
}

export const PLAYER_NAME = PLAYER.username;
