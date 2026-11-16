import { describe, it, expect } from 'vitest';
import '../src/districts/index.js'; // registers everything
import { allChallenges } from '../src/core/registry.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG, DISTRICTS } from '../src/catalog.js';
import { renderCatalog } from '../src/tools/gen-catalog.js';
import { evaluateGate } from '../src/tools/gate-catalog.js';

const HEADER_COUNTS: Record<string, number> = {
  gatekeeper: 18, 'relic-market': 14, scriptorium: 20, 'forum-of-pilgrims': 12, 'archive-api': 15,
  oracle: 21, forge: 10, watchtower: 7, sanctum: 5,
};

describe('catalog data', () => {
  it('has exactly 122 rows with unique, well-formed ids', () => {
    expect(CATALOG).toHaveLength(122);
    const ids = CATALOG.map((r) => r.id);
    expect(new Set(ids).size).toBe(122);
    for (const id of ids) expect(id).toMatch(/^[A-Z]{2}-\d{2}$/);
  });

  it('matches each district table header count', () => {
    for (const [key, n] of Object.entries(HEADER_COUNTS)) {
      expect(CATALOG.filter((r) => r.district.key === key), key).toHaveLength(n);
    }
    expect(DISTRICTS.map((d) => d.key)).toEqual(Object.keys(HEADER_COUNTS));
  });

  it('is frozen and every row has a title, standard, phase 1-5 and known levels', () => {
    expect(Object.isFrozen(CATALOG)).toBe(true);
    for (const r of CATALOG) {
      expect(Object.isFrozen(r), r.id).toBe(true);
      expect(r.title.length, r.id).toBeGreaterThan(0);
      expect(r.standard.length, r.id).toBeGreaterThan(0);
      expect([1, 2, 3, 4, 5]).toContain(r.phase);
      for (const l of r.levels) expect(['acolyte', 'templar', 'inquisitor', 'divine']).toContain(l);
    }
  });
});

describe('catalog vs registry', () => {
  it('registry has no duplicate ids', () => {
    const ids = allChallenges().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every registered challenge has a catalog row in the same district', () => {
    for (const c of allChallenges()) {
      const row = CATALOG.find((r) => r.id === c.id);
      expect(row, `${c.id} missing from catalog`).toBeDefined();
      expect(row?.district.key, c.id).toBe(c.district);
    }
  });

  // Puzzle rows (WT-02/03) have no tiers in the catalog; the registry still needs >= 1 non-Divine level for them.
  it('registered levels equal the catalog levels (puzzle rows excepted)', () => {
    for (const c of allChallenges()) {
      const row = CATALOG.find((r) => r.id === c.id);
      if (row?.levels.length === 0) continue;
      expect([...c.levels].sort(), c.id).toEqual([...(row?.levels ?? [])].sort());
    }
  });
});

describe('docs/CATALOG.md generator', () => {
  const norm = (s: string) => s.replace(/\r\n/g, '\n');

  it('is deterministic and covers every row, with per-district and overall totals', () => {
    const a = renderCatalog();
    expect(renderCatalog()).toBe(a);
    for (const r of CATALOG) expect(a).toContain(`| ${r.id} |`);
    // Every registered challenge has a catalog row (above), so the total is the registry's size.
    expect(a).toContain(`**Total: ${allChallenges().length}/${CATALOG.length} registered**`);
    expect(allChallenges().length).toBeGreaterThanOrEqual(18);
    expect(a).toContain('## Gatekeeper\n');
    expect(a).not.toContain('\r');
  });

  it('marks registered rows and leaves the rest planned', () => {
    const md = renderCatalog();
    expect(md).toMatch(/\| GK-01 \|.*\| ✅ registered \|/);
    expect(md).toMatch(/\| RM-01 \|.*\| planned \|/);
  });

  it('committed docs/CATALOG.md is current (run `npm run gen:catalog`)', () => {
    const file = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'CATALOG.md');
    expect(norm(readFileSync(file, 'utf8'))).toBe(renderCatalog());
  });
});

describe('release gate (npm run gate:catalog)', () => {
  it('passes at >= 100 registered and fails below, reporting N/122', () => {
    expect(evaluateGate(99)).toEqual({ ok: false, registered: 99, total: 122, message: '99/122 registered' });
    expect(evaluateGate(100).ok).toBe(true);
    expect(evaluateGate(122).message).toBe('122/122 registered');
  });
});
