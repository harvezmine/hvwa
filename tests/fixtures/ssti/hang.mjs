// Ready, then spins forever on a render (only the transport's watchdog can stop it).
import { parentPort } from 'node:worker_threads';
parentPort.on('message', () => { for (;;) { /* a wedged render */ } });
parentPort.postMessage({ type: 'ready' });
