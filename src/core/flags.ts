// src/core/flags.ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Level } from './registry.js';

const FLAG_LEVELS: ReadonlySet<string> = new Set(['acolyte', 'templar', 'inquisitor']);

// Configured once by createApp() (server: env/persisted secret; tests: explicit).
let flagSecret: string | undefined;

export function setFlagSecret(secret: string): void {
  if (!secret) throw new Error('flag secret must be a non-empty string');
  flagSecret = secret;
}

function secret(): string {
  if (!flagSecret) throw new Error('flag secret not configured (call createApp or setFlagSecret)');
  return flagSecret;
}

// One distinct flag per exploitable level. Divine is the secure reference
// implementation and never issues a flag.
export function issueFlag(challengeId: string, sessionId: string, level: Level): string {
  if (level === 'divine') throw new Error('Divine level never issues a flag');
  if (!FLAG_LEVELS.has(level)) throw new Error(`unknown level ${String(level)}`);
  const mac = createHmac('sha256', secret())
    .update(`${challengeId}|${sessionId}|${level}`).digest('hex').slice(0, 32);
  return `HVWA{${mac}}`;
}

export function verifyFlag(challengeId: string, sessionId: string, level: Level, submission: string): boolean {
  if (!FLAG_LEVELS.has(level)) return false; // includes divine
  const expected = Buffer.from(issueFlag(challengeId, sessionId, level));
  const got = Buffer.from(String(submission ?? '').trim());
  return expected.length === got.length && timingSafeEqual(expected, got);
}
