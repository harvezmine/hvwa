// model.ts — GK-15's lab state and the contract every levels/<level>.ts implements.
// Not served: View Source shows only levels/*.ts, and nothing here has a route.
import { randomInt } from 'node:crypto';
import { perSession } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';

export interface Account { username: string; password: string; role: 'admin' | 'user' }

/** Failed code attempts kept on the server (levels that count server-side). */
export interface Counter { failures: number; lockedUntil: number }

/** One player's lab at one level. */
export interface LabState {
  /** The live 4-digit code ('' when none is outstanding). */
  otp: string;
  /** When the live code was issued (ms). */
  issuedAt: number;
  /** Who passed the password step and now owes a code; null when nobody does. */
  pending: string | null;
  /** Resends since the last sign-in. */
  resends: number;
  /** Server-side failure counters, keyed by username. */
  readonly counters: Map<string, Counter>;
  /** The clock (ms); a test seam so expiry and lockouts can be checked without waiting. */
  now: () => number;
}

/** Cookies the request carried (untrusted). */
export type Cookies = Readonly<Record<string, unknown>>;

/** A level's answer. `cookies` are written to the response (levels that keep state on the client). */
export interface Reply { ok: boolean; message: string; cookies?: Readonly<Record<string, string>> }

/** What every levels/<level>.ts exports (checked by byLevel<OtpLevel> in challenge.ts). */
export interface OtpLevel {
  /** Right after the password step succeeded, before a code is issued. ok=false refuses the sign-in. */
  gate(state: LabState, username: string): Reply;
  /** Check a submitted code. ok=true means the pending user is through. */
  verify(state: LabState, code: string, cookies: Cookies): Reply;
  /** "Resend code". ok=false refuses. */
  resend(state: LabState, cookies: Cookies): Reply;
}

/** The player's own (unprivileged) account; its codes appear in the on-page inbox. */
export const PLAYER = Object.freeze({ username: 'pilgrim', password: 'pilgrim' });
export const ADMIN_NAME = 'citadel_admin';
/** The admin's password, "phished" and shown on the lab page: the code step is the whole challenge. */
export const ADMIN_PASSWORD = 'Citadel-Gate-Open';

export const ACCOUNTS: readonly Account[] = Object.freeze([
  Object.freeze({ username: ADMIN_NAME, password: ADMIN_PASSWORD, role: 'admin' as const }),
  Object.freeze({ username: PLAYER.username, password: PLAYER.password, role: 'user' as const }),
]);

/** A fresh random 4-digit code, as a zero-padded string. */
export function newCode(): string {
  return String(randomInt(10_000)).padStart(4, '0');
}

/** Sign `username` in to the code step with a brand new code. */
export function issueCode(state: LabState, username: string): void {
  state.pending = username;
  state.otp = newCode();
  state.issuedAt = state.now();
  state.resends = 0;
}

/** Replace the live code with a new one. */
export function rotateCode(state: LabState): void {
  state.otp = newCode();
  state.issuedAt = state.now();
}

// Per player AND per level: the live code, the counters and the lockouts are state a player
// changes, so they must never cross players or levels.
const labs = perSession((): LabState => ({
  otp: '', issuedAt: 0, pending: null, resends: 0, counters: new Map(), now: Date.now,
}));

/** The lab state for this request's session at the served level. */
export function labFor(req: { sessionId: string; level: Level }): LabState {
  return labs.for(req);
}

/** Test seam: the lab state of session `sessionId` at `level` (the live code is `.otp`). */
export function labState(sessionId: string, level: Level): LabState {
  return labs.for({ sessionId, level });
}
