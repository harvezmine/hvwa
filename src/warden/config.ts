// src/warden/config.ts — the warden's environment. The secret is never echoed.
import { z } from 'zod';
import { DOMAIN_RE } from '../range/config.js';
import { WARDEN_SECRET_MIN } from './protocol.js';
import { RUNTIMES } from './template.js';

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const unset = <T extends z.ZodTypeAny>(s: T) => z.preprocess(blank, s);

const schema = z.object({
  HOST: unset(z.string().trim().min(1).default('127.0.0.1')),
  PORT: unset(z.coerce.number().int().min(1).max(65535).default(8080)),
  HVWA_WARDEN_SECRET: unset(z.string().min(WARDEN_SECRET_MIN, `must be at least ${WARDEN_SECRET_MIN} characters`).optional()),
  HVWA_DOCKER_URL: unset(z.string().trim().regex(/^http:\/\/[a-z0-9.-]+(?::\d{1,5})?$/, 'must be http://host[:port] (the socket proxy)')
    .default('http://socket-proxy:2375')),
  HVWA_LAB_REGISTRY: unset(z.string().trim().min(1).default('/etc/hvwa/registry.json')),
  HVWA_RANGE_DOMAIN: unset(z.string().trim().toLowerCase().regex(DOMAIN_RE, 'must be a bare domain such as hvwa.my.id or localhost').optional()),
  HVWA_TRAEFIK_CONTAINER: unset(z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/, 'must be a container name').default('hvwa-range-traefik')),
  HVWA_RANGE_RUNTIME: unset(z.enum(RUNTIMES).default('runc')),
}).superRefine((c, ctx) => {
  if (c.HVWA_WARDEN_SECRET === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['HVWA_WARDEN_SECRET'], message: 'is required' });
  if (c.HVWA_RANGE_DOMAIN === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['HVWA_RANGE_DOMAIN'], message: 'is required' });
}).transform((c) => ({
  host: c.HOST, port: c.PORT, secret: c.HVWA_WARDEN_SECRET as string, dockerUrl: c.HVWA_DOCKER_URL, registryPath: c.HVWA_LAB_REGISTRY,
  domain: c.HVWA_RANGE_DOMAIN as string, traefikContainer: c.HVWA_TRAEFIK_CONTAINER, runtime: c.HVWA_RANGE_RUNTIME,
}));

export type WardenConfig = z.output<typeof schema>;

export function loadWardenConfig(env: Record<string, string | undefined> = process.env):
  { ok: true; config: WardenConfig } | { ok: false; errors: string[] } {
  const r = schema.safeParse(env);
  if (r.success) return { ok: true, config: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message.replace(/\s+/g, ' ')}`) };
}
