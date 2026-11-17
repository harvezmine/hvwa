// Ready, then answers every render with what this worker was started with: its environment, flags, V8 limits and
// workerData (the transport must pass no environment and no flags).
import { parentPort, resourceLimits, workerData } from 'node:worker_threads';
parentPort.on('message', (m) => {
  if (m.type !== 'render') return;
  const output = JSON.stringify({ env: Object.keys(process.env), execArgv: process.execArgv, resourceLimits, workerData });
  parentPort.postMessage({ type: 'result', id: m.id, result: { ok: true, output, shellCalls: [] } });
});
parentPort.postMessage({ type: 'ready' });
