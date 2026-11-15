import { describe, it, expect } from 'vitest';
import { issueFlag, verifyFlag } from '../src/core/flags.js';
describe('flags', () => {
  it('is deterministic per (challenge, session) and rejects cross-session flags', () => {
    const a = issueFlag('GK-01', 'sessA');
    expect(a).toMatch(/^HVWA\{[0-9a-f]{32}\}$/);
    expect(issueFlag('GK-01', 'sessA')).toBe(a);
    expect(verifyFlag('GK-01', 'sessA', a)).toBe(true);
    expect(verifyFlag('GK-01', 'sessB', a)).toBe(false);
  });
});
