// Vitest setupFiles entry (vitest.config.ts): runs before each spec file.
// perSession holders live at module level and are shared by every app in a spec file, so the engine's
// default new-instance limit (120/min) would count every session-creating test in the file. Lift the
// default; holders that pass an explicit maxNewPerMinute keep it (the engine's limit tests do).
import { setPerSessionDefaults } from '../../src/core/lab.js';

setPerSessionDefaults({ maxNewPerMinute: Infinity });

// createApp() reads HVWA_EDITION and HVWA_AUTH when it gets no `edition` / `auth` option. Pin the full
// edition and the platform login OFF for every spec, so a developer's shell (HVWA_EDITION=lite, or
// NODE_ENV=production, which turns the login on) never changes what the suite runs. The edition and auth
// specs (tests/edition.spec.ts, tests/auth*.spec.ts) pass `edition` / `auth` explicitly instead.
process.env.HVWA_EDITION = 'full';
process.env.HVWA_AUTH = 'off';
// Standalone unless a spec asks for the portal (createApp({ mode: 'portal' }) in tests/support/range.ts).
process.env.HVWA_MODE = 'standalone';
