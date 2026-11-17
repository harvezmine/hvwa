// Vitest setupFiles entry (vitest.config.ts): runs before each spec file.
// perSession holders live at module level and are shared by every app in a spec file, so the engine's
// default new-instance limit (120/min) would count every session-creating test in the file. Lift the
// default; holders that pass an explicit maxNewPerMinute keep it (the engine's limit tests do).
import { setPerSessionDefaults } from '../../src/core/lab.js';

setPerSessionDefaults({ maxNewPerMinute: Infinity });

// createApp() reads HVWA_EDITION when it gets no `edition` option. Pin the full edition, so a developer's
// shell (HVWA_EDITION=lite) never changes what the suite serves; the edition specs pass `edition` explicitly.
process.env.HVWA_EDITION = 'full';
