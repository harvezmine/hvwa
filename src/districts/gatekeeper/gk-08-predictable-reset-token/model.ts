// model.ts — GK-08's lab state and the contract every levels/<level>.ts implements.
// Not served: View Source shows only levels/*.ts, and nothing here has a route.
import { randomBytes } from 'node:crypto';
import { perSession } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import { ADMIN_NAME, PLAYER } from '../_shared/lab.js';

export const ADMIN_EMAIL = 'citadel_admin@citadel.test';
export const PLAYER_EMAIL = 'pilgrim@citadel.test';

/** A citadel account. Its password is what a reset changes. */
export interface Member {
  readonly username: string;
  readonly email: string;
  password: string;
  readonly role: 'admin' | 'user';
}

/** What a level remembers about one outstanding reset link (keyed by whatever the level chooses: the token, or its hash). */
export interface ResetRecord {
  /** The account the link was sent for. */
  readonly email: string;
  /** When it stops working (ms); undefined: never. */
  readonly expiresAt?: number;
}

/** One reset mail in the player's mailbox. */
export interface Mail { readonly at: number; readonly subject: string; readonly body: string; readonly link: string }

/** One player's lab at one level. */
export interface LabState {
  /** The admin first, then the player. */
  readonly members: readonly Member[];
  /** Outstanding reset links, oldest first, as the level stores them. Bounded (remember()). */
  readonly resets: Map<string, ResetRecord>;
  /** The player's mailbox (pilgrim@citadel.test), newest first. Bounded. The admin's mail is never kept or shown. */
  readonly mailbox: Mail[];
  /** The clock (ms); a test seam for the date in Templar's token and Divine's expiry. */
  now: () => number;
}

/** A reset form submission. */
export interface ResetForm { readonly token: string; readonly email: string }

/** What every levels/<level>.ts exports (checked by byLevel<ResetLevel> in challenge.ts). */
export interface ResetLevel {
  /** Make the reset token for `member`'s link and remember it (remember()). Returns the token for the link. */
  issue(state: LabState, member: Member, nowMs: number): string;
  /** The account a reset form may change, or undefined to refuse it. A used token is forgotten here. */
  redeem(state: LabState, form: ResetForm, nowMs: number): Member | undefined;
  /** Whether the reset link and form carry the account's address (only the form's field, never the token, says whose). */
  readonly formHasEmail: boolean;
}

/** Outstanding links kept per lab; the oldest goes first. */
export const MAX_RESETS = 20;
const MAX_MAILS = 10;

/** An address as the forms compare it: trimmed, lower case. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The account with this address, or undefined. Only the two real accounts exist: nothing is keyed by input. */
export function memberByEmail(state: LabState, email: string): Member | undefined {
  const wanted = normalizeEmail(email);
  return state.members.find((m) => m.email === wanted);
}

/** Store an outstanding link under `key`, newest last; beyond MAX_RESETS the oldest is forgotten. */
export function remember(state: LabState, key: string, record: ResetRecord): void {
  state.resets.delete(key);
  state.resets.set(key, record);
  while (state.resets.size > MAX_RESETS) state.resets.delete(state.resets.keys().next().value as string);
}

/** Deliver a reset mail to the player's mailbox (newest first, bounded). */
export function deliverToPlayer(state: LabState, mail: Mail): void {
  state.mailbox.unshift(mail);
  if (state.mailbox.length > MAX_MAILS) state.mailbox.length = MAX_MAILS;
}

// Per player AND per level: passwords change and links are used up, so nothing may cross players or levels.
const labs = perSession((): LabState => ({
  members: [
    { username: ADMIN_NAME, email: ADMIN_EMAIL, password: randomBytes(16).toString('hex'), role: 'admin' },
    { username: PLAYER.username, email: PLAYER_EMAIL, password: PLAYER.password, role: 'user' },
  ],
  resets: new Map(),
  mailbox: [],
  now: Date.now,
}));

/** The lab state for this request's session at the served level. */
export function labFor(req: { sessionId: string; level: Level }): LabState {
  return labs.for(req);
}

/** Test seam: the lab state of session `sessionId` at `level` (`.members[0].password` is the admin's). */
export function labState(sessionId: string, level: Level): LabState {
  return labs.for({ sessionId, level });
}
