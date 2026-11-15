// src/core/flags.ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
export function issueFlag(challengeId: string, sessionId: string): string {
  const mac = createHmac('sha256', config.FLAG_SECRET)
    .update(`${challengeId}|${sessionId}`).digest('hex').slice(0, 32);
  return `HVWA{${mac}}`;
}
export function verifyFlag(challengeId: string, sessionId: string, submission: string): boolean {
  const expected = Buffer.from(issueFlag(challengeId, sessionId));
  const got = Buffer.from((submission ?? '').trim());
  return expected.length === got.length && timingSafeEqual(expected, got);
}
