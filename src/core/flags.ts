// src/core/flags.ts
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { FLAG_LEVELS, type Level } from './levels.js';

const isFlagLevel = (level: unknown): level is Level =>
  typeof level === 'string' && (FLAG_LEVELS as readonly string[]).includes(level);

// Process-wide secret. Defaults to a random value generated ONCE at module
// load (never a shared public default). createApp() overrides it only when
// given an explicit flagSecret; server.ts always passes the env/persisted one.
let flagSecret: string = randomBytes(32).toString('hex');

export function setFlagSecret(secret: string): void {
  if (!secret) throw new Error('flag secret must be a non-empty string');
  flagSecret = secret;
}

function secret(): string {
  return flagSecret;
}

// One distinct flag per exploitable level. Divine is the secure reference
// implementation and never issues a flag.
export function issueFlag(challengeId: string, sessionId: string, level: Level): string {
  if (level === 'divine') throw new Error('Divine level never issues a flag');
  if (!isFlagLevel(level)) throw new Error(`unknown level ${String(level)}`);
  const mac = createHmac('sha256', secret())
    .update(`${challengeId}|${sessionId}|${level}`).digest('hex').slice(0, 32);
  return `HVWA{${mac}}`;
}

export function verifyFlag(challengeId: string, sessionId: string, level: Level, submission: string): boolean {
  if (!isFlagLevel(level)) return false; // includes divine
  const expected = Buffer.from(issueFlag(challengeId, sessionId, level));
  const got = Buffer.from(String(submission ?? '').trim());
  return expected.length === got.length && timingSafeEqual(expected, got);
}
