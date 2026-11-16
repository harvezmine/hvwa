// Ready, then dies on the first render.
import { parentPort } from 'node:worker_threads';
parentPort.on('message', () => { process.exit(3); });
parentPort.postMessage({ type: 'ready' });
