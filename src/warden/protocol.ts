// src/warden/protocol.ts — the warden's API contract, shared by the warden (src/warden/server.ts) and the portal's client
// (src/range/warden-client.ts). The portal passes only what identifies an instance; the container's configuration is
// fixed inside the warden (template.ts) and nothing here can change it (spec range §3, §7; plan decision D1).
import { z } from 'zod';
import { LEVELS } from '../core/levels.js';
import { LAB_ID_RE } from '../lab-registry.js';
import { INSTANCE_ID_RE } from '../range/ids.js';

/** A range flag (spec §6): HVWA{ + 26 base32 characters + }. */
export const RANGE_FLAG_RE = /^HVWA\{[a-z2-7]{26}\}$/;
/** Shortest HVWA_WARDEN_SECRET. */
export const WARDEN_SECRET_MIN = 32;

/**
 * POST /v1/instances. `userId` and `expiresAt` only become container labels. `.strict()`: an image, a mount, a port or
 * any HostConfig key is refused, not ignored. A flag is required below Divine and refused at Divine (spec §6).
 */
export const launchRequestSchema = z.object({
  labId: z.string().regex(LAB_ID_RE),
  level: z.enum(LEVELS),
  instanceId: z.string().regex(INSTANCE_ID_RE),
  flag: z.string().regex(RANGE_FLAG_RE).optional(),
  userId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict().refine((r) => (r.level === 'divine') === (r.flag === undefined), {
  message: 'a flag is required below Divine and refused at Divine', path: ['flag'],
});
export type LaunchRequest = z.infer<typeof launchRequestSchema>;

export const HEALTH_STATUSES = Object.freeze(['starting', 'ready', 'failed', 'missing'] as const);
export type HealthStatus = (typeof HEALTH_STATUSES)[number];
export const instanceHealthSchema = z.object({ status: z.enum(HEALTH_STATUSES), reason: z.string().max(40).optional() }).strict();
export type InstanceHealth = z.infer<typeof instanceHealthSchema>;

export const listedInstanceSchema = z.object({
  instanceId: z.string().regex(INSTANCE_ID_RE),
  labId: z.string().max(10),
  level: z.string().max(20),
  userId: z.number().int(),
  expiresAt: z.number().int(),
  state: z.string().max(20),
}).strict();
export type ListedInstance = z.infer<typeof listedInstanceSchema>;
export const listResponseSchema = z.object({ instances: z.array(listedInstanceSchema) }).strict();

/** What the portal needs from the warden (src/range/warden-client.ts over HTTP; tests/support/fake-warden.ts in tests). */
export interface WardenApi {
  /** Create the network, the container (fixed template), connect Traefik, start. Resolves when started. */
  launch(req: LaunchRequest): Promise<void>;
  /** Remove the container, disconnect Traefik, remove the network. Idempotent. */
  stop(instanceId: string): Promise<void>;
  /** Every container labelled hvwa.range=1. */
  list(): Promise<ListedInstance[]>;
  /** The container's state as the portal needs it: starting, ready (health check passed), failed (reason), missing. */
  health(instanceId: string): Promise<InstanceHealth>;
}

/** Codes a warden call can fail with; the portal stores them as an instance's failure reason. */
export const WARDEN_ERROR_CODES = Object.freeze(
  ['bad_request', 'unknown_lab', 'bad_level', 'exists', 'docker', 'unauthorized', 'unavailable'] as const);
export type WardenErrorCode = (typeof WARDEN_ERROR_CODES)[number];

export class WardenError extends Error {
  constructor(readonly code: WardenErrorCode, readonly status: number) {
    super(`warden: ${code}`);
    this.name = 'WardenError';
  }
}
