// A child process (node --import tsx): one render through the DEFAULT worker transport, printed, and nothing closed.
// The process must still exit by itself: an idle worker is unref'd.
import { renderInSandbox } from '../../../src/core/ssti/sandbox.js';

const r = await renderInSandbox({ template: '{{ 6 * 7 }}' });
process.stdout.write(r.ok ? String(r.output) : `failed: ${String(r.error)}`);
