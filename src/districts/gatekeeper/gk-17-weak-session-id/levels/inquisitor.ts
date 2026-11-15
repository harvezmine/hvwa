import type { LabState } from '../model.js';

const MASK = (1n << 48n) - 1n;

// INQUISITOR — real-looking tokens, wrong generator: a 48-bit linear congruential generator
// (the constants java.util.Random uses), and the token is the top 32 bits of its state.
// Hiding the low 16 bits looks like protection, but an LCG's outputs are not independent:
// two of your own tokens that were issued with the admin's in between (the one you get on
// arrival and the one you get at login) leave only 65 536 candidates for the hidden bits,
// and stepping the generator once more gives the admin's token.
// The cure is a cryptographically secure generator (see divine.ts), not a bigger LCG.
export function mint(state: LabState, _username: string, _nowMs: number): string {
  state.lcg = (state.lcg * 0x5DEECE66Dn + 0xBn) & MASK;
  return (state.lcg >> 16n).toString(16).padStart(8, '0');
}

export const showsLoginTime = false;
