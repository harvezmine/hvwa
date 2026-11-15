import { isPlainObject, type User } from '../model.js';
import type { Result } from '../../_shared/lab.js';

// DIVINE — an explicit allowlist DTO (displayName, bio, email). The role is never read from the
// request and never derived from anything the user can edit: it only changes on the server side.
// An email change is not applied: it is held as pending until the address is verified (simulated:
// the page shows the pending address, no mail is sent).
// Out of scope here: a production system would send the verification mail, expire pending changes,
// audit role changes and rate limit profile updates.
const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,100}$/;

export function applyUpdate(user: User, body: unknown): Result {
  if (!isPlainObject(body)) return { ok: true, text: 'Profile updated.' };
  if (typeof body.displayName === 'string') user.displayName = body.displayName.slice(0, 80);
  if (typeof body.bio === 'string') user.bio = body.bio.slice(0, 500);
  if (typeof body.email === 'string' && body.email !== user.email) {
    if (!EMAIL.test(body.email)) return { ok: false, text: 'Invalid email address.' };
    user.pendingEmail = body.email; // held until verified
    return { ok: true, text: 'Profile updated. The new email is pending verification and has not been applied.' };
  }
  return { ok: true, text: 'Profile updated.' };
}
