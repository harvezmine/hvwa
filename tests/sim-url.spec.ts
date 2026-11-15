// classifySimUrl: the ground truth for "where did the simulated victim's browser actually go" (src/core/sim.ts).
// Parsing is the WHATWG URL parser (what browsers use), so every trick below resolves exactly as in a browser.
import { describe, it, expect } from 'vitest';
import { classifySimUrl, labHref, SIM_LIMITS, type SimSite } from '../src/core/sim.js';

const site = (u: string, base?: string): SimSite => classifySimUrl(u, base).site;

describe('classifySimUrl: the two hosts', () => {
  it.each([
    ['http://citadel.test/', 'citadel'],
    ['http://citadel.test/callback?code=1', 'citadel'],
    ['https://citadel.test/a', 'citadel'],
    ['HTTP://CITADEL.TEST/Path', 'citadel'],
    ['http://attacker.test/', 'attacker'],
    ['http://attacker.test/x?y=1', 'attacker'],
    ['https://attacker.test/', 'attacker'],
    ['http://evil.attacker.test/', 'attacker'],
    ['http://a.b.c.attacker.test/', 'attacker'],
  ] as const)('%s -> %s', (u, want) => {
    expect(site(u)).toBe(want);
  });

  it('gives path, query (parsed) and the URL a server would see', () => {
    const c = classifySimUrl('http://citadel.test/callback?code=abc&state=x%20y#frag');
    expect(c).toMatchObject({ site: 'citadel', host: 'citadel.test', path: '/callback', search: '?code=abc&state=x%20y' });
    expect(c.query.get('code')).toBe('abc');
    expect(c.query.get('state')).toBe('x y');
    expect(c.url).toBe('http://citadel.test/callback?code=abc&state=x%20y'); // the fragment is never sent
    expect(c.origin).toBe('http://citadel.test');
  });
});

describe('classifySimUrl: look-alike hosts', () => {
  it('attacker.test as a SUBDOMAIN of citadel.test is not the citadel (nothing listens there)', () => {
    expect(classifySimUrl('http://attacker.test.citadel.test/')).toMatchObject({ site: 'other', reason: 'host' });
  });

  it('citadel.test as a subdomain of attacker.test is the attacker', () => {
    expect(site('http://citadel.test.attacker.test/')).toBe('attacker');
  });

  it('suffix tricks are other: xattacker.test, attacker.testx, citadel.test.evil, www.citadel.test', () => {
    for (const u of ['http://xattacker.test/', 'http://attacker.testx/', 'http://citadel.test.evil/', 'http://www.citadel.test/', 'http://citadel-test/']) {
      expect(classifySimUrl(u), u).toMatchObject({ site: 'other', reason: 'host' });
    }
  });

  it('empty labels are other (no DNS name has them): attacker..test, x..attacker.test, .attacker.test, two trailing dots', () => {
    for (const u of ['http://attacker..test/', 'http://x..attacker.test/', 'http://.attacker.test/', 'http://attacker.test../']) {
      expect(classifySimUrl(u), u).toMatchObject({ site: 'other', reason: 'host' });
    }
  });

  it('localhost and unknown hosts are other', () => {
    expect(classifySimUrl('http://localhost:3000/d/gatekeeper/x')).toMatchObject({ site: 'other', reason: 'host' });
    expect(classifySimUrl('http://example.com/')).toMatchObject({ site: 'other', reason: 'host' });
  });
});

describe('classifySimUrl: userinfo never decides the site', () => {
  it('http://citadel.test@attacker.test/ goes to attacker.test (the host is after the @), as in every browser', () => {
    const c = classifySimUrl('http://citadel.test@attacker.test/x');
    expect(c).toMatchObject({ site: 'attacker', host: 'attacker.test', userinfo: true });
    expect(c.url).toBe('http://attacker.test/x'); // userinfo is never sent to the server
  });

  it('user:password, a port-looking password and encoded slashes in userinfo: still the host after @', () => {
    expect(classifySimUrl('http://citadel.test:1234@attacker.test/')).toMatchObject({ site: 'attacker', userinfo: true });
    expect(classifySimUrl('http://citadel.test%2F@attacker.test/')).toMatchObject({ site: 'attacker', userinfo: true });
    expect(classifySimUrl('http://citadel.test%5C@attacker.test/')).toMatchObject({ site: 'attacker', userinfo: true });
    expect(classifySimUrl('http://admin:pw@citadel.test/')).toMatchObject({ site: 'citadel', userinfo: true, url: 'http://citadel.test/' });
  });

  it('no userinfo: userinfo is false', () => {
    expect(classifySimUrl('http://citadel.test/').userinfo).toBe(false);
  });
});

describe('classifySimUrl: case, trailing dot, ports', () => {
  it('upper case and ONE trailing dot are the same host', () => {
    expect(classifySimUrl('http://ATTACKER.TEST./')).toMatchObject({ site: 'attacker', host: 'attacker.test' });
    expect(classifySimUrl('http://Citadel.Test./x')).toMatchObject({ site: 'citadel', host: 'citadel.test', path: '/x' });
    expect(classifySimUrl('http://ATTACKER.test.:8080/p')).toMatchObject({ site: 'attacker', host: 'attacker.test' });
  });

  it('attacker.test answers on any port; citadel.test only on its scheme\'s default port', () => {
    expect(site('http://attacker.test:8080/x')).toBe('attacker');
    expect(site('http://attacker.test:1/')).toBe('attacker');
    expect(site('http://citadel.test:80/')).toBe('citadel');
    expect(site('https://citadel.test:443/')).toBe('citadel');
    expect(classifySimUrl('http://citadel.test:8080/')).toMatchObject({ site: 'other', reason: 'port' });
    expect(classifySimUrl('http://citadel.test:443/')).toMatchObject({ site: 'other', reason: 'port' });
    expect(classifySimUrl('https://citadel.test:80/')).toMatchObject({ site: 'other', reason: 'port' });
  });

  it('an out-of-range port is not a URL', () => {
    expect(classifySimUrl('http://attacker.test:65536/')).toMatchObject({ site: 'other', reason: 'invalid' });
  });
});

describe('classifySimUrl: IP literals and non-http schemes are other', () => {
  it.each([
    'http://127.0.0.1/', 'http://10.0.0.1/', 'http://0x7f.1/', 'http://2130706433/', 'http://1.2.3/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'https://[2001:db8::1]:8443/',
  ])('%s -> other (ip)', (u) => {
    expect(classifySimUrl(u)).toMatchObject({ site: 'other', reason: 'ip' });
  });

  it.each([
    'javascript:alert(1)', 'JaVaScRiPt:alert(document.cookie)', ' javascript:alert(1)', 'java\tscript:alert(1)',
    'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'ftp://attacker.test/', 'mailto:admin@citadel.test',
    'blob:http://citadel.test/x', 'ws://attacker.test/',
  ])('%s -> other (scheme)', (u) => {
    expect(classifySimUrl(u)).toMatchObject({ site: 'other', reason: 'scheme' });
  });

  it.each(['', 'not a url', '//attacker.test/x', '/relative', 'http://', 'http://attacker.test.1/', 'http://[::1/'])(
    'unparsable without a base: %j -> other (invalid)', (u) => {
      expect(classifySimUrl(u)).toMatchObject({ site: 'other', reason: 'invalid', url: '' });
    });

  it('non-string input is other (invalid), never a throw', () => {
    for (const bad of [undefined, null, 42, {}, ['http://attacker.test/']]) {
      expect(classifySimUrl(bad as never)).toMatchObject({ site: 'other', reason: 'invalid' });
    }
  });
});

describe('classifySimUrl: WHATWG parsing tricks resolve as in a browser', () => {
  it('a backslash ends the authority in http(s) URLs', () => {
    expect(classifySimUrl('http://attacker.test\\@citadel.test/')).toMatchObject({ site: 'attacker', path: '/@citadel.test/' });
    expect(classifySimUrl('http://citadel.test\\@attacker.test/')).toMatchObject({ site: 'citadel', path: '/@attacker.test/' });
    expect(classifySimUrl('http:\\\\attacker.test\\x')).toMatchObject({ site: 'attacker', path: '/x' });
    expect(classifySimUrl('http://citadel.test\\.attacker.test/')).toMatchObject({ site: 'citadel' });
  });

  it('relative references resolve against a base: /\\host and //host leave the citadel', () => {
    const base = 'http://citadel.test/callback?code=1';
    expect(classifySimUrl('/\\attacker.test/x', base)).toMatchObject({ site: 'attacker', path: '/x' });
    expect(classifySimUrl('//attacker.test/x', base)).toMatchObject({ site: 'attacker' });
    expect(classifySimUrl('/home?next=1', base)).toMatchObject({ site: 'citadel', path: '/home', search: '?next=1' });
    expect(classifySimUrl('x/y', 'http://citadel.test/a/b')).toMatchObject({ site: 'citadel', path: '/a/x/y' });
  });

  it('tabs and newlines inside, and spaces around, are stripped', () => {
    expect(site('http://atta\tcker.test/')).toBe('attacker');
    expect(site('http://atta\ncker.test/')).toBe('attacker');
    expect(site('  http://attacker.test/  ')).toBe('attacker');
  });

  it('percent-encoded hosts are decoded', () => {
    expect(classifySimUrl('http://attacker%2etest/')).toMatchObject({ site: 'attacker', host: 'attacker.test' });
  });

  it('IDN: full-width forms and ideographic dots map to ASCII (UTS #46); other scripts become xn-- labels', () => {
    expect(site('http://ａｔｔａｃｋｅｒ.test/')).toBe('attacker'); // full-width "attacker"
    expect(site('http://attacker。test/')).toBe('attacker');                                   // ideographic full stop
    expect(site('http://ｃｉｔａｄｅｌ.test/')).toBe('citadel');
    expect(classifySimUrl('http://citadel.tеst/')).toMatchObject({ site: 'other', reason: 'host' }); // Cyrillic e
    expect(classifySimUrl('http://аttacker.test/')).toMatchObject({ site: 'other', reason: 'host' }); // Cyrillic a
  });

  it('dot segments are resolved in the path', () => {
    expect(classifySimUrl('http://citadel.test/a/../b/./c').path).toBe('/b/c');
    expect(classifySimUrl('http://citadel.test/%2e%2e/x').path).toBe('/x');
  });
});

describe('classifySimUrl: length cap', () => {
  it(`more than ${SIM_LIMITS.urlLength} characters is other (too-long), before or after serialization`, () => {
    const pad = (n: number) => 'a'.repeat(n);
    const ok = `http://attacker.test/${pad(SIM_LIMITS.urlLength - 'http://attacker.test/'.length)}`;
    expect(ok.length).toBe(SIM_LIMITS.urlLength);
    expect(site(ok)).toBe('attacker');
    expect(classifySimUrl(`${ok}a`)).toMatchObject({ site: 'other', reason: 'too-long' });
    // Short input, long serialization: every "<" becomes "%3C".
    const grows = `http://attacker.test/?${'<'.repeat(1000)}`;
    expect(grows.length).toBeLessThan(SIM_LIMITS.urlLength);
    expect(classifySimUrl(grows)).toMatchObject({ site: 'other', reason: 'too-long' });
    expect(classifySimUrl('x'.repeat(1_000_000))).toMatchObject({ site: 'other', reason: 'too-long' });
  });
});

describe('labHref(url, base, level): a citadel URL as a link into the real lab', () => {
  const base = '/d/gatekeeper/demo';
  it('maps http://citadel.test/<path>?<query> to <lab>/<path>?<query>&level=<level>', () => {
    expect(labHref(classifySimUrl('http://citadel.test/reset?token=a%20b'), base, 'templar'))
      .toBe('/d/gatekeeper/demo/reset?token=a+b&level=templar');
    expect(labHref(classifySimUrl('http://citadel.test/'), base, 'acolyte')).toBe('/d/gatekeeper/demo?level=acolyte');
    expect(labHref(classifySimUrl('http://citadel.test/?tab=1&level=divine'), base, 'acolyte')).toBe('/d/gatekeeper/demo?tab=1&level=acolyte');
  });

  it('a path that looks protocol-relative stays under the lab', () => {
    expect(labHref(classifySimUrl('http://citadel.test//attacker.test/x'), base, 'acolyte')).toBe('/d/gatekeeper/demo//attacker.test/x?level=acolyte');
  });

  it('is undefined for anything but the citadel', () => {
    for (const u of ['http://attacker.test/', 'javascript:alert(1)', 'http://127.0.0.1/', 'nope']) {
      expect(labHref(classifySimUrl(u), base, 'acolyte'), u).toBeUndefined();
    }
  });
});
