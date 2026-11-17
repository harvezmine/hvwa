// Fails to load its files, as engine.ts reports it: 'fatal' instead of 'ready'.
import { parentPort } from 'node:worker_threads';
parentPort.postMessage({ type: 'fatal', message: 'could not read the engine files' });
