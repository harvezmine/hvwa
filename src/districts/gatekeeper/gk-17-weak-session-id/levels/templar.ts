import { createHash } from 'node:crypto';
import type { LabState } from '../model.js';

// TEMPLAR — naive "hashing": the id looks random but is md5(username + login time in epoch
// seconds), both of which an attacker knows or can read. The "recent activity" panel even
// prints when the admin signed in, so the admin's token can be computed offline.
export function mint(_state: LabState, username: string, nowMs: number): string {
  const epochSeconds = Math.floor(nowMs / 1000);
  return createHash('md5').update(`${username}${epochSeconds}`).digest('hex');
}

export const showsLoginTime = true;
