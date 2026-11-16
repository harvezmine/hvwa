// Ready, then answers a render with a result over the output cap (the transport re-checks every bound).
import { parentPort } from 'node:worker_threads';
parentPort.on('message', (m) => {
  if (m.type === 'render') parentPort.postMessage({ type: 'result', id: m.id, result: { ok: true, output: 'x'.repeat(16 * 1024 + 1), shellCalls: [] } });
});
parentPort.postMessage({ type: 'ready' });
