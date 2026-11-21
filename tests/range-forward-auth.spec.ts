// Forward-auth (src/range/gate.ts, spec range §5.5): Traefik asks GET http://portal:1337/__hvwa/auth before every request
// to an instance host. Pass = the internal host, the shared secret, Traefik's X-Forwarded-* and a valid hvwa_gate for
// THAT instance, which must be running, owned by the cookie's user, whose account is active. Fail = 401 + a link home.
// Compact POC (plan amendment): the gate cookie expires at started_at + maxMs (there is no separate ceiling).
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { GATE_COOKIE, gateKeyOf, mintGateCookie } from '../src/range/gate.js';
import { DEFAULT_LIMITS } from '../src/range/types.js';
import { createUser, DOMAIN, FORWARD_SECRET, portalApp, RANGE_KEY, T0, type Kit } from './support/range.js';

const KEY = gateKeyOf(RANGE_KEY);
async function running(kit: Kit, userId: number): Promise<string> {
  const lc = kit.app.locals.range!.lifecycle;
  const r = await lc.launch(userId, 'r01', 'acolyte');
  if (!r.ok) throw new Error(r.error);
  await lc.refresh(r.instance.id);
  return r.instance.id;
}
const cookieFor = (id: string, userId: number, exp = T0 + DEFAULT_LIMITS.maxMs) => mintGateCookie(KEY, id, userId, exp);
/** Task 3 kept the `disabled` column but dropped the admin operations, so a spec sets it in the DB. */
const disable = (kit: Kit, userId: number) => kit.app.locals.db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(userId);
function ask(kit: Kit, h: { host?: string; secret?: string | null; fhost?: string | null; uri?: string | null; method?: string | null; cookie?: string }) {
  let r = request(kit.app).get('/__hvwa/auth').set('Host', h.host ?? 'portal');
  if (h.secret !== null) r = r.set('X-Hvwa-Auth-Secret', h.secret ?? FORWARD_SECRET);
  if (h.fhost !== null && h.fhost !== undefined) r = r.set('X-Forwarded-Host', h.fhost);
  if (h.uri !== null) r = r.set('X-Forwarded-Uri', h.uri ?? '/');
  if (h.method !== null) r = r.set('X-Forwarded-Method', h.method ?? 'GET');
  if (h.cookie !== undefined) r = r.set('Cookie', `${GATE_COOKIE}=${h.cookie}`);
  return r;
}

describe('/__hvwa/auth', () => {
  it('passes the owner\'s cookie for its running instance: 200, empty, no-store, no cookie set, last-seen recorded', async () => {
    const kit = portalApp();
    const alice = await createUser(kit.app, 'alice');
    const id = await running(kit, alice);
    const res = await ask(kit, { fhost: `i-${id}.${DOMAIN}:8080`, uri: '/patients?id=1', cookie: cookieFor(id, alice) });
    expect(res.status).toBe(200);
    expect(res.text).toBe('');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['set-cookie']).toBeUndefined();
    const lc = kit.app.locals.range!.lifecycle;
    lc.flushLastSeen();
    expect(lc.store.get(id)?.lastSeenAt).toBe(T0);
  });

  it('answers only on the internal host (404 elsewhere) and only to GET', async () => {
    const kit = portalApp();
    const alice = await createUser(kit.app, 'alice');
    const id = await running(kit, alice);
    for (const host of [DOMAIN, `i-${id}.${DOMAIN}`]) {
      expect((await ask(kit, { host, fhost: `i-${id}.${DOMAIN}`, cookie: cookieFor(id, alice) })).status, host).toBe(404);
    }
    expect((await request(kit.app).post('/__hvwa/auth').set('Host', 'portal').set('X-Hvwa-Auth-Secret', FORWARD_SECRET)).status).toBe(404);
  });

  it('403 without the shared secret or without Traefik\'s X-Forwarded-* headers', async () => {
    const kit = portalApp();
    const alice = await createUser(kit.app, 'alice');
    const id = await running(kit, alice);
    const fhost = `i-${id}.${DOMAIN}`;
    const cookie = cookieFor(id, alice);
    for (const h of [{ secret: null }, { secret: 'f'.repeat(39) }, { secret: `${FORWARD_SECRET}x` }, { fhost: null }, { uri: null }, { method: null }]) {
      const res = await ask(kit, { fhost, cookie, ...h });
      expect(res.status, JSON.stringify(h)).toBe(403);
      expect(res.text).toBe('forward-auth: refused\n');
    }
  });

  it('401 with the page home: no cookie, a forged or expired one, another instance\'s, the gate path, a foreign host', async () => {
    const kit = portalApp();
    const alice = await createUser(kit.app, 'alice');
    const bob = await createUser(kit.app, 'bob');
    const a = await running(kit, alice);
    const b = await running(kit, bob);
    const fa = `i-${a}.${DOMAIN}`;
    const cases: Parameters<typeof ask>[1][] = [
      { fhost: fa },
      { fhost: fa, cookie: 'v1.junk' },
      { fhost: fa, cookie: cookieFor(a, bob) },              // bob forging alice's instance: MAC is fine (we mint it) but bob does not own it
      { fhost: fa, cookie: cookieFor(b, bob) },              // bob's own cookie, alice's host
      { fhost: fa, cookie: mintGateCookie(gateKeyOf('x'.repeat(40)), a, alice, T0 + 1000) },
      { fhost: fa, cookie: cookieFor(a, alice, T0) },        // expired
      { fhost: fa, cookie: cookieFor(a, alice), uri: '/__hvwa/gate?t=x' },
      { fhost: `i-${a}.evil.example`, cookie: cookieFor(a, alice) },
      { fhost: `${fa},evil.example`, cookie: cookieFor(a, alice) },
    ];
    for (const h of cases) {
      const res = await ask(kit, h);
      expect(res.status, JSON.stringify(h)).toBe(401);
      expect(res.text).toContain(`href="https://${DOMAIN}/"`);
      // The page styles itself inline (an instance host has no /static), so only style-src is allowed.
      expect(res.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    }
  });

  it('the 401 is bilingual and says whether the instance stopped, expired or failed', async () => {
    const kit = portalApp();
    const alice = await createUser(kit.app, 'alice');
    const id = await running(kit, alice);
    const ask401 = () => ask(kit, { fhost: `i-${id}.${DOMAIN}`, cookie: cookieFor(id, alice) });
    expect((await ask401()).status).toBe(200);
    // Both languages are always present (no cookie or language preference exists on an instance host).
    const stopped = await (async () => {
      await kit.app.locals.range!.lifecycle.stopInstance(id, 'expired');
      return ask401();
    })();
    expect(stopped.status).toBe(401);
    expect(stopped.text).toContain('This lab is not open in this browser');
    expect(stopped.text).toContain('Lab ini tidak terbuka di peramban ini');
    expect(stopped.text).toContain('reached its time limit');
    expect(stopped.text).toContain('batas waktunya');
    expect(stopped.text).toContain('<style>'); // themed, self-contained
  });

  it('401 once the instance stops or the account is disabled, whatever the cookie says', async () => {
    const kit = portalApp();
    const alice = await createUser(kit.app, 'alice');
    const bob = await createUser(kit.app, 'bob');
    const a = await running(kit, alice);
    const b = await running(kit, bob);
    expect((await ask(kit, { fhost: `i-${a}.${DOMAIN}`, cookie: cookieFor(a, alice) })).status).toBe(200);
    await kit.app.locals.range!.lifecycle.stop(alice);
    expect((await ask(kit, { fhost: `i-${a}.${DOMAIN}`, cookie: cookieFor(a, alice) })).status).toBe(401);
    disable(kit, bob);
    expect((await ask(kit, { fhost: `i-${b}.${DOMAIN}`, cookie: cookieFor(b, bob) })).status).toBe(401);
  });
});
