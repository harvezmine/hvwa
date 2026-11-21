// src/warden/main.ts — the warden process (image sigmajo/hvwa:range-warden-<version>, docker-compose.range.yml). Reads
// its environment, loads the lab registry (the image allowlist), talks to Docker only through the socket proxy, and
// serves its API on the control network. Logs one line per launch and stop; never a flag, never the secret.
import { loadRegistry } from '../lab-registry.js';
import { loadWardenConfig } from './config.js';
import { createDockerClient } from './docker.js';
import { createWardenServer } from './server.js';
import { createWarden } from './warden.js';

const loaded = loadWardenConfig(process.env);
if (!loaded.ok) {
  console.error('warden: invalid configuration:');
  for (const line of loaded.errors) console.error(`  ${line}`);
  process.exit(1);
}
const { config } = loaded;
delete process.env.HVWA_WARDEN_SECRET; // the config holds it now

const registry = loadRegistry(config.registryPath);
const docker = createDockerClient(config.dockerUrl);
try {
  await docker.ping();
} catch (err) {
  console.warn(`warden: the Docker API at ${config.dockerUrl} does not answer yet (${err instanceof Error ? err.message : String(err)})`);
}
const warden = createWarden({
  docker, registry, log: (line) => console.log(line),
  settings: { domain: config.domain, runtime: config.runtime, traefikContainer: config.traefikContainer },
});
const server = createWardenServer({ warden, secret: config.secret }).listen(config.port, config.host, () => {
  console.log(`warden on http://${config.host}:${config.port}: ${registry.labs.length} lab image(s), runtime ${config.runtime}, instances at i-<id>.${config.domain}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
