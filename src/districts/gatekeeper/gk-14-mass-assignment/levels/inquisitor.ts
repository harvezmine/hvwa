import { isPlainObject, type User } from '../model.js';
import type { Result } from '../../_shared/lab.js';

// INQUISITOR — a strict allowlist (displayName, bio, email): nothing else in the body is read.
// The flaw is in what the record DERIVES: the role follows the email domain ("@citadel.admin" is
// staff), and an email change is applied at once, with no proof that the address is yours.
const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,100}$/;

export const notice = 'Questions about your membership? Write to the steward at steward@citadel.admin.';
export function applyUpdate(user: User, body: unknown): Result {
  if (!isPlainObject(body)) return { ok: true, text: 'Profile updated.' };
  if (typeof body.displayName === 'string') user.displayName = body.displayName.slice(0, 80);
  if (typeof body.bio === 'string') user.bio = body.bio.slice(0, 500);
  if (typeof body.email === 'string') {
    if (!EMAIL.test(body.email)) return { ok: false, text: 'Invalid email address.' };
    user.email = body.email; // applied without verification
  }
  user.role = String(user.email).toLowerCase().endsWith('@citadel.admin') ? 'admin' : 'user'; // derived from an unverified attribute
  return { ok: true, text: 'Profile updated.' };
}
