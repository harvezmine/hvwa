import { describe, it, expect, beforeAll } from 'vitest';
import {
  defineChallenge, register, getChallenge, allChallenges, type Challenge,
} from '../src/core/registry.js';
import { issueFlag, setFlagSecret } from '../src/core/flags.js';
import { TEST_SECRET } from './helpers.js';

type Input = Parameters<typeof defineChallenge>[0];

// Unique ids/slugs per call: the registry is a module-level singleton.
let seq = 10;
function input(over: Partial<Input> = {}): Input {
  const n = seq++;
  return {
    id: `RV-${n}`, district: 'test-district', slug: `fixture-${n}`,
    title: { id: 't', en: 't' }, summary: { id: 's', en: 's' }, maps: ['A01:2025'],
    levels: ['acolyte', 'divine'], hints: [], mount: () => {},
    ...over,
  };
}

describe('defineChallenge', () => {
  beforeAll(() => setFlagSecret(TEST_SECRET));

  it('accepts valid metadata and defaults points to 100', () => {
    const c: Challenge = defineChallenge(input({ check: () => true }));
    expect(c.points).toBe(100);
  });

  it('defaults check() to verifying the level-bound flag', async () => {
    const c = defineChallenge(input({ id: 'GK-99', levels: ['acolyte', 'templar'] }));
    const flag = issueFlag('GK-99', 's1', 'templar');
    expect(await c.check({ sessionId: 's1', level: 'templar', submission: flag })).toBe(true);
    expect(await c.check({ sessionId: 's1', level: 'acolyte', submission: flag })).toBe(false);
  });

  it.each(['gk-01', 'GK-1', 'GKX-01', 'GK-001', 'G1-01', ''])('rejects bad id %j', (id) => {
    expect(() => defineChallenge(input({ id }))).toThrow(/bad challenge id/);
  });

  it.each(['Bad_Slug', '-x', 'x-', 'a--b', '', 'x/y', '../x', 'UPPER', 'sp ace'])(
    'rejects bad slug %j', (slug) => {
      expect(() => defineChallenge(input({ slug }))).toThrow(/slug/);
    });

  it.each(['Gate Keeper', 'gk/x', 'Gatekeeper', '', 'gk_x'])('rejects bad district %j', (district) => {
    expect(() => defineChallenge(input({ district }))).toThrow(/district/);
  });

  it('rejects empty levels', () => {
    expect(() => defineChallenge(input({ levels: [] }))).toThrow(/has no levels/);
  });

  it('rejects unknown levels', () => {
    expect(() => defineChallenge(input({ levels: ['acolyte', 'god' as never] }))).toThrow(/unknown level/);
  });

  it('rejects duplicate levels', () => {
    expect(() => defineChallenge(input({ levels: ['acolyte', 'acolyte'] }))).toThrow(/duplicate level/);
  });

  it('requires at least one non-Divine level', () => {
    expect(() => defineChallenge(input({ levels: ['divine'] }))).toThrow(/non-Divine/);
  });

  it.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects points %j', (points) => {
    expect(() => defineChallenge(input({ points }))).toThrow(/points/);
  });

  it('rejects duplicate hint ids', () => {
    const hints = [
      { id: 1 as const, text: { id: 'a', en: 'a' }, cost: 10 },
      { id: 1 as const, text: { id: 'b', en: 'b' }, cost: 20 },
    ];
    expect(() => defineChallenge(input({ hints }))).toThrow(/duplicate hint/);
  });

  it.each([-1, 1.5, Number.NaN])('rejects hint cost %j', (cost) => {
    expect(() => defineChallenge(input({ hints: [{ id: 1, text: { id: 'a', en: 'a' }, cost }] })))
      .toThrow(/hint .*cost/);
  });

  it('accepts a zero-cost hint', () => {
    expect(() => defineChallenge(input({ hints: [{ id: 1, text: { id: 'a', en: 'a' }, cost: 0 }] })))
      .not.toThrow();
  });

  it('rejects hint ids outside 1..3', () => {
    expect(() => defineChallenge(input({ hints: [{ id: 4 as never, text: { id: 'a', en: 'a' }, cost: 1 }] })))
      .toThrow(/hint id/);
  });
});

describe('register', () => {
  it('registers, returns the challenge, and makes it findable', () => {
    const c = register(defineChallenge(input()));
    expect(getChallenge(c.id)).toBe(c);
    expect(allChallenges()).toContain(c);
  });

  it('rejects a duplicate id', () => {
    const c = defineChallenge(input());
    register(c);
    expect(() => register(defineChallenge(input({ id: c.id })))).toThrow(/duplicate challenge/);
  });

  it('rejects a repeated district/slug under a different id', () => {
    const c = register(defineChallenge(input()));
    expect(() => register(defineChallenge(input({ district: c.district, slug: c.slug }))))
      .toThrow(/duplicate route/);
  });

  it('validates objects that did not come from defineChallenge', () => {
    const raw = { ...defineChallenge(input()), slug: 'Not A Slug' } as Challenge;
    expect(() => register(raw)).toThrow(/slug/);
  });

  it('deep-freezes the challenge on register', () => {
    const c = register(defineChallenge(input({
      hints: [{ id: 1, text: { id: 'a', en: 'a' }, cost: 5 }],
    })));
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.levels)).toBe(true);
    expect(Object.isFrozen(c.hints[0])).toBe(true);
    expect(Object.isFrozen(c.title)).toBe(true);
    expect(() => { (c as { points: number }).points = 9999; }).toThrow(TypeError);
    expect(() => { (c.levels as string[]).push('divine'); }).toThrow(TypeError);
  });
});
