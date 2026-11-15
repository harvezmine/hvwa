// src/core/flags.ts
import { createHmac, timingSafeEqual } from 'node:crypto';

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

export function issueFlag(challengeId: string, sessionId: string): string {
  const mac = createHmac('sha256', secret())
    .update(`${challengeId}|${sessionId}`).digest('hex').slice(0, 32);
  return `HVWA{${mac}}`;
}
export function verifyFlag(challengeId: string, sessionId: string, submission: string): boolean {
  const expected = Buffer.from(issueFlag(challengeId, sessionId));
  const got = Buffer.from((submission ?? '').trim());
  return expected.length === got.length && timingSafeEqual(expected, got);
}
