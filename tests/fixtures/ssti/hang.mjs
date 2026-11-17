// Ready; on a render it reports the player's code started, then spins forever (only the transport's render-phase
// watchdog can stop it).
import { parentPort } from 'node:worker_threads';
parentPort.on('message', (m) => {
  if (m.type !== 'render') return;
  parentPort.postMessage({ type: 'started', id: m.id });
  for (;;) { /* a wedged render */ }
});
parentPort.postMessage({ type: 'ready' });
