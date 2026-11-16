// src/districts/relic-market/_shared/staff-code.ts — the "redeem the secret" step of the blind SQL labs (RM-02 staff
// code, RM-03 vault PIN), with the partial views/staff-code.ejs. Plumbing, not a lesson: the flaw is how the secret is
// read out (levels/*.ts). Not a challenge: nothing here is served by View Source.
//
// Deliberately no limiter: an 8- or 6-hex-character code is no brute-force target over HTTP, and these labs teach
// extraction, not guessing (their specs say so).
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { flagFor } from '../../../core/mount.js';
import type { Challenge } from '../../../core/registry.js';
import type { Result } from '../../_shared/result.js';

/**
 * Check a redeemed code against this lab's secret (timing-safe, on equal-length buffers). Below Divine the right code
 * earns the flag: `<Noun> accepted. Flag: …`; at Divine `<Noun> accepted.`; anything else `Invalid <noun>.`.
 */
export function redeemCode(
  req: Pick<Request, 'sessionId' | 'level'>, challenge: Pick<Challenge, 'id' | 'levels'>,
  secret: string, input: string, noun: string,
): Result {
  const want = Buffer.from(secret, 'utf8');
  const got = Buffer.from(input, 'utf8');
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, text: `Invalid ${noun}.` };
  const accepted = `${noun.charAt(0).toUpperCase()}${noun.slice(1)} accepted.`;
  return { ok: true, text: req.level === 'divine' ? accepted : `${accepted} Flag: ${flagFor(req, challenge)}` };
}
