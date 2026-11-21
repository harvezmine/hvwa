// src/range/config.ts — the portal-mode settings (HVWA_MODE=portal, spec 2026-11-20 range §5 and §16). Parsed ONLY in
// portal mode (server.ts), so standalone and the lite image never read them. No message ever contains a value.
//
// Compact POC (plan amendment, spec §16): no event code and no admin switch (registration is open unless
// HVWA_REGISTRATION_OPEN=0, read once at start); no Extend and no separate ceiling (idle 20 min, lifetime 60 min by
// default; the gate cookie expires at start + the lifetime).
import { z } from 'zod';

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const unset = <T extends z.ZodTypeAny>(s: T) => z.preprocess(blank, s);

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
/** A bare DNS name: hvwa.my.id, localhost, hvwa.localhost. No scheme, port, path or wildcard. */
export const DOMAIN_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Shortest accepted secret (warden, forward-auth, range key): `openssl rand -hex 32` gives 64 characters. */
export const MIN_RANGE_SECRET_LENGTH = 32;
/** Shortest password in portal mode (spec §4): the first admin's, every player's, every change. */
export const RANGE_PASSWORD_MIN_LENGTH = 10;
/** What server.ts removes from process.env once the config holds it. */
export const RANGE_SECRET_NAMES = Object.freeze(['HVWA_WARDEN_SECRET', 'HVWA_FORWARD_AUTH_SECRET', 'HVWA_RANGE_KEY'] as const);

const host = (message: string) => z.string().trim().toLowerCase().regex(DOMAIN_RE, message);
const secret = unset(z.string()
  .min(MIN_RANGE_SECRET_LENGTH, `must be at least ${MIN_RANGE_SECRET_LENGTH} characters`)
  .refine((v) => !CONTROL.test(v), 'must not contain control characters')
  .optional());
const minutes = (def: number) => unset(z.coerce.number().int().min(1).max(7 * 24 * 60).default(def));

const schema = z.object({
  HVWA_RANGE_DOMAIN: unset(host('must be a bare domain such as hvwa.my.id or localhost').optional()),
  HVWA_PORTAL_HOST: unset(host('must be a bare host name such as hvwa.my.id').optional()),
  // Behind the Cloudflare Tunnel the public scheme is https (TLS ends at Cloudflare); local runs are plain http.
  HVWA_RANGE_PUBLIC_SCHEME: unset(z.enum(['http', 'https']).default('https')),
  HVWA_RANGE_PUBLIC_PORT: unset(z.coerce.number().int().min(1).max(65535).optional()),
  HVWA_RANGE_CAPACITY: unset(z.coerce.number().int().min(1).max(10_000).default(140)),
  HVWA_RANGE_IDLE_MIN: minutes(20),
  HVWA_RANGE_MAX_MIN: minutes(60),
  // Open self-registration (spec §4, §16): '1' (default) open, '0' closed. Read once at start.
  HVWA_REGISTRATION_OPEN: unset(z.enum(['0', '1'], { errorMap: () => ({ message: 'must be 0 or 1' }) }).default('1')),
  HVWA_WARDEN_URL: unset(z.string().trim()
    .regex(/^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/, 'must be http(s)://host[:port]').default('http://warden:8080')),
  HVWA_WARDEN_SECRET: secret,
  HVWA_FORWARD_AUTH_SECRET: secret,
  HVWA_RANGE_KEY: secret,
  HVWA_FORWARD_AUTH_HOST: unset(host('must be a bare host name').default('portal')),
  HVWA_LAB_REGISTRY: unset(z.string().trim().min(1).optional()),
  // Validated (control characters, length) by src/config.ts; here only "present and long enough for portal mode".
  HVWA_ADMIN_PASSWORD: unset(z.string().optional()),
}).superRefine((c, ctx) => {
  const need = (path: string, met: boolean, message: string) => {
    if (!met) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  };
  need('HVWA_RANGE_DOMAIN', c.HVWA_RANGE_DOMAIN !== undefined, 'is required in portal mode');
  need('HVWA_ADMIN_PASSWORD', (c.HVWA_ADMIN_PASSWORD?.length ?? 0) >= RANGE_PASSWORD_MIN_LENGTH,
    `is required in portal mode (at least ${RANGE_PASSWORD_MIN_LENGTH} characters)`);
  need('HVWA_WARDEN_SECRET', c.HVWA_WARDEN_SECRET !== undefined, 'is required in portal mode');
  need('HVWA_FORWARD_AUTH_SECRET', c.HVWA_FORWARD_AUTH_SECRET !== undefined, 'is required in portal mode');
  // Spec §5: i-<id>.<domain> are instances and c-<user>.<domain> request catchers; nothing else may look like them.
  // Check the effective portal host: HVWA_PORTAL_HOST when set, otherwise the host derived from HVWA_RANGE_DOMAIN.
  need(c.HVWA_PORTAL_HOST === undefined ? 'HVWA_RANGE_DOMAIN' : 'HVWA_PORTAL_HOST',
    !/^[ic]-/.test(c.HVWA_PORTAL_HOST ?? c.HVWA_RANGE_DOMAIN ?? ''),
    'its first label must not start with i- or c- (instance and request-catcher hosts)');
}).transform((c) => ({
  domain: c.HVWA_RANGE_DOMAIN as string,
  portalHost: c.HVWA_PORTAL_HOST ?? (c.HVWA_RANGE_DOMAIN as string),
  publicScheme: c.HVWA_RANGE_PUBLIC_SCHEME,
  publicPort: c.HVWA_RANGE_PUBLIC_PORT,
  capacity: c.HVWA_RANGE_CAPACITY,
  idleMs: c.HVWA_RANGE_IDLE_MIN * 60_000,
  maxMs: c.HVWA_RANGE_MAX_MIN * 60_000,
  registrationOpen: c.HVWA_REGISTRATION_OPEN === '1',
  wardenUrl: c.HVWA_WARDEN_URL,
  wardenSecret: c.HVWA_WARDEN_SECRET as string,
  forwardAuthSecret: c.HVWA_FORWARD_AUTH_SECRET as string,
  rangeKey: c.HVWA_RANGE_KEY,
  internalHost: c.HVWA_FORWARD_AUTH_HOST,
  registryPath: c.HVWA_LAB_REGISTRY,
}));

export type RangeConfig = z.output<typeof schema>;
export type RangeConfigResult = { ok: true; config: RangeConfig } | { ok: false; errors: string[] };

/** Parse without throwing; one `<NAME>: <message>` line per problem (never a value). */
export function loadRangeConfig(env: Record<string, string | undefined> = process.env): RangeConfigResult {
  const r = schema.safeParse(env);
  if (r.success) return { ok: true, config: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message.replace(/\s+/g, ' ')}`) };
}
