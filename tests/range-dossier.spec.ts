// The contract dossier page (src/range/views/lab.ejs): the relayout keeps every hook (range-level-<level>, briefing,
// hint-<tier>, submit-result, flag-submit) and adds the mono contract-file meta line and the tier-card ladder.
import { describe, it, expect } from 'vitest';
import { parseRegistry } from '../src/lab-registry.js';
import { labEntry, player, portalApp } from './support/range.js';

describe('the contract dossier page', () => {
  it('renders the contract-file meta, a tier card per level (name, meaning, points, state) and the flag form', async () => {
    const { app } = portalApp();
    const { agent } = await player(app, 'alice');
    const html = (await agent.get('/labs/r01?level=templar')).text;
    expect(html).toContain('Contract r01 · 4 Tiers · BOUNTY 200');
    for (const [level, points] of [['acolyte', '100'], ['templar', '150'], ['inquisitor', '200']] as const) {
      expect(html).toMatch(new RegExp(`data-testid="range-level-${level}"[^>]*>[\\s\\S]*?${points} `));
    }
    expect(html).toMatch(/data-testid="range-level-templar"[^>]*aria-current="true"/);
    expect(html).toMatch(/data-testid="range-level-templar"[^>]*data-solved="false"/);
    expect(html).toMatch(/class="tier-card is-current" data-level="templar"/);
    expect(html).toContain('class="tier-card-seal"');
    expect(html).toContain('data-testid="briefing"');
    expect(html).toContain('id="flag-submit"');
    expect(html).toContain('class="submit-form claim-form"');
    expect(html).toContain('hx-target="#submit-result"');
    expect(html).toContain('id="submit-result"');
    expect(html).toContain('hx-target="#hint-1"');
  });

  it('uses the hard-only lead for a single-tier lab (the r05 Binanse shape) and renders one tier card', async () => {
    const registry = parseRegistry({
      schema: 1,
      labs: [labEntry('r05', 'binanse', {
        category: 'Stored XSS', difficulty: 'hard', levels: ['inquisitor'], image: `sha256:${'c'.repeat(64)}`, hints: [],
      })],
    });
    const { app } = portalApp({ range: { registry } });
    const { agent } = await player(app, 'alice');
    const html = (await agent.get('/labs/r05')).text;
    expect(html).toContain('Contract r05 · 1 Tier · BOUNTY 600');
    expect(html).toContain('This contract has a single hard tier. There is no secure reference in this lab.');
    expect((html.match(/data-testid="range-level-/g) ?? []).length).toBe(1);
    expect(html).toContain('data-testid="range-level-inquisitor"');
    expect(html).not.toContain('data-testid="range-level-divine"');
  });
});
