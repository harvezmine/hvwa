// src/range/flags.ts — range flags (spec range §6): HVWA{<base32 of HMAC-SHA256(rangeKey, "flag|id|lab|level")>[:26]}.
// Derived per instance, so a flag copied from someone else never matches the submitter's own instances. The key lives
// only in the portal; an instance record keeps flagHash(flag), never the flag.
import { createHash, createHmac } from 'node:crypto';
import type { Level } from '../core/levels.js';
import { RANGE_FLAG_RE } from '../warden/protocol.js';
import { base32 } from './ids.js';

export { RANGE_FLAG_RE };

export function rangeFlag(rangeKey: string, instanceId: string, labId: string, level: Level): string {
  if (level === 'divine') throw new Error('rangeFlag: Divine has no flag (the secure reference)');
  const mac = createHmac('sha256', rangeKey).update(`flag|${instanceId}|${labId}|${level}`).digest();
  return `HVWA{${base32(mac).slice(0, 26)}}`;
}

/** Hex SHA-256 of a flag: what range_instances.flag_hash holds and a submission is compared by. */
export function flagHash(flag: string): string {
  return createHash('sha256').update(flag, 'utf8').digest('hex');
}
