// The portal-mode settings (src/range/config.ts): parsed only when HVWA_MODE=portal. Required values are named in
// one readable line each; a secret's value never appears in a message. Compact POC (plan amendment, spec §16): no
// event code, no Extend and no separate ceiling (idle 20 min, lifetime 60 min), registration open unless
// HVWA_REGISTRATION_OPEN=0.
import { describe, it, expect } from 'vitest';
import { loadRangeConfig, RANGE_SECRET_NAMES, type RangeConfig } from '../src/range/config.js';

const S = (c: string) => c.repeat(40);
const BASE = {
  HVWA_RANGE_DOMAIN: 'hvwa.my.id', HVWA_ADMIN_PASSWORD: 'Admin-Pass-1234',
  HVWA_WARDEN_SECRET: S('w'), HVWA_FORWARD_AUTH_SECRET: S('f'),
};
function ok(env: Record<string, string | undefined>): RangeConfig {
  const r = loadRangeConfig(env);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.config;
}
function errors(env: Record<string, string | undefined>): string[] {
  const r = loadRangeConfig(env);
  if (r.ok) throw new Error('expected a configuration error');
  return r.errors;
}

describe('loadRangeConfig', () => {
  it('defaults: the portal host is the domain, https behind the tunnel, capacity 140, idle 20 / lifetime 60 minutes, registration open, the warden at http://warden:8080', () => {
    expect(ok(BASE)).toEqual({
      domain: 'hvwa.my.id', portalHost: 'hvwa.my.id', publicScheme: 'https', publicPort: undefined, capacity: 140,
      idleMs: 20 * 60_000, maxMs: 60 * 60_000,
      registrationOpen: true, wardenUrl: 'http://warden:8080', wardenSecret: S('w'), forwardAuthSecret: S('f'),
      rangeKey: undefined, internalHost: 'portal', registryPath: undefined,
    });
  });

  it('reads every setting (local mode: i-<id>.localhost labs, the portal at hvwa.localhost, plain http on a port)', () => {
    expect(ok({
      ...BASE, HVWA_RANGE_DOMAIN: 'LocalHost', HVWA_PORTAL_HOST: 'hvwa.localhost', HVWA_RANGE_PUBLIC_SCHEME: 'http', HVWA_RANGE_PUBLIC_PORT: '18080',
      HVWA_RANGE_CAPACITY: '2', HVWA_RANGE_IDLE_MIN: '1', HVWA_RANGE_MAX_MIN: '5',
      HVWA_REGISTRATION_OPEN: '0', HVWA_WARDEN_URL: 'http://127.0.0.1:18080',
      HVWA_RANGE_KEY: S('k'), HVWA_FORWARD_AUTH_HOST: 'Portal', HVWA_LAB_REGISTRY: '/etc/hvwa/registry.json',
    })).toEqual({
      domain: 'localhost', portalHost: 'hvwa.localhost', publicScheme: 'http', publicPort: 18080, capacity: 2,
      idleMs: 60_000, maxMs: 300_000,
      registrationOpen: false, wardenUrl: 'http://127.0.0.1:18080', wardenSecret: S('w'), forwardAuthSecret: S('f'),
      rangeKey: S('k'), internalHost: 'portal', registryPath: '/etc/hvwa/registry.json',
    });
  });

  it('HVWA_REGISTRATION_OPEN is 1 (default, blank) or 0; anything else is an error', () => {
    expect(ok({ ...BASE, HVWA_REGISTRATION_OPEN: '1' }).registrationOpen).toBe(true);
    expect(ok({ ...BASE, HVWA_REGISTRATION_OPEN: ' ' }).registrationOpen).toBe(true);
    expect(ok({ ...BASE, HVWA_REGISTRATION_OPEN: '0' }).registrationOpen).toBe(false);
    for (const value of ['yes', 'false', 'off', '2']) {
      expect(errors({ ...BASE, HVWA_REGISTRATION_OPEN: value }), value).toEqual(['HVWA_REGISTRATION_OPEN: must be 0 or 1']);
    }
  });

  it('names every missing requirement: the domain, the admin password (>= 10), both secrets', () => {
    expect(errors({})).toEqual([
      'HVWA_RANGE_DOMAIN: is required in portal mode',
      'HVWA_ADMIN_PASSWORD: is required in portal mode (at least 10 characters)',
      'HVWA_WARDEN_SECRET: is required in portal mode',
      'HVWA_FORWARD_AUTH_SECRET: is required in portal mode',
    ]);
    expect(errors({ ...BASE, HVWA_ADMIN_PASSWORD: 'nine-char' }))
      .toEqual(['HVWA_ADMIN_PASSWORD: is required in portal mode (at least 10 characters)']);
  });

  it.each(['HVWA_WARDEN_SECRET', 'HVWA_FORWARD_AUTH_SECRET', 'HVWA_RANGE_KEY'])('%s needs 32+ characters and is never echoed', (name) => {
    const value = 'Tiny-Secret-Value';
    const out = errors({ ...BASE, [name]: value });
    expect(out).toEqual([`${name}: must be at least 32 characters`]);
    expect(out.join('\n')).not.toContain(value);
  });

  it('refuses a domain with a scheme, a bad port or scheme, a warden URL with a path, a portal host shaped like an instance', () => {
    expect(errors({ ...BASE, HVWA_RANGE_DOMAIN: 'https://hvwa.my.id' }))
      .toEqual(['HVWA_RANGE_DOMAIN: must be a bare domain such as hvwa.my.id or localhost']);
    expect(errors({ ...BASE, HVWA_RANGE_PUBLIC_PORT: '70000' })).toEqual([expect.stringMatching(/^HVWA_RANGE_PUBLIC_PORT: /)]);
    expect(errors({ ...BASE, HVWA_RANGE_PUBLIC_SCHEME: 'ftp' })).toEqual([expect.stringMatching(/^HVWA_RANGE_PUBLIC_SCHEME: /)]);
    expect(errors({ ...BASE, HVWA_WARDEN_URL: 'http://warden:8080/v1' })).toEqual(['HVWA_WARDEN_URL: must be http(s)://host[:port]']);
    for (const host of ['i-portal.hvwa.my.id', 'c-1.hvwa.my.id']) {
      expect(errors({ ...BASE, HVWA_PORTAL_HOST: host }))
        .toEqual(['HVWA_PORTAL_HOST: its first label must not start with i- or c- (instance and request-catcher hosts)']);
    }
  });

  it('checks the effective portal host, including the domain-derived default', () => {
    for (const domain of ['i-hvwa.my.id', 'c-hvwa.my.id']) {
      expect(errors({ ...BASE, HVWA_RANGE_DOMAIN: domain }))
        .toEqual(['HVWA_RANGE_DOMAIN: its first label must not start with i- or c- (instance and request-catcher hosts)']);
    }
    // An explicit, well-formed portal host overrides a domain that would otherwise derive a forbidden one.
    expect(ok({ ...BASE, HVWA_RANGE_DOMAIN: 'i-hvwa.my.id', HVWA_PORTAL_HOST: 'hvwa.my.id' }).portalHost).toBe('hvwa.my.id');
  });

  it('names the variables server.ts removes from process.env', () => {
    expect(RANGE_SECRET_NAMES).toEqual(['HVWA_WARDEN_SECRET', 'HVWA_FORWARD_AUTH_SECRET', 'HVWA_RANGE_KEY']);
  });
});
