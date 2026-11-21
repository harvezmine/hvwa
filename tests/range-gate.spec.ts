// The gate (src/range/tickets.ts, src/range/gate.ts, spec range §5.4): "Open lab" mints a single-use 60 s ticket bound to
// (user, instance); /__hvwa/gate on that instance's host trades it for a HOST-ONLY hvwa_gate cookie (HMAC over instance,
// user and expiry) and redirects to the lab. Anything else on an instance host is 404, and no portal cookie lands there.
// Compact POC (plan amendment): the cookie expires at started_at + maxMs (there is no separate ceiling).
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { GATE_COOKIE, gateKeyOf, mintGateCookie, verifyGateCookie } from '../src/range/gate.js';
import { createTicketStore, TICKET_TTL_MS } from '../src/range/tickets.js';
import { DEFAULT_LIMITS } from '../src/range/types.js';
import { setCookieHeader, setCookieValue } from './helpers.js';
import { createUser, DOMAIN, portalApp, RANGE_KEY, T0, type Kit } from './support/range.js';

const KEY = gateKeyOf(RANGE_KEY);
const ID = 'abcdefghijklmnopqrstuvwxyz';
const host = (id: string) => `i-${id}.${DOMAIN}`;
async function running(kit: Kit, userId: number, labId = 'r01'): Promise<string> {
  const lc = kit.app.locals.range!.lifecycle;
  const r = await lc.launch(userId, labId, 'acolyte');
  if (!r.ok) throw new Error(r.error);
  await lc.refresh(r.instance.id);
  return r.instance.id;
}
const gate = (kit: Kit, id: string, t: string) => request(kit.app).get(`/__hvwa/gate?t=${encodeURIComponent(t)}`).set('Host', host(id));
/** Task 3 kept the `disabled` column but dropped the admin operations, so a spec sets it in the DB. */
const disable = (kit: Kit, userId: number) => kit.app.locals.db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(userId);

describe('tickets', () => {
  it('single use, valid 60 s, bound to user and instance, refused when malformed; the store is bounded', () => {
    let t = 0;
    const s = createTicketStore({ now: () => t });
    const a = s.mint(1, ID);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.consume(a)).toEqual({ userId: 1, instanceId: ID });
    expect(s.consume(a)).toBeUndefined();
    const b = s.mint(1, ID);
    t += TICKET_TTL_MS;
    expect(s.consume(b)).toBeUndefined();
    for (const junk of ['x', undefined, ['a'], 'A'.repeat(44)]) expect(s.consume(junk)).toBeUndefined();
    const small = createTicketStore({ max: 2 });
    small.mint(1, ID); small.mint(2, ID); small.mint(3, ID);
    expect(small.size()).toBe(2);
  });
});

describe('the hvwa_gate cookie', () => {
  it('v1.<instance>.<user>.<expiry>.<mac>: verifies only untouched, unexpired, under the right key', () => {
    const c = mintGateCookie(KEY, ID, 42, T0 + 1000);
    expect(c).toMatch(/^v1\.[a-z2-7]{26}\.42\.\d+\.[A-Za-z0-9_-]{43}$/);
    expect(verifyGateCookie(KEY, c, T0)).toEqual({ instanceId: ID, userId: 42, expMs: T0 + 1000 });
    expect(verifyGateCookie(KEY, c, T0 + 1000)).toBeUndefined();
    expect(verifyGateCookie(gateKeyOf('o'.repeat(40)), c, T0)).toBeUndefined();
    expect(verifyGateCookie(KEY, c.replace('.42.', '.43.'), T0)).toBeUndefined();
    expect(verifyGateCookie(KEY, c.replace(ID, 'z'.repeat(26)), T0)).toBeUndefined();
    expect(verifyGateCookie(KEY, `${c.slice(0, -1)}${c.endsWith('A') ? 'B' : 'A'}`, T0)).toBeUndefined();
    for (const junk of [undefined, '', 'v2.x', `${c}.x`, 42]) expect(verifyGateCookie(KEY, junk, T0)).toBeUndefined();
  });
});

describe('/__hvwa/gate', () => {
  it('a valid ticket sets hvwa_gate host-only (HttpOnly, SameSite=Lax, Path=/, no Domain, Max-Age to the lifetime) and redirects to /', async () => {
    const kit = portalApp();
    const userId = await createUser(kit.app, 'alice');
    const id = await running(kit, userId);
    const res = await gate(kit, id, kit.app.locals.range!.tickets.mint(userId, id));
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const line = setCookieHeader(res, GATE_COOKIE) ?? '';
    for (const part of [/; HttpOnly/, /; SameSite=Lax/i, /; Path=\//, new RegExp(`Max-Age=${DEFAULT_LIMITS.maxMs / 1000};`)]) expect(line).toMatch(part);
    expect(line).not.toMatch(/domain=/i);
    expect(line).not.toMatch(/Secure/);
    expect(setCookieHeader(res, 'hvwa_sid')).toBeUndefined();
    expect(verifyGateCookie(KEY, setCookieValue(res, GATE_COOKIE), T0)).toEqual({ instanceId: id, userId, expMs: T0 + DEFAULT_LIMITS.maxMs });
  });

  it('Secure when the range runs behind HTTPS (secureCookies)', async () => {
    const kit = portalApp({ range: { secureCookies: true } });
    const userId = await createUser(kit.app, 'alice');
    const id = await running(kit, userId);
    expect(setCookieHeader(await gate(kit, id, kit.app.locals.range!.tickets.mint(userId, id)), GATE_COOKIE)).toMatch(/; Secure/);
  });

  it('refuses with the 401 page (a link back to the portal, no cookie): replay, expiry, another instance\'s host, stopped, disabled, junk', async () => {
    const kit = portalApp();
    const range = kit.app.locals.range!;
    const alice = await createUser(kit.app, 'alice');
    const bob = await createUser(kit.app, 'bob');
    const a = await running(kit, alice);
    const b = await running(kit, bob);
    const once = range.tickets.mint(alice, a);
    expect((await gate(kit, a, once)).status).toBe(303);
    const refused = async (id: string, ticket: string) => {
      const res = await gate(kit, id, ticket);
      expect(res.status).toBe(401);
      expect(res.text).toContain(`href="https://${DOMAIN}/"`);
      expect(setCookieHeader(res, GATE_COOKIE)).toBeUndefined();
    };
    await refused(a, once);                                       // single use
    const late = range.tickets.mint(alice, a);
    kit.clock.advance(TICKET_TTL_MS + 1);
    await refused(a, late);                                       // 60 s
    await refused(b, range.tickets.mint(alice, a));               // bound to the instance
    await refused(b, range.tickets.mint(alice, b));               // bound to the owner
    await refused(a, 'not-a-ticket');
    disable(kit, alice);
    await refused(a, range.tickets.mint(alice, a));               // account disabled
    await range.lifecycle.stop(bob);
    await refused(b, range.tickets.mint(bob, b));                 // instance stopped
  });

  it('everything else on an instance host is 404 (POST to the gate too), without any portal cookie', async () => {
    const kit = portalApp();
    for (const [method, path] of [['get', '/'], ['get', '/__hvwa/auth'], ['post', '/__hvwa/gate'], ['get', '/login']] as const) {
      const res = await request(kit.app)[method](path).set('Host', host(ID));
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.headers['set-cookie'], `${method} ${path}`).toBeUndefined();
    }
  });
});
