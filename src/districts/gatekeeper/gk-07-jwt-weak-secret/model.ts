// model.ts — GK-07's lab state and the contract every levels/<level>.ts implements.
// Not served: View Source shows only levels/*.ts, and nothing here has a route.
import { fixtureLines, perSession, byLevel } from '../../../core/lab.js';
import type { Level } from '../../../core/levels.js';
import { signHmac } from '../_shared/jwt.js';
import * as acolyte from './levels/acolyte.js';
import * as templar from './levels/templar.js';
import * as inquisitor from './levels/inquisitor.js';
import * as divine from './levels/divine.js';

export type Claims = Record<string, unknown>;

/** What a level's verify answers: the claims it accepts, or why it refused (shown below Divine only). */
export type Verdict = { readonly ok: true; readonly claims: Claims } | { readonly ok: false; readonly reason: string };

/** The HMAC secrets one lab runs on. How they are chosen is the lesson, so each level makes its own. */
export interface Keys {
  /** The current signing secret. */
  readonly secret: string;
  /** A retired key that is still (wrongly) accepted, if the level has one. */
  readonly legacySecret?: string;
}

/** One player's lab at one level. */
export interface LabState extends Keys {
  /** A token issued earlier to `pilgrim`, shown on the page (the cracking target). */
  readonly sample: string;
  /** A token of the retired key (kid 2024), quoted in the release notes; only when a legacy key exists. */
  readonly legacyToken?: string;
  /** The clock (ms): a test seam for `iat`. */
  now: () => number;
}

/** What every levels/<level>.ts exports (checked by byLevel<JwtLevel> in this file). */
export interface JwtLevel {
  /** The `kid` the genuine server puts into the tokens it issues, if any. */
  readonly kid: string | undefined;
  /** The `kid` of the retired key, if the level still honours one. */
  readonly legacyKid?: string;
  /** Choose this lab's secret(s). `words` is the wordlist the lab publishes. */
  createKeys(words: readonly string[]): Keys;
  /** Decide whether `token` is acceptable. */
  verify(state: LabState, token: string): Verdict;
}

export const impl = byLevel<JwtLevel>({ acolyte, templar, inquisitor, divine });

/** The wordlist the lab publishes at ./wordlist.txt (and the weak secrets are drawn from). */
export const wordlist = fixtureLines(new URL('./fixtures/wordlist.txt', import.meta.url));

/** The lab's token cookie. One name per level: levels share a path and must not overwrite each other. */
export function cookieName(level: Level): string {
  return `citadel_jwt_${level}`;
}

const sign = (secret: string, claims: Claims, kid: string | undefined, iatMs: number) =>
  signHmac('HS256', secret, { ...claims, iat: Math.floor(iatMs / 1000) }, kid === undefined ? {} : { kid });

// Per player AND per level: the secrets belong to one lab.
const labs = perSession((level): LabState => {
  const lv = impl.for(level);
  const keys = lv.createKeys(wordlist());
  const now = Date.now;
  const user = { sub: 'pilgrim', role: 'user' };
  return {
    ...keys,
    sample: sign(keys.secret, user, lv.kid, now()),
    legacyToken: keys.legacySecret === undefined ? undefined : sign(keys.legacySecret, user, lv.legacyKid, Date.UTC(2024, 5, 1)),
    now,
  };
});

export function labFor(req: { sessionId: string; level: Level }): LabState {
  return labs.for(req);
}

/** Sign claims the way the genuine server does: HS256 with the current secret (and kid, where the level has one). */
export function issueToken(level: Level, state: LabState, claims: Claims): string {
  return sign(state.secret, claims, impl.for(level).kid, state.now());
}

/** Test seam: the lab state (secrets included) of session `sessionId` at `level`. */
export function labState(sessionId: string, level: Level): LabState {
  return labs.for({ sessionId, level });
}

/** Test seam: a genuine token (signed by the real current key) for any claims. */
export function mintToken(sessionId: string, level: Level, claims: Claims): string {
  return issueToken(level, labState(sessionId, level), claims);
}
