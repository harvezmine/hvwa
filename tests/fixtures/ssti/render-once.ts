// A child process (node --import tsx): one render through the DEFAULT worker transport, then a render and a stats
// query on a second transport, printed, and nothing closed. The process must still get every answer (a pending
// render or stats reply keeps it up) and then exit by itself (an idle worker is unref'd).
import { renderInSandbox, toJob, workerTransport } from '../../../src/core/ssti/sandbox.js';
import type { SandboxJob } from '../../../src/core/ssti/engine.js';

const r = await renderInSandbox({ template: '{{ 6 * 7 }}' });
const t = workerTransport();
await t.render(toJob({ template: '{{ 1 }}' }) as SandboxJob);
const s = await t.stats();
process.stdout.write(r.ok ? `${String(r.output)} ${String(s.worker?.renders)}` : `failed: ${String(r.error)}`);
