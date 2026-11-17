// The Docker packaging, checked as text (Docker itself is exercised by `npm run verify:docker`, which needs a
// running engine). docker-compose.hub.yml is for people who only PULL sigmajo/hvwa: it must carry the same
// hardening as docker-compose.yml and an exact copy of docker/proxy/nginx.conf.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EDITIONS } from '../src/editions.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8').replace(/\r\n/g, '\n');
const dockerfile = read('Dockerfile');
const full = read('docker-compose.yml');
const hub = read('docker-compose.hub.yml');
const nginx = read('docker/proxy/nginx.conf');

/** The lines of a top-level service (`  <name>:` up to the next line indented 2 or less), comments dropped. */
function service(yml: string, name: string): string[] {
  const lines = yml.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  if (start < 0) throw new Error(`no service ${name}`);
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !/^ {3,}/.test(line)) break;
    if (/^ {3,7}#/.test(line)) continue; // a YAML comment (block-scalar content is indented 8+)
    out.push(line);
  }
  return out;
}
/** A YAML section from a top-level key to the end of the file (networks:, volumes:). */
const fromKey = (yml: string, key: string) => yml.slice(yml.indexOf(`\n${key}:\n`));
/** Whether `sub` appears in `lines` in order (not necessarily adjacent). */
function inOrder(lines: string[], sub: string[]): string[] {
  const missing: string[] = [];
  let i = 0;
  for (const s of sub) {
    const at = lines.indexOf(s, i);
    if (at < 0) missing.push(s);
    else i = at + 1;
  }
  return missing;
}

describe('Dockerfile', () => {
  it('bakes HVWA_EDITION into the runtime image (ARG full by default -> ENV), validated at build time', () => {
    const runtime = dockerfile.slice(dockerfile.indexOf('FROM ${NODE_IMAGE} AS runtime'));
    expect(runtime).toContain('ARG HVWA_EDITION=full\n');
    expect(runtime).toContain('ENV HVWA_EDITION=${HVWA_EDITION}\n');
    expect(runtime.indexOf('ARG HVWA_EDITION=full')).toBeLessThan(runtime.indexOf('ENV HVWA_EDITION='));
    expect(runtime.indexOf('ENV HVWA_EDITION=')).toBeLessThan(runtime.indexOf('USER node'));
    // Declared after the npm ci layer, so both editions share it.
    expect(runtime.indexOf('RUN npm ci --omit=dev')).toBeLessThan(runtime.indexOf('ARG HVWA_EDITION'));
    const allowed = /case "\$HVWA_EDITION" in ([a-z|]+)\)/.exec(runtime)?.[1].split('|');
    expect(allowed).toEqual([...EDITIONS]);
  });

  it('ships docker-compose.hub.yml in /app (README: docker cp it out of the image); nothing else from the repo', () => {
    const runtime = dockerfile.slice(dockerfile.indexOf('FROM ${NODE_IMAGE} AS runtime'));
    expect(runtime).toContain('\nCOPY docker-compose.hub.yml ./\n');
    expect(runtime.indexOf('COPY docker-compose.hub.yml')).toBeLessThan(runtime.indexOf('USER node')); // root-owned
    const ignore = read('.dockerignore').split('\n');
    expect(ignore).toEqual(expect.arrayContaining(['docker-compose*.yml', '!docker-compose.hub.yml', 'docker', '.env']));
    expect(ignore.indexOf('!docker-compose.hub.yml')).toBeGreaterThan(ignore.indexOf('docker-compose*.yml'));
  });

  it('keeps every hardening line', () => {
    for (const line of [
      'ARG NODE_IMAGE=node:22.23.5-alpine3.24',
      'ENV NODE_ENV=production', // also: the platform login is on in the image
      'RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \\',
      '    /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \\',
      '    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \\',
      '    /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v*',
      'RUN mkdir -p /data && chown node:node /data',
      '    HVWA_ALLOW_REMOTE=1 \\',
      'USER node',
      'CMD ["node", "dist/server.js"]',
    ]) expect(dockerfile.split('\n'), line).toContain(line);
  });
});

describe('docker-compose.yml', () => {
  it('builds the edition from HVWA_EDITION (default full) and passes the login settings through', () => {
    expect(service(full, 'app')).toEqual(expect.arrayContaining([
      '    build:', '      context: .', '        HVWA_EDITION: ${HVWA_EDITION:-full}', '    image: hvwa-app:local',
      '      HVWA_AUTH: ${HVWA_AUTH:-}', '      HVWA_ADMIN_PASSWORD: ${HVWA_ADMIN_PASSWORD:-}',
    ]));
  });
});

describe('docker-compose.hub.yml (pull-only)', () => {
  it('runs the published image sigmajo/hvwa:${HVWA_TAG:-lite} and builds nothing', () => {
    expect(hub).toContain('\n    image: sigmajo/hvwa:${HVWA_TAG:-lite}\n');
    expect(hub).not.toMatch(/^\s*build:/m);
    expect(hub).toContain('\nname: hvwa\n');
  });

  it('the app service is docker-compose.yml\'s, line for line, but for build/image', () => {
    const strip = (lines: string[]) => {
      const out: string[] = [];
      let inBuild = false;
      for (const l of lines) {
        if (l === '    build:' || l.startsWith('    build: ')) { inBuild = l === '    build:'; continue; }
        if (inBuild && /^ {6,}/.test(l)) continue;
        inBuild = false;
        if (l.startsWith('    image: ')) continue;
        out.push(l);
      }
      return out;
    };
    expect(strip(service(hub, 'app'))).toEqual(strip(service(full, 'app')));
  });

  it('the proxy service keeps every line of docker-compose.yml\'s but the nginx.conf bind mount', () => {
    const fullProxy = service(full, 'proxy');
    const mount = fullProxy.indexOf('    volumes:');
    expect(fullProxy[mount + 1]).toBe('      - ./docker/proxy/nginx.conf:/etc/nginx/nginx.conf:ro');
    const expected = fullProxy.filter((_, i) => i !== mount && i !== mount + 1).filter((l) => l.trim() !== '');
    const hubProxy = service(hub, 'proxy');
    expect(inOrder(hubProxy, expected)).toEqual([]);
    expect(hubProxy.some((l) => /^ {4}volumes:/.test(l))).toBe(false); // nothing from the host is mounted
    expect(hubProxy).toContain('      - "127.0.0.1:1337:8080" # loopback ONLY — never 0.0.0.0');
    expect(hub).not.toMatch(/0\.0\.0\.0:/);
  });

  it('the networks (internal lab, isolated gateway) and the data volume are the same', () => {
    expect(fromKey(hub, 'networks')).toBe(fromKey(full, 'networks'));
    expect(fromKey(hub, 'networks')).toContain('    internal: true\n');
    expect(fromKey(hub, 'networks')).toContain('      com.docker.network.bridge.gateway_mode_ipv4: isolated\n');
  });

  it('inlines docker/proxy/nginx.conf verbatim (every $ doubled for compose) and runs nginx on a /tmp copy', () => {
    const lines = hub.split('\n');
    const start = lines.indexOf('      HVWA_NGINX_CONF: |');
    expect(start).toBeGreaterThan(0);
    const block: string[] = [];
    for (const l of lines.slice(start + 1)) {
      if (l !== '' && !l.startsWith('        ')) break;
      block.push(l === '' ? '' : l.slice(8));
    }
    while (block.length > 0 && block[block.length - 1] === '') block.pop();
    const escaped = block.join('\n');
    expect(escaped.replace(/\$\$/g, '')).not.toContain('$'); // no bare $: compose would interpolate it
    expect(`${escaped.replace(/\$\$/g, '$')}\n`).toBe(nginx);
    const command = lines.find((l) => l.startsWith('    command: '));
    expect(command).toBe('    command: ["/bin/sh", "-c", "printf \'%s\' \\"$$HVWA_NGINX_CONF\\" > /tmp/nginx.conf && exec nginx -c /tmp/nginx.conf -g \'daemon off;\'"]');
    // /tmp is the proxy's tmpfs: the rootfs stays read-only.
    expect(service(hub, 'proxy')).toEqual(expect.arrayContaining(['    read_only: true', '      - /tmp:rw,noexec,nosuid,nodev,size=16m']));
  });
});
