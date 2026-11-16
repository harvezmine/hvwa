// model.ts — FP-09's private messages, per-player sign-in state and the contract every levels/<level>.ts implements.
// Not served: View Source shows only levels/*.ts.
import { randomUUID } from 'node:crypto';
import { perSession } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import { ADMIN_NAME, ARCHIVIST, PLAYER } from '../_shared/forum.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

export interface Dm { readonly id: string; readonly from: string; readonly to: string; readonly subject: string; readonly body: string }

/** What a level decides about one request for one message. */
export interface Access {
  /** Through which door the message is asked for. */
  readonly channel: 'page' | 'api';
  /** The signed-in user (from the session). */
  readonly viewer: string;
  /** The message's two parties. */
  readonly from: string;
  readonly to: string;
  /** The client-supplied X-User-Id header, if any (never an identity; only a flawed level reads it). */
  readonly claimed: string | undefined;
}

export interface DmLevel {
  /** How message ids look: sequential numbers or UUIDs. */
  readonly idStyle: 'numeric' | 'uuid';
  /** Whether the public activity feed prints each message's ref (its id). */
  readonly feedShowsRefs: boolean;
  /** Whether a refusal is the same answer as a missing message. */
  readonly uniformNotFound: boolean;
  /** An API note shown on the page (what the "mobile app" sends), or ''. */
  readonly apiNote: string;
  /** Headers the API example request carries ("Name: value"). */
  readonly apiHeaders: readonly string[];
  /** May this request read the message? */
  canRead(a: Access): boolean;
}

export const ADMIN_DM_BODY = 'Treasury vault ledger: the seal numbers are kept in the third drawer.';

/** The three messages of one player's lab: the admin's private one (not yours), one you received, one you sent. */
export interface Dms { readonly admin: Dm; readonly received: Dm; readonly sent: Dm }

/** One player's lab at one level: whether they signed in as pilgrim, and the messages (ids drawn per player). */
export interface LabState { signedIn: boolean; readonly dms: Dms }

const ID_STYLE: Readonly<Record<Level, DmLevel['idStyle']>> = {
  acolyte: acolyte.idStyle, templar: templar.idStyle, inquisitor: inquisitor.idStyle, divine: divine.idStyle,
};

// Static per player: no feature adds a message, so nothing here grows. The admin's DM is part of the state itself, so it
// can never be trimmed away.
const labs = perSession((level): LabState => {
  const uuid = ID_STYLE[level] === 'uuid';
  const id = (n: string): string => (uuid ? randomUUID() : n);
  return {
    signedIn: false,
    dms: {
      admin: { id: id('1'), from: ADMIN_NAME, to: ARCHIVIST, subject: 'Vault ledger', body: ADMIN_DM_BODY },
      received: { id: id('2'), from: ARCHIVIST, to: PLAYER.username, subject: 'Lantern duty', body: 'Remember to keep the lantern oil dry.' },
      sent: { id: id('3'), from: PLAYER.username, to: ARCHIVIST, subject: 'Re: Lantern duty', body: 'Understood. I will check the oil at dusk.' },
    },
  };
});
export const labFor = (req: { sessionId: string; level: Level }): LabState => labs.for(req);
/** Test seam: the ids of session `sessionId` at `level`. */
export const idsFor = (sessionId: string, level: Level): { admin: string; received: string; sent: string } => {
  const d = labs.for({ sessionId, level }).dms;
  return { admin: d.admin.id, received: d.received.id, sent: d.sent.id };
};

/** Lookup of a message by the id string from the URL (compared, never used as an object key). */
export function findDm(d: Dms, id: string): Dm | undefined {
  return [d.admin, d.received, d.sent].find((m) => m.id === id);
}
