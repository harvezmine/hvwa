// safeNext(): where /login may send the browser after a sign-in. Only a same-origin LOCAL path passes; every
// open-redirect shape (scheme, protocol-relative, backslash, encoded variants, CR/LF, control or non-ASCII
// characters) falls back to '/'.
import { describe, it, expect } from 'vitest';
import { safeNext } from '../src/auth/next.js';

describe('safeNext: accepted local paths', () => {
  it.each([
    ['/', '/'],
    ['/c/GK-01', '/c/GK-01'],
    ['/c/GK-01?lang=en&r=wrong', '/c/GK-01?lang=en&r=wrong'],
    ['/d/gatekeeper/sqli-login?level=templar', '/d/gatekeeper/sqli-login?level=templar'],
    ['/scoreboard#top', '/scoreboard#top'],
    ['/account/password', '/account/password'],
    ['/a/../scoreboard', '/scoreboard'], // normalised, still local
    ['/@evil.example', '/@evil.example'], // a path segment, not an authority
    ['/c/GK-01?next=//evil.example', '/c/GK-01?next=//evil.example'], // only the path decides where we go
  ])('%j -> %j', (raw, expected) => {
    expect(safeNext(raw)).toBe(expected);
  });
});

describe('safeNext: everything else falls back to /', () => {
  it.each([
    // not a string / empty
    undefined, null, 42, ['/c/GK-01'], { path: '/c/GK-01' }, '',
    // protocol-relative and its spellings
    '//evil.example', '//evil.example/c/GK-01', '///evil.example', '////evil.example',
    // backslashes (browsers read them as slashes)
    '/\\evil.example', '\\\\evil.example', '\\/evil.example', '/\\/evil.example', '/c\\GK-01',
    // schemes and relative references
    'https://evil.example', 'http://evil.example/', 'HTTPS://evil.example', 'https:evil.example',
    'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'evil.example', 'c/GK-01', '.', '?x=1', '#x',
    // percent-encoded variants (once and twice)
    '%2F%2Fevil.example', '/%2F%2Fevil.example', '/%2fevil.example', '/%5Cevil.example', '/%5cevil.example',
    '%5C%5Cevil.example', '/%252F%252Fevil.example', '/%25252F%25252Fevil.example', '/%255Cevil.example',
    // CR/LF (header injection) and other control characters, raw and encoded
    '/\r\nSet-Cookie: x=1', '/c/GK-01\n', '/\rx', '/%0d%0aSet-Cookie:%20x=1', '/%0AX', '/x%00', '/\tevil', '/%09/evil.example',
    '/\u0000', '/\u007f',
    // spaces and non-ASCII look-alikes (division slash, fullwidth solidus)
    '/ /evil.example', ' /c/GK-01', '/c/GK-01 ', '/∕∕evil.example', '/／／evil.example', '/café',
    // malformed percent-encoding
    '/%', '/%zz', '/%E0%A4%A',
    // the sign-in pages themselves (no loop)
    '/login', '/login?next=/c/GK-01', '/LOGIN', '/login/', '/logout',
    // absurdly long
    `/${'a'.repeat(2100)}`,
  ])('%j -> /', (raw) => {
    expect(safeNext(raw)).toBe('/');
  });

  it('never returns anything but a single-slash local path', () => {
    const samples = ['//x', '/\\x', 'http://x', '/%2F%2Fx', '/ok', '/%0d%0a', '/c/GK-01?a=b'];
    for (const s of samples) {
      const out = safeNext(s);
      expect(out.startsWith('/'), s).toBe(true);
      expect(out.startsWith('//'), s).toBe(false);
      expect(out).not.toMatch(/[\\\s\u0000-\u001f\u007f]/);
      expect(new URL(out, 'http://hvwa.invalid').origin).toBe('http://hvwa.invalid');
    }
  });
});
