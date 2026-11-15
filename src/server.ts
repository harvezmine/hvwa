import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createApp } from './app.js';
import { config } from './config.js';
import { resolveFlagSecret } from './core/secrets.js';

// <project>/data whether running from src/ (tsx) or dist/ (node).
const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
mkdirSync(dataDir, { recursive: true });

const app = createApp({
  dbPath: join(dataDir, 'hvwa.db'),
  flagSecret: resolveFlagSecret(dataDir, config.FLAG_SECRET),
});
app.listen(config.PORT, config.HOST, () => {
  console.log(`HVWA on http://${config.HOST}:${config.PORT} — DO NOT expose to untrusted networks`);
});
