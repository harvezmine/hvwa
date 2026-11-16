// What a victim-driven lab keeps of its OWN (its bounded maps of sessions, codes, returns, flows...) is weighed in the
// shared byte budget by what the lab declares (declareLabWeight in core/lab.ts), next to its world and browser, which
// core/sim declares. Here each lab's state is filled to every cap with its longest values, through the lab's own
// functions where a player could make them long, and each declaration must stay at or above the measurement (with a
// full GC). Plus: every built-in weight stays small next to the budget.
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { CAPPED_BUDGET_BYTES, cappedBudgetUsage } from '../src/core/lab.js';
import type { Level } from '../src/core/levels.js';
import { SIM_LIMITS } from '../src/core/sim.js';
import { SIMFS_LIMITS } from '../src/core/simfs.js';
import { newVerifier } from '../src/districts/gatekeeper/_shared/oauth.js';
import * as gk10 from '../src/districts/gatekeeper/gk-10-oauth-redirect-uri/model.js';
import * as gk11 from '../src/districts/gatekeeper/gk-11-oauth-missing-state/model.js';
import * as gk16 from '../src/districts/gatekeeper/gk-16-session-fixation/model.js';

const KiB = 1024;
const hex = () => randomBytes(16).toString('hex'); // the labs' own ids (32 hex)
/** As long as a player can make it, two-byte (each lab clips stored URLs one past SIM_LIMITS.urlLength). */
const long = (tag: string) => `http://attacker.test/${tag}/`.padEnd(16_000, '✓');
let sid = 0;

/** Retained bytes per instance of `fill` over fresh lab states, measured with a full GC. */
function measure<S>(make: () => S, fill: (s: S, i: number) => void): number {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') throw new Error('globalThis.gc is missing: run the specs with --expose-gc (vitest.config.ts)');
  const states = Array.from({ length: 6 }, make);
  gc(); gc();
  const before = process.memoryUsage();
  states.forEach(fill);
  gc(); gc();
  const after = process.memoryUsage();
  return ((after.heapUsed - before.heapUsed) + (after.arrayBuffers - before.arrayBuffers)) / states.length;
}

describe('each victim-driven lab declares what its own maps can hold, at or above the measured worst case', () => {
  it('GK-10: returns, codes, both session maps and the pending sign-ins, each at its cap of 50', () => {
    const level: Level = 'acolyte'; // Acolyte lets any redirect_uri through, so codes carry the longest values
    const measured = measure(() => gk10.labState(`w10-${++sid}`, level), (state) => {
      const idp = { level, base: '', cookies: { [gk10.pidCookie(level)]: state.adminPid } };
      for (let i = 0; i < 50; i++) {
        gk10.startLogin({ level, base: '', cookies: {}, query: new URLSearchParams({ next: long(`n${i}`) }) }, state);
        gk10.authorize({ ...idp, query: new URLSearchParams({
          response_type: 'code', client_id: 'citadel', redirect_uri: long(`r${i}`), code_challenge: long(`c${i}`), code_challenge_method: 'S256',
        }) }, state);
        gk10.idpSignIn({ level, base: '', cookies: {}, query: new URLSearchParams() }, state, 'pilgrim', 'pilgrim');
        state.clientSessions.set(hex(), 'citadel_admin'); // server-made ids and fixed names
        state.logins.set(hex(), { state: hex(), verifier: newVerifier() }); // the PKCE levels' pending sign-ins
      }
      expect([state.returns.size, state.codes.size, state.idpSessions.size]).toEqual([50, 50, 50]);
    });
    expect(measured, `GK-10 measured ${(measured / KiB).toFixed(1)} KiB`).toBeLessThan(gk10.STATE_WEIGHT ?? 0);
  });

  it('GK-11: codes (a player-sized code_challenge), flows and both session maps, each at its cap of 50', () => {
    const level: Level = 'acolyte';
    const measured = measure(() => gk11.labState(`w11-${++sid}`, level), (state) => {
      const signedIn = gk11.idpSignIn({ level, base: '', cookies: {}, query: new URLSearchParams() }, state, 'pilgrim', 'pilgrim');
      const pid = signedIn.cookies?.[0]?.value ?? '';
      for (let i = 0; i < 50; i++) {
        gk11.authorize({ level, base: '', cookies: { [gk11.pidCookie(level)]: pid }, query: new URLSearchParams({
          response_type: 'code', client_id: 'citadel', redirect_uri: gk11.LINK_REDIRECT, code_challenge: long(`c${i}`), code_challenge_method: 'S256',
        }) }, state);
        state.newState({ session: hex(), purpose: 'link', verifier: newVerifier() });
        state.clientSessions.set(hex(), 'citadel_admin');
        gk11.idpSignIn({ level, base: '', cookies: {}, query: new URLSearchParams() }, state, 'pilgrim', 'pilgrim');
      }
      expect([state.codes.size, state.flows.size, state.idpSessions.size]).toEqual([50, 50, 50]);
    });
    expect(measured, `GK-11 measured ${(measured / KiB).toFixed(1)} KiB`).toBeLessThan(gk11.STATE_WEIGHT ?? 0);
  });

  it('GK-16: sessions, aliases and resume links, each at its cap of 100, ids at their longest (64)', () => {
    const id64 = (tag: string) => `${tag}-`.padEnd(64, 'z'); // Acolyte adopts any [A-Za-z0-9_-]{1,64} from a link
    const measured = measure(() => gk16.labState(`w16-${++sid}`, 'inquisitor'), (state, i) => {
      for (let k = 0; k < 100; k++) {
        state.sessions.set(id64(`s${i}${k}`), { user: 'citadel_admin' });
        state.aliases.set(id64(`a${i}${k}`), { to: hex(), until: Date.now() });
        state.resumes.set(hex(), id64(`r${i}${k}`));
      }
    });
    expect(measured, `GK-16 measured ${(measured / KiB).toFixed(1)} KiB`).toBeLessThan(gk16.STATE_WEIGHT ?? 0);
  });

  it('each lab really declares its weight: a new instance adds world + browser + STATE_WEIGHT to the budget', () => {
    const world = SIM_LIMITS.inboxWeight + SIM_LIMITS.attackerLogWeight + SIM_LIMITS.visitsWeight + SIM_LIMITS.browserWeight;
    for (const [lab, weight] of [[gk10, gk10.STATE_WEIGHT], [gk11, gk11.STATE_WEIGHT], [gk16, gk16.STATE_WEIGHT]] as const) {
      const before = cappedBudgetUsage().bytes;
      lab.labState(`declared-${++sid}`, 'templar');
      expect(cappedBudgetUsage().bytes - before).toBe(world + (weight ?? 0));
    }
  });
});

describe('every built-in weight is small next to the shared budget (at most 1/32 of it)', () => {
  it('sim stores, the simulated file system and the labs\' own state', () => {
    const weights: Record<string, number | undefined> = {
      inbox: SIM_LIMITS.inboxWeight, attackerLog: SIM_LIMITS.attackerLogWeight, visits: SIM_LIMITS.visitsWeight,
      browser: SIM_LIMITS.browserWeight, simFs: SIMFS_LIMITS.weight,
      'GK-10': gk10.STATE_WEIGHT, 'GK-11': gk11.STATE_WEIGHT, 'GK-16': gk16.STATE_WEIGHT,
    };
    for (const [what, w] of Object.entries(weights)) {
      expect(w, what).toBeGreaterThan(0);
      expect(w, what).toBeLessThanOrEqual(CAPPED_BUDGET_BYTES / 32);
    }
  });
});
