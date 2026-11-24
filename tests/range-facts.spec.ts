// The per-lab field notes (src/range/facts.ts): one bilingual note for each of the six labs, shown in the
// submit-result popup only after a solved / new-best seal.
import { describe, it, expect } from 'vitest';
import { LAB_FACTS, labFact } from '../src/range/facts.js';

describe('range facts', () => {
  it('covers all six labs with distinct, real EN and ID notes', () => {
    expect(Object.keys(LAB_FACTS)).toEqual(['r01', 'r02', 'r03', 'r04', 'r05', 'r06']);
    for (const [id, fact] of Object.entries(LAB_FACTS)) {
      expect(fact.en.length, `${id} en`).toBeGreaterThan(60);
      expect(fact.id.length, `${id} id`).toBeGreaterThan(60);
      expect(fact.en, `${id} must differ from id`).not.toBe(fact.id);
    }
    expect(new Set(Object.values(LAB_FACTS).map((f) => f.en)).size).toBe(6);
    expect(new Set(Object.values(LAB_FACTS).map((f) => f.id)).size).toBe(6);
  });

  it('returns undefined for an unknown lab id', () => {
    expect(labFact('r99')).toBeUndefined();
    expect(labFact('r01')).toEqual(LAB_FACTS.r01);
  });
});
