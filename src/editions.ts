// src/editions.ts — which challenges an edition serves (HVWA_EDITION). Data only: no registry import, so
// config.ts can validate HVWA_EDITION without loading the engine. createApp() turns the ids into the
// ChallengeSet that mounts the labs, lists the portal and scores (core/registry.ts challengeSet()).
//
// THE lite list lives here and nowhere else. The full edition is everything registered. The catalog
// (src/catalog.ts, docs/CATALOG.md, gate:catalog) is a full-edition tool and ignores editions.

export const EDITIONS = Object.freeze(['full', 'lite'] as const);
export type Edition = (typeof EDITIONS)[number];
export const DEFAULT_EDITION: Edition = 'full';

/** The lite edition (the Docker Hub trial image): five beginner labs across three districts. */
export const LITE_CHALLENGE_IDS: readonly string[] = Object.freeze([
  'GK-01', // SQLi login bypass
  'GK-02', // brute force
  'GK-12', // IDOR profile
  'RM-05', // negative quantity
  'SC-01', // reflected XSS
]);

export function isEdition(x: unknown): x is Edition {
  return typeof x === 'string' && (EDITIONS as readonly string[]).includes(x);
}

/** The challenge ids an edition is limited to; undefined = every registered challenge (full). */
export function editionChallengeIds(edition: Edition): readonly string[] | undefined {
  return edition === 'lite' ? LITE_CHALLENGE_IDS : undefined;
}
