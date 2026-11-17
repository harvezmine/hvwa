// Ready; on a render it spins before reporting 'started' (a wedged engine boot: only the boot-phase watchdog stops it).
import { parentPort } from 'node:worker_threads';
parentPort.on('message', (m) => {
  if (m.type === 'render') for (;;) { /* never gets to the player's code */ }
});
parentPort.postMessage({ type: 'ready' });
