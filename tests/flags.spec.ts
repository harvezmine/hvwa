import { describe, it, expect, beforeAll } from 'vitest';
import { issueFlag, verifyFlag, setFlagSecret } from '../src/core/flags.js';

describe('flags', () => {
  beforeAll(() => setFlagSecret('test-secret'));

  it('is deterministic per (challenge, session) and rejects cross-session flags', () => {
    const a = issueFlag('GK-01', 'sessA');
    expect(a).toMatch(/^HVWA\{[0-9a-f]{32}\}$/);
    expect(issueFlag('GK-01', 'sessA')).toBe(a);
    expect(verifyFlag('GK-01', 'sessA', a)).toBe(true);
    expect(verifyFlag('GK-01', 'sessB', a)).toBe(false);
  });

  it('depends on the configured secret', () => {
    const a = issueFlag('GK-01', 'sessA');
    setFlagSecret('another-secret');
    expect(issueFlag('GK-01', 'sessA')).not.toBe(a);
    setFlagSecret('test-secret');
  });
});
