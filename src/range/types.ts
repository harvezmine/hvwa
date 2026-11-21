// src/range/types.ts — the shapes the range portal's modules share (src/range/index.ts composes them).
// Compact POC (plan amendment, spec §16): no Extend and no separate ceiling, no FIFO queue, no event code.
import type { DatabaseSync } from 'node:sqlite';
import type { PlatformAuth } from '../auth/index.js';
import type { LabRegistry } from '../lab-registry.js';

/** Spec §5's limits in ms (src/range/config.ts reads them from HVWA_RANGE_* minutes). */
export interface RangeLimits {
  /** HVWA_RANGE_CAPACITY: running instances at most; beyond it a launch answers `full` (no queue). */
  readonly capacity: number;
  /** HVWA_RANGE_IDLE_MIN: an instance nobody has used for this long is stopped. */
  readonly idleMs: number;
  /** HVWA_RANGE_MAX_MIN: the hard maximum lifetime from start (the gate cookie expires then too). */
  readonly maxMs: number;
  /** A start that has not passed its health check by then fails (start_timeout). */
  readonly startTimeoutMs: number;
}

/** The defaults of src/range/config.ts: capacity 140, idle 20 min, lifetime 60 min; a start gets 90 s. */
export const DEFAULT_LIMITS: RangeLimits = Object.freeze({
  capacity: 140, idleMs: 20 * 60_000, maxMs: 60 * 60_000, startTimeoutMs: 90_000,
});

/** createApp's `range` option (portal mode); src/range/options.ts builds it from the environment. */
export interface RangePortalOptions {
  /** HVWA_RANGE_DOMAIN: instances live at i-<instanceId>.<domain> (one level: Cloudflare's Universal SSL covers it). */
  readonly domain: string;
  /** HVWA_PORTAL_HOST: the portal's public host name. */
  readonly portalHost: string;
  /**
   * HVWA_RANGE_PUBLIC_SCHEME: what the browser uses. Default 'https' (TLS ends at Cloudflare); 'http' for local runs.
   * Portal mode's login follows it: the forms' Origin check, and Secure on hvwa_auth exactly when it is https.
   */
  readonly publicScheme?: 'http' | 'https';
  /** HVWA_RANGE_PUBLIC_PORT: the port of public URLs when it is not the scheme's default (local runs). */
  readonly publicPort?: number;
  /** HVWA_FORWARD_AUTH_HOST: the only Host /__hvwa/auth answers on (Traefik calls http://portal:1337/__hvwa/auth). */
  readonly internalHost: string;
  readonly registry: LabRegistry;
  readonly limits: RangeLimits;
  /** HVWA_REGISTRATION_OPEN (RangeConfig.registrationOpen): false closes /register. Default true. */
  readonly registrationOpen?: boolean;
  /** Secure on the range's cookies (hvwa_gate): true when the public scheme is https (src/range/options.ts). */
  readonly secureCookies?: boolean;
  /** Clock (ms); tests inject one. */
  readonly now?: () => number;
}

/** What every range router gets. */
export interface RangeContext {
  readonly db: DatabaseSync;
  readonly auth: PlatformAuth;
  readonly opts: RangePortalOptions;
  readonly registry: LabRegistry;
  readonly now: () => number;
}
