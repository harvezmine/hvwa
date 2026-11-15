// Type-level contract for request/locals augmentation. These assertions are
// enforced by `npm run typecheck` (tsconfig.test.json); at runtime they no-op.
import { describe, it, expectTypeOf } from 'vitest';
import type { Request, Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.js';
import type { Level } from '../src/core/levels.js';
import type { Lang } from '../src/core/i18n.js';
import type { Challenge } from '../src/core/registry.js';

describe('typed express', () => {
  it('Request carries sessionId, level and lang', () => {
    expectTypeOf<Request['sessionId']>().toEqualTypeOf<string>();
    expectTypeOf<Request['level']>().toEqualTypeOf<Level>();
    expectTypeOf<Request['lang']>().toEqualTypeOf<Lang>();
  });

  it('res.locals carries lang, t, and the optional level/challenge', () => {
    expectTypeOf<Response['locals']['lang']>().toEqualTypeOf<Lang>();
    expectTypeOf<Response['locals']['t']>().toEqualTypeOf<(key: string) => string>();
    expectTypeOf<Response['locals']['level']>().toEqualTypeOf<Level | undefined>();
    expectTypeOf<Response['locals']['challenge']>().toEqualTypeOf<Challenge | undefined>();
  });

  it('createApp().locals.db is a DatabaseSync', () => {
    expectTypeOf(createApp().locals.db).toEqualTypeOf<DatabaseSync>();
  });
});
