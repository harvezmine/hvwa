// Ready, then answers renders past the caps: an output over 16 KiB, then an error over the error cap. The transport
// bounds both (limit 'output', a clipped error) and keeps the worker: a size can never get a worker dropped.
import { parentPort } from 'node:worker_threads';
let n = 0;
parentPort.on('message', (m) => {
  if (m.type !== 'render') return;
  n += 1;
  const result = n % 2 === 1
    ? { ok: true, output: '\uFFFD'.repeat(16 * 1024 + 1), shellCalls: [] }
    : { ok: false, error: '\uFFFD'.repeat(1390), shellCalls: ['x'.repeat(600)] };
  parentPort.postMessage({ type: 'result', id: m.id, result });
});
parentPort.postMessage({ type: 'ready' });
