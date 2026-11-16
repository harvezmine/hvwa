// src/districts/_shared/url.spec.ts — URL plumbing for the labs of every district.
import { describe, it, expect } from 'vitest';
import { withParams } from './url.js';

describe('withParams (how an authorization server appends the code to a redirect_uri)', () => {
  it('starts or extends the query', () => {
    expect(withParams('http://citadel.test/callback', { code: 'c1' })).toBe('http://citadel.test/callback?code=c1');
    expect(withParams('http://citadel.test/callback?a=1', { code: 'c1', state: 's 1' })).toBe('http://citadel.test/callback?a=1&code=c1&state=s+1');
  });

  it('puts the params before a fragment and keeps the fragment as given (after it, the code would never be sent)', () => {
    expect(withParams('http://attacker.test/cb#top', { code: 'c1' })).toBe('http://attacker.test/cb?code=c1#top');
    expect(withParams('http://attacker.test/cb?a=1#top', { code: 'c1' })).toBe('http://attacker.test/cb?a=1&code=c1#top');
    expect(withParams('http://attacker.test/cb#a?b#c', { code: 'c1' })).toBe('http://attacker.test/cb?code=c1#a?b#c');
    expect(withParams('http://attacker.test/cb#', { code: 'c1' })).toBe('http://attacker.test/cb?code=c1#');
  });
});
