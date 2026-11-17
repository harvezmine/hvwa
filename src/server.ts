import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import './districts/index.js'; // registers every challenge; must precede createApp()
import { allChallenges } from './core/registry.js';
import { assertChallengeFiles } from './core/source.js';
import { appOptionsFromConfig, createApp } from './app.js';
import { bindRefusal, loadConfig } from './config.js';
import { listen, closeGracefully, listenUrl, startupBanner } from './lifecycle.js';
import type { Server } from 'node:http';

// Validate the environment: one readable line per problem, then exit 1.
const loaded = loadConfig(process.env);
if (!loaded.ok) {
  console.error('HVWA: invalid configuration:');
  for (const line of loaded.errors) console.error(`  ${line}`);
  process.exit(1);
}
const { config } = loaded;

// Deliberately vulnerable: refuse a non-loopback bind unless explicitly allowed.
const refusal = bindRefusal(config);
if (refusal) {
  console.error(refusal);
  process.exit(1);
}

// HVWA_DATA_DIR, else <project>/data whether running from src/ (tsx) or dist/ (node).
const dataDir = config.HVWA_DATA_DIR
  ? resolve(config.HVWA_DATA_DIR)
  : join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
mkdirSync(dataDir, { recursive: true });

// A wrong challenge dir or a missing level file fails at startup, not on first View Source.
// Every registered challenge is checked, whichever edition is served: they all ship in dist/.
for (const c of allChallenges()) assertChallengeFiles(c);

const app = createApp(appOptionsFromConfig(config, dataDir));
if (config.HVWA_ALLOWED_HOSTS.length > 0) {
  console.warn(`HVWA: also answering to Host ${config.HVWA_ALLOWED_HOSTS.join(', ')} (HVWA_ALLOWED_HOSTS)`);
}

let server: Server;
try {
  server = await listen(app, config.PORT, config.HOST);
} catch (err) {
  const reason = err instanceof Error ? err.message : String(err);
  console.error(`HVWA could not listen on ${listenUrl(config.HOST, config.PORT)}: ${reason}`);
  app.locals.db.close();
  process.exit(1);
}
const served = app.locals.challenges.all().length; // the edition's challenges (HVWA_EDITION)
for (const line of startupBanner(listenUrl(config.HOST, config.PORT), served, { edition: app.locals.edition })) console.log(line);

// Graceful stop: wait for server.close() to finish, then close the DB, then exit.
let stopping = false;
function shutdown(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: shutting down`);
  closeGracefully(server, app.locals.db).then(
    () => process.exit(0),
    (err: unknown) => { console.error('shutdown failed:', err); process.exit(1); },
  );
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
