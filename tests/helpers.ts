// tests/helpers.ts — shared test utilities.
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';

/** Flag secret used by tests that pass one explicitly (>= 16 chars, like FLAG_SECRET). */
export const TEST_SECRET = 'hvwa-test-flag-secret';

function setCookieLines(res: request.Response): string[] {
  const raw: unknown = res.headers['set-cookie'];
  if (Array.isArray(raw)) return raw.map(String);
  return typeof raw === 'string' ? [raw] : [];
}

/** Full Set-Cookie line for cookie `name`, or undefined if the response did not set it. */
export function setCookieHeader(res: request.Response, name: string): string | undefined {
  return setCookieLines(res).find((line) => line.startsWith(`${name}=`));
}

/** Decoded value of cookie `name` from the response's Set-Cookie headers. */
export function setCookieValue(res: request.Response, name: string): string | undefined {
  const line = setCookieHeader(res, name);
  return line === undefined ? undefined : decodeURIComponent(line.slice(name.length + 1).split(';')[0]);
}

/**
 * A supertest agent on `app` (default: a fresh app with TEST_SECRET) whose
 * session is established by its first request; the sid is read from the
 * hvwa_sid cookie by name.
 */
export async function freshSession(app: Express = createApp({ flagSecret: TEST_SECRET })) {
  const agent = request.agent(app);
  const res = await agent.get('/healthz');
  const sid = setCookieValue(res, 'hvwa_sid');
  if (!sid) throw new Error('first response did not set hvwa_sid');
  return { app, agent, sid };
}
