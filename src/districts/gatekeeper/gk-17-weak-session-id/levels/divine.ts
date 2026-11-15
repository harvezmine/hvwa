import { randomBytes } from 'node:crypto';
import type { LabState } from '../model.js';

// DIVINE — secure reference: 32 bytes (256 bits) from the operating system's CSPRNG, hex
// encoded. Nothing about a token (order, time, username, other tokens) says anything about
// any other token, and it is not derived from anything an attacker can see.
// Out of scope here: a production system would also give sessions an expiry, rotate the id
// at login (against fixation), mark the cookie Secure/HttpOnly/SameSite, and bind it
// server-side to the client where that makes sense.
export function mint(_state: LabState, _username: string): string {
  return randomBytes(32).toString('hex');
}

export const showsLoginTime = false;
