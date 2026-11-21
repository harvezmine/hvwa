// tests/support/range.ts — the range test kit: lab registry entries, and a portal-mode app on a fake clock with
// accounts and signed-in browsers.
import { onTestFinished } from 'vitest';
import request from 'supertest';
import { createApp, type HvwaApp } from '../../src/app.js';
import type { AuthOptions, RegistrationOptions } from '../../src/auth/index.js';
import { parseRegistry, type LabRegistry } from '../../src/lab-registry.js';
import { DEFAULT_LIMITS, type RangePortalOptions } from '../../src/range/types.js';
import { csrfOf, FAST_HASHER, TEST_SECRET } from '../helpers.js';
import { fakeWarden, type FakeWarden } from './fake-warden.js';

/** One registry entry as labs/registry.json holds it: a valid default, overridden per test. */
export function labEntry(id: string, slug: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, slug,
    title: { en: `${slug} title`, id: `judul ${slug}` },
    app: `App ${slug}`,
    category: 'SQL injection',
    difficulty: 'easy',
    levels: ['acolyte', 'templar', 'inquisitor', 'divine'],
    port: 8080,
    health: '/healthz',
    flag: { placement: 'file:/tmp/hvwa/flag.txt' },
    needsBot: false,
    themeId: `theme-${slug}`,
    scenario: { en: `Scenario of ${slug}`, id: `Skenario ${slug}` },
    briefing: { en: `Briefing of ${slug}`, id: `Briefing ${slug}` },
    hints: [{ id: 1, cost: 10, text: { en: `Hint one of ${slug}`, id: `Petunjuk satu ${slug}` } }],
    version: '1.0.0',
    image: `sigmajo/hvwa:lab-${slug}-1.0.0@sha256:${'a'.repeat(64)}`,
    ...over,
  };
}

/** Two labs: r01 (Easy, all four levels, one hint) and r02 (Medium, Acolyte and Divine, a local image id). */
export function testRegistry(): LabRegistry {
  return parseRegistry({
    schema: 1,
    labs: [
      labEntry('r01', 'clinic'),
      labEntry('r02', 'courier', {
        category: 'Broken access control', difficulty: 'medium', levels: ['acolyte', 'divine'],
        image: `sha256:${'b'.repeat(64)}`, hints: [],
      }),
    ],
  });
}

export const T0 = Date.UTC(2026, 10, 20, 12);
export const DOMAIN = 'range.test';
export const ADMIN_PASSWORD = 'Admin-Pass-1234';
export const PLAYER_PASSWORD = 'Player-Pass-1';
/** The range key every test app uses (>= MIN_RANGE_KEY_LENGTH); never a production value. */
export const RANGE_KEY = 'r'.repeat(40);

export interface Clock { readonly now: () => number; readonly advance: (ms: number) => void }
export interface Kit { readonly app: HvwaApp; readonly clock: Clock; readonly registry: LabRegistry; readonly warden: FakeWarden }
export type Agent = ReturnType<typeof request.agent>;

/**
 * An app in portal mode on a fake clock: the test registry, the fast hasher, 10-character passwords, a lifted
 * registration limit (tests/auth-register.spec.ts covers the real one). Closed when the test ends.
 *
 * The range's public scheme stays the production default (https), but hvwa_auth is NOT Secure here
 * (`secureCookies: false`): supertest speaks plain http, and a client never sends a Secure cookie back over it.
 * tests/portal-mode.spec.ts checks the real default (Secure behind https) without this override.
 */
export function portalApp(o: {
  range?: Partial<RangePortalOptions>; registration?: RegistrationOptions; auth?: Partial<AuthOptions>; warden?: FakeWarden;
} = {}): Kit {
  let t = T0;
  const clock: Clock = { now: () => t, advance: (ms) => { t += ms; } };
  const registry = o.range?.registry ?? testRegistry();
  const warden = o.warden ?? fakeWarden({ autoReady: true });
  const app = createApp({
    flagSecret: TEST_SECRET, mode: 'portal',
    auth: {
      initialPassword: ADMIN_PASSWORD, hasher: FAST_HASHER, now: clock.now, passwordMinLength: 10, secureCookies: false,
      ...o.auth,
      registration: { perIp: 1000, now: clock.now, ...o.registration },
    },
    range: {
      domain: DOMAIN, portalHost: DOMAIN, internalHost: 'portal', registry, limits: DEFAULT_LIMITS, now: clock.now,
      warden, rangeKey: RANGE_KEY, log: () => {}, ...o.range,
    },
  });
  onTestFinished(() => { try { app.locals.db.close(); } catch { /* closed by the test */ } });
  return { app, clock, registry, warden };
}

/** Create a player through the service (no HTTP); returns its id. */
export async function createUser(app: HvwaApp, username: string, password = PLAYER_PASSWORD): Promise<number> {
  const r = await app.locals.auth!.register(username, password, password);
  if (!r.ok) throw new Error(`createUser ${username}: ${r.error}`);
  return r.userId;
}

/** A browser signed in as `username` (303 expected). */
export async function signInAs(app: HvwaApp, username: string, password: string): Promise<Agent> {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const res = await agent.post('/login').type('form').send({ _csrf: csrfOf(page.text), username, password });
  if (res.status !== 303) throw new Error(`sign-in of ${username} -> ${res.status}`);
  return agent;
}

/** A new player, signed in. */
export async function player(app: HvwaApp, username: string): Promise<{ agent: Agent; userId: number }> {
  const userId = await createUser(app, username);
  return { agent: await signInAs(app, username, PLAYER_PASSWORD), userId };
}

/** The admin, signed in. */
export const signInAdmin = (app: HvwaApp) => signInAs(app, 'admin', ADMIN_PASSWORD);

/** This browser's account-form token (rendered on /account/password). */
export async function accountCsrf(agent: Agent): Promise<string> {
  return csrfOf((await agent.get('/account/password')).text);
}
