// Ready, then answers a render with a result this protocol does not have (ok is not a boolean): the worker goes.
import { parentPort } from 'node:worker_threads';
parentPort.on('message', (m) => {
  if (m.type === 'render') parentPort.postMessage({ type: 'result', id: m.id, result: { ok: 'yes', output: 42 } });
});
parentPort.postMessage({ type: 'ready' });
