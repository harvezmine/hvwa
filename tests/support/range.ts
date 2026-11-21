// tests/support/range.ts — the range test kit: lab registry entries (and, from the portal-mode tasks on, a portal-mode
// app on a fake clock with accounts and signed-in browsers).
import { parseRegistry, type LabRegistry } from '../../src/lab-registry.js';

/** One registry entry as labs/registry.json holds it: a valid default, overridden per test. */
export function labEntry(id: string, slug: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, slug,
    title: { en: `${slug} title`, id: `judul ${slug}` },
    app: `App ${slug}`,
    category: 'SQL injection',
    difficulty: 'easy',
    levels: ['acolyte', 'templar', 'inquisitor', 'divine'],
    port: 8080,
    health: '/healthz',
    flag: { placement: 'file:/tmp/hvwa/flag.txt' },
    needsBot: false,
    themeId: `theme-${slug}`,
    scenario: { en: `Scenario of ${slug}`, id: `Skenario ${slug}` },
    briefing: { en: `Briefing of ${slug}`, id: `Briefing ${slug}` },
    hints: [{ id: 1, cost: 10, text: { en: `Hint one of ${slug}`, id: `Petunjuk satu ${slug}` } }],
    version: '1.0.0',
    image: `sigmajo/hvwa:lab-${slug}-1.0.0@sha256:${'a'.repeat(64)}`,
    ...over,
  };
}

/** Two labs: r01 (Easy, all four levels, one hint) and r02 (Medium, Acolyte and Divine, a local image id). */
export function testRegistry(): LabRegistry {
  return parseRegistry({
    schema: 1,
    labs: [
      labEntry('r01', 'clinic'),
      labEntry('r02', 'courier', {
        category: 'Broken access control', difficulty: 'medium', levels: ['acolyte', 'divine'],
        image: `sha256:${'b'.repeat(64)}`, hints: [],
      }),
    ],
  });
}
